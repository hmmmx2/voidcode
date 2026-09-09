/**
 * The contract between main and the execution sandbox.
 *
 * Kept in its own module with no Electron or Pyodide imports, so both sides — and
 * the tests — can depend on it without dragging a runtime along.
 */

export interface ExecCase {
  id: string;
  /** Positional args, JSON-serialisable. */
  args: unknown[];
  kwargs?: Record<string, unknown>;
}

export interface ExecRequest {
  runId: string;
  source: string;
  /** The function the exercise expects, e.g. `sigmoid`. */
  entry: string;
  cases: ExecCase[];
  /**
   * Package roots user code may import. Enforced by an import hook in the sandbox.
   *
   * A pedagogical constraint, not a security boundary — see `runtime/bootstrap.py`.
   * The boundary is Pyodide's WASM sandbox, which has no sockets and no host
   * filesystem regardless of what gets imported.
   */
  allowedImports: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  /**
   * A Python expression in `_r`, applied to every return value before comparison.
   *
   * Applied to the reference and the learner identically, which is the only reason it is
   * safe: it is part of *how answers are compared*, not part of either answer. Rounding
   * one side and not the other would be an answer key that disagrees with itself.
   *
   * It exists because the web ran these through Judge0 with a per-problem driver that
   * printed `[round(x, 6) for x in _r]` or `[sorted(side) for side in _r]` before anything
   * was compared. Calling the entry point directly threw that away, and with it the
   * problem's own statement of what counts as equal — a learner returning `3` where the
   * reference returns `3.0`, or the same set in a different order, would have been failed
   * for being right.
   *
   * Absent for the curriculum problems, which need only the global normalisation.
   */
  normalise?: string;
}

export interface ExecCaseResult {
  id: string;
  ok: boolean;
  /** Normalised `repr` of the return value; absent when the call raised. */
  repr?: string;
  error?: string;
  traceback?: string;
  elapsedMs: number;
}

/**
 * Why a run ended.
 *
 * `timeout` and `crashed` are distinguished because they mean different things to a
 * learner: one is "your algorithm is too slow or looping", the other is "the sandbox
 * died and that is our problem, not yours".
 */
export type ExecOutcome =
  | "ran"
  | "compile_or_import"
  | "missing_entry"
  | "timeout"
  | "memory_exceeded"
  | "crashed"
  /**
   * The user stopped it.
   *
   * Its own outcome rather than reusing "crashed", because everything downstream treats a
   * crash as a fact about the code: the console says "Runtime Error", and the handler files
   * a submission recording that the learner failed. Neither is true of a run someone chose
   * to end, and a permanent wrong-answer row for pressing Stop is not a verdict anyone can
   * appeal.
   */
  | "cancelled";

export interface ExecMeasurements {
  /** Wall clock for the whole run, host-side. Includes sandbox handoff. */
  wallMs: number;
  /** Slowest single case. This is what a per-case time limit applies to. */
  slowestCaseMs: number;
  /** Peak CPython allocator use, from tracemalloc. */
  pythonPeakBytes: number;
  /**
   * Total Pyodide WASM linear memory after the run.
   *
   * Includes the interpreter and numpy themselves, so it is not "the user's memory
   * use" — it is an upper bound that catches allocations tracemalloc misses. numpy
   * allocates large buffers through malloc rather than the CPython allocator, so
   * tracemalloc alone would under-report an exercise that builds a huge array.
   * Both numbers are reported because neither alone is honest.
   */
  wasmHeapBytes: number;
  /** WASM growth attributable to this run, from a post-warmup baseline. */
  wasmGrowthBytes: number;
}

export interface ExecResult {
  runId: string;
  outcome: ExecOutcome;
  cases: ExecCaseResult[];
  stdout: string;
  error?: string;
  traceback?: string;
  measurements: ExecMeasurements;
  /** Which declared limit was breached, if any. */
  limitBreached?: "time" | "memory";
}

/** Messages the sandbox process accepts. */
export type SandboxCommand =
  | { kind: "run"; request: ExecRequest }
  | { kind: "ping" };

/** Messages the sandbox process emits. */
export type SandboxEvent =
  | { kind: "ready"; coreLoadMs: number }
  | { kind: "result"; result: ExecResult }
  | { kind: "pong" }
  | { kind: "fatal"; message: string };

export const MB = 1024 * 1024;
