/**
 * Grading: derive the answer key by executing the reference, then compare.
 *
 * The rule (spec §2.6) is that no expected output is ever written down by hand. A
 * value typed into a content file is a guess that looks like a fact, and it stays
 * wrong until a learner is failed by it and does not know why. So the key is computed
 * from `problem.reference` in the same sandbox, with the same normalisation, as the
 * learner's code — which also means a change to how values are normalised cannot make
 * the key and the answers disagree.
 */
import { randomUUID } from "node:crypto";
import { runInSandbox } from "./host.js";
import { attemptCancelled } from "./attempts.js";
import type { Problem } from "../content/problems.js";
import type { ExecResult, ExecCaseResult } from "./protocol.js";

export interface CaseVerdict {
  id: string;
  label: string;
  visible: boolean;
  passed: boolean;
  /** Only ever populated for a visible case. */
  expected?: string;
  actual?: string;
  error?: string;
  elapsedMs: number;
}

export interface Grade {
  problemId: string;
  /** True only if every case passed, hidden ones included. */
  solved: boolean;
  outcome: ExecResult["outcome"];
  verdicts: CaseVerdict[];
  stdout: string;
  error?: string;
  traceback?: string;
  limitBreached?: "time" | "memory";
  measurements: ExecResult["measurements"];
  /**
   * The budget this run was graded against.
   *
   * Carried with the result so the payload is self-describing: a timing of 3ms means nothing
   * without the 200ms it was allowed. The UI would otherwise have to join the verdict against
   * the problem detail to render a bar, and the two could disagree.
   */
  limits: { timeLimitMs: number; memoryLimitMb: number };
  /** Set when the reference itself failed. Our bug, and never the learner's fault. */
  referenceBroken?: string;
}

/**
 * Derived keys, per problem id.
 *
 * Safe to keep for the process lifetime because references are static content. If
 * problems ever become user-editable this needs a version key — noting it here so the
 * assumption is visible rather than buried.
 */
const keyCache = new Map<string, string[]>();

async function answerKey(problem: Problem): Promise<{ key: string[] } | { broken: string }> {
  const cached = keyCache.get(problem.id);
  if (cached !== undefined) return { key: cached };

  const result = await runInSandbox({
    runId: randomUUID(),
    source: problem.reference,
    entry: problem.entry,
    cases: problem.cases.map((c) => ({ id: c.id, args: c.args })),
    allowedImports: problem.allowedImports,
    // Same expression on both runs. If these ever diverged the answer key would be
    // normalised differently from the answer, which is a grader that disagrees with itself.
    ...(problem.normalise !== undefined ? { normalise: problem.normalise } : {}),
    // The reference gets a generous budget. It is not being judged on speed, and
    // failing it on the learner's limit would turn a tight limit into a broken
    // exercise rather than a hard one.
    timeLimitMs: Math.max(problem.timeLimitMs * 10, 5_000),
    memoryLimitMb: Math.max(problem.memoryLimitMb * 4, 256),
  });

  if (result.outcome !== "ran" || result.cases.some((c) => !c.ok)) {
    const detail =
      result.error ?? result.cases.find((c) => !c.ok)?.error ?? `outcome=${result.outcome}`;
    return { broken: `reference for "${problem.id}" failed: ${detail}` };
  }

  const key = result.cases.map((c) => c.repr ?? "");
  keyCache.set(problem.id, key);
  return { key };
}

/**
 * The derived answer key, for callers that need to *display* expectations rather than
 * grade against them — the workspace's test console.
 *
 * Returns undefined when the reference itself is broken, so a caller shows nothing rather
 * than a fabricated value.
 */
/**
 * The derived key **only if it is already cached**. Never executes.
 *
 * For callers that would like the reference's output but must not pay for a sandbox run to
 * get it. The dashboard is the case this exists for: `runInSandbox` allows one run at a time
 * and a second supersedes the first, so a list view that quietly executed a reference could
 * cancel a learner's in-flight submission. Viewing a page must never contend with running
 * code.
 *
 * Returns undefined until something that legitimately executes — opening the problem — has
 * warmed the cache.
 */
export function cachedKeyFor(problem: { id: string }): string[] | undefined {
  return keyCache.get(problem.id);
}

export async function derivedKeyFor(problem: Problem): Promise<string[] | undefined> {
  const result = await answerKey(problem);
  return "broken" in result ? undefined : result.key;
}

/**
 * The key, or why there isn't one.
 *
 * `derivedKeyFor` returns `undefined` for every kind of failure, which is all a caller
 * rendering a page needs. A porting gate needs the sentence — "reference did not execute"
 * is not something anyone can act on, and it was the only thing the interview verifier
 * could report until this existed.
 */
export async function derivedKeyOrReason(
  problem: Problem
): Promise<{ key: string[] } | { broken: string }> {
  return answerKey(problem);
}

