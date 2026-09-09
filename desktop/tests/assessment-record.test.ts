/**
 * Keeping the verdict the assessor produces.
 *
 * It was computed and thrown away: the row held only the *self*-rating, so the app's record of
 * how someone was doing was entirely self-reported, and the one independent read on an answer
 * lived as long as the panel was open.
 *
 * Two distinctions carry the weight here, and both are easy to collapse by accident. **Null is
 * not `unknown`** — never assessed and "the model was asked and declined to grade" are different
 * facts, and only the second says anything about the model. And **the verdict is overwritten**
 * where `submitted_at` is not, because it describes the current answer rather than the first one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { __useInMemory, openDatabase, __runMigrationsForTest } = await import(
  "../src/main/store/db.js"
);
const { getAttempt, allAttempts, saveAttempt, recordAssessment, markSubmitted, InvalidVerdictError } =
  await import("../src/main/store/interviews.js");
const { VERDICTS, isVerdict } = await import("../src/main/content/verdict.js");

const SLUG = "implement-auc";

beforeEach(() => {
  __useInMemory();
});

describe("recordAssessment", () => {
  it("stores the verdict and the model that produced it", () => {
    const attempt = recordAssessment(SLUG, "partial", "qwen3:8b");
    expect(attempt.assessedVerdict).toBe("partial");
    expect(attempt.assessedModel).toBe("qwen3:8b");
    expect(attempt.assessedAt).not.toBeNull();
    expect(getAttempt(SLUG)?.assessedVerdict).toBe("partial");
  });

  it("creates the row, because asking to be marked is doing something", () => {
    // "Attempted" is the existence of the row, and nothing else here had created one.
    expect(getAttempt(SLUG)).toBeUndefined();
    recordAssessment(SLUG, "correct", "m");
    expect(getAttempt(SLUG)).toBeDefined();
  });

  it("overwrites, unlike submitted_at", () => {
    /**
     * The verdict describes the *current* answer. Keeping the first would leave a `correct`
     * standing over text since rewritten badly — which is the one reading of this column that
     * would actively mislead.
     */
    recordAssessment(SLUG, "correct", "m1");
    markSubmitted(SLUG);
    const first = getAttempt(SLUG)?.submittedAt;

    recordAssessment(SLUG, "incorrect", "m2");
    const after = getAttempt(SLUG);

    expect(after?.assessedVerdict).toBe("incorrect");
    expect(after?.assessedModel).toBe("m2");
    // And the first-submit time is untouched by it.
    expect(after?.submittedAt).toBe(first);
  });

  it("keeps a too-short verdict with no model attributed", () => {
    // Decided locally, before any model is contacted. Stored rather than skipped: a
    // resubmission too short to grade must replace an earlier verdict.
    recordAssessment(SLUG, "correct", "m");
    const attempt = recordAssessment(SLUG, "too_short", null);
    expect(attempt.assessedVerdict).toBe("too_short");
    expect(attempt.assessedModel).toBeNull();
  });

  it("distinguishes never-assessed from unknown", () => {
    // The distinction the whole column turns on. `unknown` means the model was asked and
    // coached instead of grading — a true statement about the model. Null means nobody asked.
    saveAttempt(SLUG, { notes: "some notes" });
    expect(getAttempt(SLUG)?.assessedVerdict).toBeNull();

    recordAssessment(SLUG, "unknown", "m");
    expect(getAttempt(SLUG)?.assessedVerdict).toBe("unknown");
  });

  it("does not disturb the other columns", () => {
    // Its own writer for the reason markRevealed is: a save that omits a verdict must not
    // clear one, and recording a verdict must not clear a rating.
    saveAttempt(SLUG, { selfRating: 3, notes: "n", elapsedSeconds: 90 });
    recordAssessment(SLUG, "partial", "m");

    const attempt = getAttempt(SLUG);
    expect(attempt?.selfRating).toBe(3);
    expect(attempt?.notes).toBe("n");
    expect(attempt?.elapsedSeconds).toBe(90);

    // And the reverse: a later save leaves the verdict alone.
    saveAttempt(SLUG, { selfRating: 1 });
    expect(getAttempt(SLUG)?.assessedVerdict).toBe("partial");
  });

  it("comes back from allAttempts too", () => {
    // The list endpoint reads through this, not through getAttempt.
    recordAssessment(SLUG, "correct", "m");
    expect(allAttempts().get(SLUG)?.assessedVerdict).toBe("correct");
  });

  it("accepts every verdict in the vocabulary", () => {
    for (const verdict of VERDICTS) {
      expect(() => recordAssessment(SLUG, verdict, "m")).not.toThrow();
      expect(getAttempt(SLUG)?.assessedVerdict).toBe(verdict);
    }
  });

  it("refuses a verdict outside the vocabulary", () => {
    /**
     * The column has no CHECK constraint — deliberately, because widening one costs a table
     * rebuild here (migration 12). This throw is therefore the only thing between a typo and a
     * stored value nothing can interpret.
     *
     * Thrown rather than coerced to `unknown`, which already means something specific.
     */
    for (const bad of ["Correct", "pass", "", "null", "ok"]) {
      expect(() => recordAssessment(SLUG, bad as never, "m"), bad).toThrow(InvalidVerdictError);
    }
    expect(getAttempt(SLUG)).toBeUndefined();
  });

  it("reads an uninterpretable stored value back as never-assessed", () => {
    // Possible from an older build or a hand-edited file, since nothing in SQL forbids it. A
    // bad value cast straight to Verdict would reach the UI as a badge with no matching style,
    // which reads as a rendering glitch rather than as bad data.
    recordAssessment(SLUG, "correct", "m");
    openDatabase().prepare(`UPDATE interview_attempts SET assessed_verdict = ?`).run("brilliant");
    expect(getAttempt(SLUG)?.assessedVerdict).toBeNull();
  });
});

