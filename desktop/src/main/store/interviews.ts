/**
 * Per-question interview state: the self-rating, the notes, and the two facts that
 * must not be taken on trust.
 *
 * A row exists only once the user has done something, because "attempted" is the
 * existence of the row. Every writer here therefore upserts rather than requiring a
 * create step, and nothing creates a row speculatively — a page view that inserted
 * one would inflate the progress ring with questions nobody answered.
 */
import { openDatabase } from "./db.js";
import { VERDICTS, isVerdict, type Verdict } from "../content/verdict.js";

export interface InterviewAttempt {
  slug: string;
  /** 1 = could not answer, 2 = shaky, 3 = solid. Null until self-rated. */
  selfRating: number | null;
  notes: string | null;
  revealedAnswer: boolean;
  /** Time of the *first* submit. Never overwritten. */
  submittedAt: string | null;
  elapsedSeconds: number | null;
  /**
   * The last verdict the assessor produced, and what produced it.
   *
   * Null means never assessed — distinct from `unknown`, which means the model was asked and
   * declined to grade. Conflating them would make "we have no read on this" and "the model
   * coached instead of marking" the same fact, and only the second says anything about the model.
   *
   * The feedback prose is deliberately absent. See the column comment in `db.ts`.
   */
  assessedVerdict: Verdict | null;
  /** Null for `too_short`, which is decided locally and never reaches a model. */
  assessedModel: string | null;
  assessedAt: string | null;
}

export class InvalidRatingError extends Error {
  constructor(value: unknown) {
    super(`self rating must be 1, 2 or 3 (got ${String(value)})`);
    this.name = "InvalidRatingError";
  }
}

/**
 * The verdict column has no CHECK constraint, so this is the only thing standing between a
 * typo and a stored value nothing can interpret.
 *
 * Thrown rather than coerced. A verdict that is not in the vocabulary is a bug in the caller,
 * and writing it as `unknown` would hide that bug behind a value that already means something
 * specific — that the model was asked and did not grade.
 */
export class InvalidVerdictError extends Error {
  constructor(value: unknown) {
    super(`verdict must be one of ${VERDICTS.join(", ")} (got ${String(value)})`);
    this.name = "InvalidVerdictError";
  }
}

export function getAttempt(slug: string): InterviewAttempt | undefined {
  const row = openDatabase()
    .prepare(
      `SELECT slug, self_rating, notes, revealed_answer, submitted_at, elapsed_seconds,
              assessed_verdict, assessed_model, assessed_at
         FROM interview_attempts WHERE slug = ?`
    )
    .get(slug) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toAttempt(row);
}

/**
 * Every attempt, keyed by slug.
 *
 * One query rather than one per question: the list endpoint needs all 38 and the table
 * is bounded by the size of the bank, so there is nothing to paginate.
 */
export function allAttempts(): Map<string, InterviewAttempt> {
  const rows = openDatabase()
    .prepare(
      `SELECT slug, self_rating, notes, revealed_answer, submitted_at, elapsed_seconds,
              assessed_verdict, assessed_model, assessed_at
         FROM interview_attempts`
    )
    .all() as Record<string, unknown>[];

  return new Map(rows.map((r) => [r.slug as string, toAttempt(r)]));
}

/**
 * Save a rating, notes, or elapsed time — whichever were supplied.
 *
 * `undefined` means "not sent" and leaves the column alone; `null` means "clear it".
 * The two are different because rating and notes are written by different interactions,
 * and a request that only saved notes must not blank a rating by omission. This mirrors
 * the server's `exclude_unset`, where getting it wrong would have been silent.
 *
 * `COALESCE(?, column)` is deliberately *not* how this is done — that cannot express
 * "set to null", so clearing a rating would be impossible. The SQL is built from the
 * keys actually present instead.
 */
export function saveAttempt(
  slug: string,
  // `exactOptionalPropertyTypes` is on, so the `| undefined` is written out rather than
  // implied by `?`. It is exactly the distinction this function turns on: absent leaves
  // the column alone, null clears it.
  patch: {
    selfRating?: number | null | undefined;
    notes?: string | null | undefined;
    elapsedSeconds?: number | undefined;
  }
): InterviewAttempt {
  if (patch.selfRating !== undefined && patch.selfRating !== null) {
    if (!Number.isInteger(patch.selfRating) || patch.selfRating < 1 || patch.selfRating > 3) {
      throw new InvalidRatingError(patch.selfRating);
    }
  }

  const columns: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.selfRating !== undefined) {
    columns.push("self_rating");
    values.push(patch.selfRating);
  }
  if (patch.notes !== undefined) {
    columns.push("notes");
    values.push(patch.notes);
  }
  if (patch.elapsedSeconds !== undefined) {
    // Bounded the way the server bounded it: a negative elapsed time is always a bug,
    // and 24h catches a clock skew or a tab left open over a weekend before it becomes
    // a stored number nobody can explain.
    const seconds = Math.min(Math.max(Math.trunc(patch.elapsedSeconds), 0), 86_400);
    columns.push("elapsed_seconds");
    values.push(seconds);
  }

  const db = openDatabase();

  if (columns.length === 0) {
    // Nothing to write, but the row must still exist: an empty PUT is how the client
    // records "opened this" and it is the only thing that makes `attempted` true.
    db.prepare(
      `INSERT INTO interview_attempts (slug) VALUES (?) ON CONFLICT (slug) DO NOTHING`
    ).run(slug);
  } else {
    const assignments = columns.map((c) => `${c} = excluded.${c}`).join(", ");
    db.prepare(
      `INSERT INTO interview_attempts (slug, ${columns.join(", ")}, updated_at)
       VALUES (?, ${columns.map(() => "?").join(", ")}, datetime('now'))
       ON CONFLICT (slug) DO UPDATE SET ${assignments}, updated_at = datetime('now')`
    ).run(slug, ...values);
  }

  // Non-null: the upsert above guarantees a row.
  return getAttempt(slug) as InterviewAttempt;
}