/**
 * A grade that ran nothing and judges nothing.
 *
 * `solved: false` here does not mean "wrong" — `outcome` is what carries the meaning, and the
 * caller must not file this as a submission. Verdicts are empty because none were reached.
 */
function cancelledGrade(problem: Problem): Grade {
  return {
    problemId: problem.id,
    solved: false,
    outcome: "cancelled",
    verdicts: [],
    stdout: "",
    error: "Stopped",
    measurements: emptyMeasurements(),
    limits: { timeLimitMs: problem.timeLimitMs, memoryLimitMb: problem.memoryLimitMb },
  };
}

/**
 * `attemptId` is optional, and every internal caller omits it.
 *
 * Only a user-initiated run is stoppable. `verify-curriculum.ts` and the smoke grade in bulk
 * with nobody watching, and threading a cancellation token through them would be ceremony
 * around a thing that cannot happen.
 */
export async function gradeSubmission(
  problem: Problem,
  source: string,
  attemptId?: string
): Promise<Grade> {
  const derived = await answerKey(problem);

  /**
   * Checked here, between the two sandbox runs, and this check is the entire reason attempts
   * exist as a concept.
   *
   * Cancelling during the reference run settles that run and nothing more. Without this, the
   * next line would start the learner's code against a key that was just abandoned — Stop
   * pressed, run continues, no error anywhere.
   */
  if (attemptCancelled(attemptId)) return cancelledGrade(problem);

  if ("broken" in derived) {
    // Loud, and explicitly not a verdict on the learner. Silently marking their
    // correct answer wrong because our own reference is broken is the worst failure
    // this module could have.
    console.error(`[grade] ${derived.broken}`);
    const empty = await Promise.resolve(emptyMeasurements());
    return {
      problemId: problem.id,
      solved: false,
      outcome: "crashed",
      verdicts: [],
      stdout: "",
      referenceBroken: derived.broken,
      measurements: empty,
      limits: { timeLimitMs: problem.timeLimitMs, memoryLimitMb: problem.memoryLimitMb },
    };
  }

  const result = await runInSandbox({
    runId: randomUUID(),
    source,
    entry: problem.entry,
    cases: problem.cases.map((c) => ({ id: c.id, args: c.args })),
    // From the problem, never from the caller.
    allowedImports: problem.allowedImports,
    ...(problem.normalise !== undefined ? { normalise: problem.normalise } : {}),
    timeLimitMs: problem.timeLimitMs,
    memoryLimitMb: problem.memoryLimitMb,
  });

  // The learner's run was cancelled mid-flight. `runInSandbox` already resolved with the
  // cancelled outcome, but the cases it carries are empty — scoring them would report every
  // case failed, which is a verdict on code that never finished running.
  if (result.outcome === "cancelled" || attemptCancelled(attemptId)) {
    return cancelledGrade(problem);
  }

  const byId = new Map<string, ExecCaseResult>(result.cases.map((c) => [c.id, c]));

  const verdicts: CaseVerdict[] = problem.cases.map((problemCase, index) => {
    const expected = derived.key[index] ?? "";
    const actual = byId.get(problemCase.id);
    const passed = actual?.ok === true && actual.repr === expected;

    return {
      id: problemCase.id,
      label: problemCase.label,
      visible: problemCase.visible,
      passed,
      elapsedMs: actual?.elapsedMs ?? 0,
      // A hidden case reports pass or fail and nothing else. Leaking `expected` here
      // would hand over the answer key one failing submission at a time.
      ...(problemCase.visible
        ? {
            expected,
            ...(actual?.repr !== undefined ? { actual: actual.repr } : {}),
            ...(actual?.error !== undefined ? { error: actual.error } : {}),
          }
        : {}),
    };
  });

  return {
    problemId: problem.id,
    // A run that did not reach `ran` cannot be solved even if no case explicitly
    // failed — a timeout produces no case results at all.
    solved: result.outcome === "ran" && verdicts.every((v) => v.passed),
    outcome: result.outcome,
    verdicts,
    stdout: result.stdout,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.traceback !== undefined ? { traceback: result.traceback } : {}),
    ...(result.limitBreached !== undefined ? { limitBreached: result.limitBreached } : {}),
    measurements: result.measurements,
    limits: { timeLimitMs: problem.timeLimitMs, memoryLimitMb: problem.memoryLimitMb },
  };
}

function emptyMeasurements(): ExecResult["measurements"] {
  return {
    wallMs: 0,
    slowestCaseMs: 0,
    pythonPeakBytes: 0,
    wasmHeapBytes: 0,
    wasmGrowthBytes: 0,
  };
}

/** Test seam: forget derived keys so a test can re-derive them. */
export function __clearKeyCache(): void {
  keyCache.clear();
}