describe("the verdict vocabulary", () => {
  it("is one declaration serving both the type and the check", () => {
    // Two hand-maintained copies is the arrangement agent-event-parity.test.ts polices
    // elsewhere; this list is small enough that one declaration removes the need.
    expect(VERDICTS).toContain("unknown");
    expect(VERDICTS).toContain("too_short");
    for (const verdict of VERDICTS) expect(isVerdict(verdict)).toBe(true);
  });

  it("rejects what is not a verdict, including the shapes a JSON column holds", () => {
    for (const value of [null, undefined, 3, {}, [], "", "CORRECT"]) {
      expect(isVerdict(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("migration 15", () => {
  it("adds the columns to a database that predates them", () => {
    /**
     * The case a fresh-schema test cannot reach.
     *
     * `openDatabase` runs the full SCHEMA before migrations, so an in-memory database already
     * has the columns and the step is a no-op against it — the seam's own docstring says
     * running it against SCHEMA "proves nothing". This builds the *old* table shape and runs
     * the real migration over it, rather than a copy of its statements that could drift.
     */
    const db = openDatabase();
    db.exec(`DROP TABLE interview_attempts`);
    db.exec(`
      CREATE TABLE interview_attempts (
        slug            TEXT PRIMARY KEY,
        self_rating     INTEGER,
        notes           TEXT,
        revealed_answer INTEGER NOT NULL DEFAULT 0,
        submitted_at    TEXT,
        elapsed_seconds INTEGER,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    db.prepare(`INSERT INTO interview_attempts (slug, self_rating) VALUES (?, 2)`).run(SLUG);

    __runMigrationsForTest(db, 14);

    // The existing row survives with its rating, and reads back as never-assessed rather than
    // as an error.
    const attempt = getAttempt(SLUG);
    expect(attempt?.selfRating).toBe(2);
    expect(attempt?.assessedVerdict).toBeNull();
    expect(attempt?.assessedModel).toBeNull();

    // And the new column is writable on the migrated table.
    recordAssessment(SLUG, "correct", "m");
    expect(getAttempt(SLUG)?.assessedVerdict).toBe("correct");
  });

  it("does nothing when the table is not there", () => {
    /**
     * The case that broke `store.test.ts`, which was the first sign of it.
     *
     * The runner is handed whatever shape a database is in, and those tests build minimal
     * databases holding only the tables a given step needs — none has `interview_attempts`.
     * `PRAGMA table_info` on a missing table returns empty rather than throwing, so an
     * unguarded step falls through to "no such table" and takes the whole ladder with it.
     */
    const db = openDatabase();
    db.exec(`DROP TABLE interview_attempts`);
    expect(() => __runMigrationsForTest(db, 7)).not.toThrow();
  });
});
