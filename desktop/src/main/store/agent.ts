/**
 * What the agent did, kept after the window is gone.
 *
 * The point is accountability rather than convenience. An agent run reads files, may fetch web
 * pages, and proposes changes to a repository — and "what did it actually do?" is a question
 * most likely to be asked *later*, once something looks wrong, which is precisely when an
 * in-memory transcript has been thrown away.
 *
 * Steps are written **as they happen**, not in one batch at the end. A run that crashes, is
 * killed, or dies with its window is exactly the run worth reading back, and a transcript
 * assembled only on success records nothing about the cases that matter. That is why
 * `finish_reason` is nullable: a run with steps and no ending is a true statement about what
 * happened, and inventing a "stop" for it would be a false one.
 */
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";
import { parseStoredPlan, PLAN_VERSION, type PlanDoc, type StoredPlan } from "../../shared/plan.js";
import {
  parseStoredDesignSpec,
  DESIGN_SPEC_VERSION,
  type DesignSpec,
  type StoredDesignSpec,
} from "../../shared/design.js";

export interface AgentRunRow {
  id: string;
  question: string;
  provider: string;
  model: string;
  finishReason: string | null;
  createdAt: string;
  stepCount: number;
}

export interface AgentStepRow {
  seq: number;
  kind: "thought" | "tool" | "proposal" | "error" | "command" | "applied";
  toolName: string | null;
  diffId: string | null;
  text: string;
}

/**
 * How much of a step's text is kept.
 *
 * A `list_files` result on a real project is tens of kilobytes, and a run can hold twenty-four
 * of them. Storing all of it would make the database grow faster than everything else in the
 * app put together, for text nobody reads in full — the audit question is "what did it look
 * at", not "what were the bytes".
 */
const MAX_STEP_TEXT = 4_000;

