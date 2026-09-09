/**
 * The grading client.
 *
 * It was called `judge0.ts`, and its header said "All calls go through the FastAPI backend at
 * /v1/execute and /v1/submit. Never calls Judge0 directly from the browser." Neither half is true
 * any more, and the *name* was the worse half: a reader looking for how submissions are graded found
 * a file promising a remote service.
 *
 * There is no Judge0 and no FastAPI. `API_BASE` is the `app://api` marker, `installTransport`
 * intercepts these paths, and grading runs in a Pyodide sandbox inside an Electron utilityProcess
 * (`exec/sandbox.ts`) with an enforced import allowlist and real time and memory limits. No token, no
 * language-id table, no network.
 *
 * The paths stay `/v1/execute` and `/v1/submit` on purpose — that is the seam `client.ts` documents,
 * and callers were never meant to move.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ──────────────────────────────────────────────────────

/** One visible case, as Run actually evaluated it. */
export interface ExecutionCase {
  label: string;
  passed: boolean;
  expected: string | null;
  actual: string | null;
  error: string | null;
  elapsedMs: number;
}

export interface ExecutionResult {
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  statusId: number;
  statusDescription: string;
  time: string | null;
  memory: number | null;
  exitCode: number | null;
  /**
   * What the code produced for each visible case.
   *
   * The Judge0 fields above are a stdout-and-stderr view of a process, which is all the web
   * backend could report. On the desktop the same call *grades* — it invokes the function on
   * every case and compares the result — so it already knows what the code returned and what
   * it should have. That was being computed and thrown away, and a solution that defines a
   * function and prints nothing showed "No output produced".
   */
  cases: ExecutionCase[];
}

export interface TestCaseResult {
  testCaseId: string;
  /** Server-supplied display name, e.g. "Case 1" or "Hidden 1". */
  label: string;
  isHidden: boolean;
  passed: boolean;
  executionResult: ExecutionResult;
  /**
   * `null` for hidden cases — the server redacts the expected answer, the
   * program's stdout and its stderr before responding, so the browser never
   * holds them. That redaction is the actual security control; anything the
   * UI does with these fields is presentation.
   */
  expectedOutput: string | null;
  actualOutput: string | null;
  /** This case's own elapsed time. Real, measured in the sandbox. */
  elapsedMs: number;
}

export interface SubmissionResult {
  totalTests: number;
  passedTests: number;
  allPassed: boolean;
  testCaseResults: TestCaseResult[];
  overallTime: string | null;
  overallMemory: number | null;
  /** The slowest single case, and the budget it was allowed. */
  slowestCaseMs: number;
  timeLimitMs: number;
}

/** Discriminated union for execution UI state */
export type ExecutionState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success"; result: ExecutionResult }
  | { status: "error"; error: string };

/** Discriminated union for submission UI state */
export type SubmissionState =
  | { status: "idle" }
  | { status: "running"; progress: { current: number; total: number } }
  | { status: "success"; result: SubmissionResult }
  | { status: "error"; error: string };

// ── Helper: parse snake_case execution result from API ─────────

function parseExecutionResult(data: Record<string, unknown>): ExecutionResult {
  return {
    stdout: data.stdout as string | null,
    stderr: data.stderr as string | null,
    compileOutput: data.compile_output as string | null,
    statusId: data.status_id as number,
    statusDescription: data.status_description as string,
    time: data.time as string | null,
    memory: data.memory as number | null,
    exitCode: data.exit_code as number | null,
    cases: ((data.cases as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
      label: c.label as string,
      passed: c.passed as boolean,
      expected: (c.expected as string | null | undefined) ?? null,
      actual: (c.actual as string | null | undefined) ?? null,
      error: (c.error as string | null | undefined) ?? null,
      elapsedMs: (c.elapsed_ms as number | undefined) ?? 0,
    })),
  };
}

// ── API Functions ──────────────────────────────────────────────

/**
 * Execute code (Run button) — single run against the problem's first visible case.
 *
 * **`problemId` is required, and adding it is a bug fix rather than a tidy-up.** This was the
 * web's Judge0 signature, where `/v1/execute` was a bare "run this source with this stdin"
 * endpoint that needed no problem. On the desktop the same path is Pyodide grading in main,
 * and `exec:run` cannot run anything without knowing what to run it against.
 *
 * The seam papered over the gap with `problemId: b.problem_id ?? ""`, and the channel's schema
 * is `z.string().min(1)` — so every Run came back `Invalid payload for exec:run`. The button
 * had never worked on the desktop. `submitCode` below already carried the id, which is why
 * Submit did.
 */
export async function executeCode(payload: {
  sourceCode: string;
  problemId: string;
  stdin?: string;
  userId?: string;
}): Promise<ExecutionResult> {
  const response = await fetch(`${API_BASE}/v1/execute`, {
    method: "POST",
    headers: makeHeaders(payload.userId),
    body: JSON.stringify({
      source_code: payload.sourceCode,
      problem_id: payload.problemId,
      stdin: payload.stdin ?? null,
    }),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(error.detail || `Execution failed (${response.status})`);
  }

  const data = await response.json();
  return parseExecutionResult(data);
}

/**
 * Submit code (Submit button) — runs against all test cases.
 */
export async function submitCode(payload: {
  sourceCode: string;
  /**
   * Required. The only grading input the client supplies — the server loads the
   * test cases, their stdin and their expected outputs itself.
   *
   * This used to take a `testCases` array carrying `expectedOutput` per case,
   * and the server graded against those values, so anyone who could open
   * DevTools could mark themselves correct. Do not add it back: the server now
   * rejects an unrecognised field outright, so a reintroduced `test_cases` is a
   * 422 rather than a silent regression.
   */
  problemId: string;
  language?: string;
  userId?: string;
}): Promise<SubmissionResult> {
  const response = await fetch(`${API_BASE}/v1/submit`, {
    method: "POST",
    headers: makeHeaders(payload.userId),
    body: JSON.stringify({
      source_code: payload.sourceCode,
      problem_id: payload.problemId,
      language: payload.language ?? null,
    }),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(error.detail || `Submission failed (${response.status})`);
  }

  const data = await response.json();

  return {
    totalTests: data.total_tests,
    passedTests: data.passed_tests,
    allPassed: data.all_passed,
    testCaseResults: (
      data.test_case_results as Array<Record<string, unknown>>
    ).map((r) => ({
      testCaseId: r.test_case_id as string,
      label: (r.label as string) ?? "",
      isHidden: (r.is_hidden as boolean) ?? false,
      passed: r.passed as boolean,
      executionResult: parseExecutionResult(
        r.execution_result as Record<string, unknown>
      ),
      expectedOutput: (r.expected_output as string | null) ?? null,
      actualOutput: r.actual_output as string | null,
      elapsedMs: (r.elapsed_ms as number) ?? 0,
    })),
    overallTime: data.overall_time,
    overallMemory: data.overall_memory,
    slowestCaseMs: (data.slowest_case_ms as number) ?? 0,
    timeLimitMs: (data.time_limit_ms as number) ?? 0,
  };
}