/**
 * Record what the assessor said.
 *
 * Its own function rather than a field on `saveAttempt`'s patch, for the reason `markRevealed`
 * and `markSubmitted` are: the three writers here are driven by different interactions, and a
 * save that happened to omit a verdict must not clear one.
 *
 * **The row is upserted, so an assessment creates it.** Asking to be marked is doing something,
 * and "attempted" is the existence of the row.
 *
 * The verdict is overwritten on every assessment, deliberately — unlike `submitted_at`, which is
 * the *first* submit. This is the current read on the current answer, and keeping the first one
 * would leave a stale `correct` standing over an answer since rewritten badly.
 */
export function recordAssessment(
  slug: string,
  verdict: Verdict,
  model: string | null
): InterviewAttempt {
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new InvalidVerdictError(verdict);

  openDatabase()
    .prepare(
      `INSERT INTO interview_attempts (slug, assessed_verdict, assessed_model, assessed_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (slug) DO UPDATE SET
         assessed_verdict = excluded.assessed_verdict,
         assessed_model = excluded.assessed_model,
         assessed_at = excluded.assessed_at,
         updated_at = datetime('now')`
    )
    .run(slug, verdict, model);

  return getAttempt(slug) as InterviewAttempt;
}

/**
 * Record that the answer was looked at.
 *
 * Sticky, and creating a row if there is none. Both matter: "looked at the answer" is
 * recorded even for someone who never rates themselves — exactly the case a progress
 * number would otherwise flatter — and a later write that omits the flag must not
 * clear it, which is why this is its own statement rather than a field in the patch.
 */
export function markRevealed(slug: string): InterviewAttempt {
  openDatabase()
    .prepare(
      `INSERT INTO interview_attempts (slug, revealed_answer, updated_at)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT (slug) DO UPDATE SET revealed_answer = 1, updated_at = datetime('now')`
    )
    .run(slug);
  return getAttempt(slug) as InterviewAttempt;
}

/**
 * Record the first submit, which is what unlocks the tutor.
 *
 * `submitted_at` is never overwritten: it is the time of the *first* submit, which is
 * what the timer is measuring against. Idempotent, so the client may call it after
 * every submit without keeping track.
 *
 * The caller is responsible for having checked that a real submission exists — see the
 * route. This function stores a fact; it does not establish one.
 */
export function markSubmitted(slug: string): InterviewAttempt {
  openDatabase()
    .prepare(
      `INSERT INTO interview_attempts (slug, submitted_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))
       ON CONFLICT (slug) DO UPDATE SET
         submitted_at = COALESCE(interview_attempts.submitted_at, datetime('now')),
         updated_at = datetime('now')`
    )
    .run(slug);
  return getAttempt(slug) as InterviewAttempt;
}

function toAttempt(row: Record<string, unknown>): InterviewAttempt {
  return {
    slug: row.slug as string,
    selfRating: (row.self_rating as number | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    // SQLite has no boolean type; the column is a 0/1 INTEGER with a CHECK constraint.
    revealedAnswer: row.revealed_answer === 1,
    submittedAt: (row.submitted_at as string | null) ?? null,
    elapsedSeconds: (row.elapsed_seconds as number | null) ?? null,
    /**
     * Validated on the way out, not merely cast.
     *
     * The column has no CHECK, so a value written by an older build, a hand-edited database, or
     * a bug is possible — and a bad one cast straight to `Verdict` would flow into the UI as a
     * badge with no matching style, which is the kind of wrong that looks like a rendering
     * glitch. Reading it back as "never assessed" is the honest answer to a value this build
     * cannot interpret.
     */
    assessedVerdict: isVerdict(row.assessed_verdict) ? row.assessed_verdict : null,
    assessedModel: (row.assessed_model as string | null) ?? null,
    assessedAt: (row.assessed_at as string | null) ?? null,
  };
}
