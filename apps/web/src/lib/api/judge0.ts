/**
 * Judge0 Execution API Client
 *
 * All calls go through the FastAPI backend at /v1/execute and /v1/submit.
 * Never calls Judge0 directly from the browser.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ──────────────────────────────────────────────────────

export interface ExecutionResult {
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  statusId: number;
  statusDescription: string;
  time: string | null;
  memory: number | null;
  exitCode: number | null;
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
}

export interface SubmissionResult {
  totalTests: number;
  passedTests: number;
  allPassed: boolean;
  testCaseResults: TestCaseResult[];
  overallTime: string | null;
  overallMemory: number | null;
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
  };
}

// ── API Functions ──────────────────────────────────────────────

/**
 * Execute code (Run button) — single run with optional stdin.
 */
export async function executeCode(payload: {
  sourceCode: string;
  languageId: number;
  stdin?: string;
  userId?: string;
}): Promise<ExecutionResult> {
  const response = await fetch(`${API_BASE}/v1/execute`, {
    method: "POST",
    headers: makeHeaders(payload.userId),
    body: JSON.stringify({
      source_code: payload.sourceCode,
      language_id: payload.languageId,
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
  languageId: number;
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
      language_id: payload.languageId,
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
    })),
    overallTime: data.overall_time,
    overallMemory: data.overall_memory,
  };
}
