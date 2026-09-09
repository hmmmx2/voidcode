/**
 * Reads and writes for submissions, drafts and progress.
 *
 * Deliberately the only module that writes SQL. Callers pass and receive plain
 * objects, so the storage choice stays swappable and the SQL stays reviewable in one
 * place rather than scattered through handlers.
 */
import { openDatabase } from "./db.js";
import type { Grade } from "../exec/grader.js";

export interface SubmissionRow {
  id: number;
  problemId: string;
  solved: boolean;
  outcome: string;
  passedCount: number;
  totalCount: number;
  slowestMs: number;
  submittedAt: string;
  /** Peak Python heap for the run, in bytes. */
  pythonPeak: number;
  /**
   * The code that was submitted.
   *
   * Stored since the first migration and never selected, so "load this submission back into
   * the editor" had nothing to load. The history is only useful if you can return to it.
   */
  source: string;
}

export interface ProblemProgress {
  problemId: string;
  solved: boolean;
  attemptCount: number;
  firstSolvedAt: string | null;
}

/**
 * Record a graded run and update progress.
 *
 * Wrapped in a transaction so a crash between the two writes cannot leave progress
 * claiming a solve that has no submission behind it. `solved` in `progress` is
 * derived from `first_solved_at`, so it can only ever be set by a run that actually
 * passed — there is no separate boolean to get out of step.
 */
export function recordSubmission(
  source: string,
  grade: Grade
): SubmissionRow & { firstSolve: boolean } {
  const db = openDatabase();
  const passed = grade.verdicts.filter((v) => v.passed).length;

  db.exec("BEGIN");
  try {
    /**
     * Was this the run that solved it, or a re-solve?
     *
     * Read inside the transaction and before the upsert below, because that upsert is what
     * sets `first_solved_at` — asking afterwards always says "already solved" and the answer
     * would be worthless.
     *
     * This is what the notification is keyed on. A notification per submission duplicated
     * the verdict already on screen and the Submission History tab beside it; a first solve
     * is the one thing that happens once and is worth a line in a log.
     */
    const prior = db
      .prepare("SELECT first_solved_at FROM progress WHERE problem_id = ?")
      .get(grade.problemId) as { first_solved_at?: string | null } | undefined;
    const firstSolve = grade.solved && (prior?.first_solved_at ?? null) === null;

    const insert = db.prepare(`
      INSERT INTO submissions
        (problem_id, source, solved, outcome, passed_count, total_count, slowest_ms, python_peak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      grade.problemId,
      source,
      grade.solved ? 1 : 0,
      grade.outcome,
      passed,
      grade.verdicts.length,
      grade.measurements.slowestCaseMs,
      grade.measurements.pythonPeakBytes
    );

    // `first_solved_at` is only ever set, never cleared: a later failed attempt does
    // not un-solve a problem, because the fact that you once solved it is true.
    db.prepare(`
      INSERT INTO progress (problem_id, attempt_count, first_solved_at, last_seen_at)
      VALUES (?, 1, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT (problem_id) DO UPDATE SET
        attempt_count   = attempt_count + 1,
        first_solved_at = COALESCE(first_solved_at,
                            CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END),
        last_seen_at    = datetime('now')
    `).run(grade.problemId, grade.solved ? 1 : 0, grade.solved ? 1 : 0);

    db.exec("COMMIT");

    const row = db
      .prepare(
        `SELECT id, problem_id, solved, outcome, passed_count, total_count,
                slowest_ms, submitted_at
           FROM submissions WHERE id = ?`
      )
      .get(result.lastInsertRowid) as Record<string, unknown>;

    return { ...toSubmissionRow(row), firstSolve };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function recentSubmissions(problemId: string, limit = 20): SubmissionRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, problem_id, solved, outcome, passed_count, total_count,
              slowest_ms, python_peak, source, submitted_at
         FROM submissions
        WHERE problem_id = ?
        ORDER BY submitted_at DESC, id DESC
        LIMIT ?`
    )
    .all(problemId, limit) as Record<string, unknown>[];

  return rows.map(toSubmissionRow);
}

export function saveDraft(problemId: string, source: string): void {
  openDatabase()
    .prepare(
      `INSERT INTO drafts (problem_id, source, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (problem_id) DO UPDATE SET
         source = excluded.source, updated_at = datetime('now')`
    )
    .run(problemId, source);
}

/** `undefined` when nothing has been typed yet, so a caller can fall back to the template. */
export function loadDraft(problemId: string): string | undefined {
  const row = openDatabase()
    .prepare("SELECT source FROM drafts WHERE problem_id = ?")
    .get(problemId) as { source?: string } | undefined;
  return row?.source;
}

export function allProgress(): ProblemProgress[] {
  const rows = openDatabase()
    .prepare("SELECT problem_id, first_solved_at, attempt_count FROM progress")
    .all() as Record<string, unknown>[];

  return rows.map((r) => ({
    problemId: r.problem_id as string,
    // Derived, not stored: there is no boolean that can disagree with the timestamp.
    solved: r.first_solved_at !== null,
    attemptCount: r.attempt_count as number,
    firstSolvedAt: (r.first_solved_at as string | null) ?? null,
  }));
}

function toSubmissionRow(row: Record<string, unknown>): SubmissionRow {
  return {
    id: row.id as number,
    problemId: row.problem_id as string,
    // SQLite has no boolean type; the column is a 0/1 INTEGER with a CHECK constraint.
    solved: row.solved === 1,
    outcome: row.outcome as string,
    passedCount: row.passed_count as number,
    totalCount: row.total_count as number,
    slowestMs: row.slowest_ms as number,
    pythonPeak: row.python_peak as number,
    source: row.source as string,
    submittedAt: row.submitted_at as string,
  };
}