export function beginRun(input: {
  projectRoot: string;
  question: string;
  provider: string;
  model: string;
  /**
   * The conversation this run belongs to, when there is one.
   *
   * Null is a real and permanent case, not a gap to fill later: a run started before the
   * assistant had sessions has none, and neither does one whose session row has since been
   * deleted -- the foreign key is `ON DELETE SET NULL` precisely so the audit record of what
   * the agent did to someone's files outlives the chat that prompted it.
   */
  sessionId?: string | null;
}): string {
  const id = randomUUID();
  openDatabase()
    .prepare(
      `INSERT INTO agent_runs (id, project_root, question, provider, model, session_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.projectRoot,
      input.question,
      input.provider,
      input.model,
      input.sessionId ?? null
    );
  return id;
}

export function recordStep(
  runId: string,
  seq: number,
  step: { kind: string; text: string; toolName?: string | undefined; diffId?: string | undefined }
): void {
  const text =
    step.text.length > MAX_STEP_TEXT
      ? `${step.text.slice(0, MAX_STEP_TEXT)}\n[truncated]`
      : step.text;

  openDatabase()
    .prepare(
      `INSERT INTO agent_steps (run_id, seq, kind, tool_name, diff_id, text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(runId, seq, step.kind, step.toolName ?? null, step.diffId ?? null, text);
}

/**
 * Save the plan a run wrote, replacing any earlier one.
 *
 * Serialised with its version beside it, following `window_workspace.state`. The reader is
 * `parseStoredPlan`, which returns null for a version it does not know rather than interpreting
 * an unfamiliar shape — so an old build reading a new plan shows no plan, instead of showing a
 * wrong one.
 */
export function recordPlan(runId: string, doc: PlanDoc): void {
  const stored: StoredPlan = { version: PLAN_VERSION, doc };
  openDatabase()
    .prepare(
      `INSERT INTO agent_plans (run_id, state) VALUES (?, ?)
         ON CONFLICT (run_id) DO UPDATE SET state = excluded.state,
                                            updated_at = datetime('now')`
    )
    .run(runId, JSON.stringify(stored));
}

/**
 * Read back a run's plan, or nothing.
 *
 * Null covers four cases that are all the same to a caller: the run wrote no plan, the run
 * belongs to a different project, the row is from a version this build does not read, and the
 * JSON is unparseable. None is recoverable by the panel, and distinguishing them would only
 * give it four ways to render the same emptiness.
 *
 * Scoped by project root, in the query rather than after it — the rule `stepsFor` follows, and
 * for the same reason. A window holding one repository must not be able to read back what the
 * agent planned in another by naming its run. Run ids are uuids, and unguessable is not an
 * access control.
 */
export function planForRun(projectRoot: string, runId: string): PlanDoc | null {
  const row = openDatabase()
    .prepare(
      `SELECT p.state
         FROM agent_plans p
         JOIN agent_runs r ON r.id = p.run_id
        WHERE p.run_id = ? AND r.project_root = ?`
    )
    .get(runId, projectRoot) as { state?: unknown } | undefined;
  if (typeof row?.state !== "string") return null;

  try {
    return parseStoredPlan(JSON.parse(row.state));
  } catch {
    return null;
  }
}

/** Save the design spec a run wrote, replacing any earlier one. Mirrors `recordPlan`. */
export function recordDesign(runId: string, doc: DesignSpec): void {
  const stored: StoredDesignSpec = { version: DESIGN_SPEC_VERSION, doc };
  openDatabase()
    .prepare(
      `INSERT INTO agent_designs (run_id, state) VALUES (?, ?)
         ON CONFLICT (run_id) DO UPDATE SET state = excluded.state,
                                            updated_at = datetime('now')`
    )
    .run(runId, JSON.stringify(stored));
}

/**
 * Read back a run's design spec, or nothing.
 *
 * Scoped by project root in the query, following `stepsFor` and `planForRun`: a window holding
 * one repository must not read back what the agent designed in another by naming its run.
 */
export function designForRun(projectRoot: string, runId: string): DesignSpec | null {
  const row = openDatabase()
    .prepare(
      `SELECT d.state
         FROM agent_designs d
         JOIN agent_runs r ON r.id = d.run_id
        WHERE d.run_id = ? AND r.project_root = ?`
    )
    .get(runId, projectRoot) as { state?: unknown } | undefined;
  if (typeof row?.state !== "string") return null;

  try {
    return parseStoredDesignSpec(JSON.parse(row.state));
  } catch {
    return null;
  }
}

export function finishRun(runId: string, finishReason: string | null): void {
  openDatabase()
    .prepare(`UPDATE agent_runs SET finish_reason = ? WHERE id = ?`)
    .run(finishReason, runId);
}

/**
 * Recent runs for one project, newest first.
 *
 * Scoped by project root rather than global: a run is about a repository, and showing someone
 * the agent's history from a different codebase is noise at best and confusing at worst.
 */
export function recentRuns(projectRoot: string, limit = 20): AgentRunRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT r.id, r.question, r.provider, r.model, r.finish_reason, r.created_at,
              (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS step_count
         FROM agent_runs r
        WHERE r.project_root = ?
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT ?`
    )
    .all(projectRoot, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    provider: String(row.provider),
    model: String(row.model),
    finishReason: row.finish_reason === null ? null : String(row.finish_reason),
    createdAt: String(row.created_at),
    stepCount: Number(row.step_count),
  }));
}

/**
 * One run's steps, in order.
 *
 * Takes the project root as well as the id and checks it, so a window cannot read back a run
 * belonging to a project it does not currently have open. Ids are uuids, but "unguessable" is
 * not an access control — the same argument `diffs.ts` makes about diff ownership.
 */
export function stepsFor(projectRoot: string, runId: string): AgentStepRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT s.seq, s.kind, s.tool_name, s.diff_id, s.text
         FROM agent_steps s
         JOIN agent_runs r ON r.id = s.run_id
        WHERE s.run_id = ? AND r.project_root = ?
        ORDER BY s.seq`
    )
    .all(runId, projectRoot) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    seq: Number(row.seq),
    kind: String(row.kind) as AgentStepRow["kind"],
    toolName: row.tool_name === null ? null : String(row.tool_name),
    diffId: row.diff_id === null ? null : String(row.diff_id),
    text: String(row.text),
  }));
}
