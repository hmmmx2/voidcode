/**
 * Cancelling a grade, at the seam where it is actually hard.
 *
 * `gradeSubmission` runs the sandbox twice: once for the reference, to derive the answer key,
 * and once for the learner's code. The user pressing Stop means "end the thing I am waiting
 * on", which is the whole operation — not whichever of the two happens to be executing.
 *
 * The test that matters is the first one. Cancel during the reference phase, and assert the
 * learner's code is never run. A implementation that simply kills the pending sandbox job
 * passes every other test in this file and fails that one, because killing the reference run
 * just lets the grade fall through to the next phase.
 *
 * `runInSandbox` is mocked. This is about control flow, not Pyodide.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Problem } from "../src/main/content/problems.js";
import type { ExecRequest, ExecResult } from "../src/main/exec/protocol.js";

const runInSandbox = vi.fn<(request: ExecRequest) => Promise<ExecResult>>();
const cancelCurrentRun = vi.fn();

vi.mock("../src/main/exec/host.js", () => ({ runInSandbox, cancelCurrentRun }));

const { gradeSubmission, __clearKeyCache } = await import("../src/main/exec/grader.js");
const { beginAttempt, endAttempt, cancelAttempt, __clearAttempts } = await import(
  "../src/main/exec/attempts.js"
);

const ID = "33333333-3333-4333-8333-333333333333";

/**
 * A problem with a distinct reference and template, so the mock can tell which phase it is
 * being asked for by looking at the source it was handed.
 */
const PROBLEM = {
  id: "cancel-fixture",
  title: "Cancel fixture",
  entry: "solve",
  reference: "def solve(x):\n    return x\n",
  template: "def solve(x):\n    ...\n",
  cases: [{ id: "c1", label: "one", args: [1], hidden: false }],
  allowedImports: [],
  timeLimitMs: 1_000,
  memoryLimitMb: 64,
} as unknown as Problem;

const LEARNER = "def solve(x):\n    return x + 0\n";

function ok(request: ExecRequest, repr: string): ExecResult {
  return {
    runId: request.runId,
    outcome: "ran",
    cases: request.cases.map((c) => ({ id: c.id, ok: true, repr, elapsedMs: 1 })),
    stdout: "",
    measurements: {
      wallMs: 1,
      slowestCaseMs: 1,
      pythonPeakBytes: 0,
      wasmHeapBytes: 0,
      wasmGrowthBytes: 0,
    },
  } as ExecResult;
}

/** Which phase a call is: the reference source, or the learner's. */
const isReference = (request: ExecRequest): boolean => request.source === PROBLEM.reference;

beforeEach(() => {
  __clearKeyCache();
  __clearAttempts();
  runInSandbox.mockReset();
  cancelCurrentRun.mockClear();
});

describe("stopping during the reference phase", () => {
  it("does not go on to run the learner's code", async () => {
    // THE TEST. The reference and the learner's code are separate sandbox jobs, so ending
    // the first one leaves the second free to start — Stop pressed, run continues, nothing
    // reporting a fault.
    runInSandbox.mockImplementation(async (request) => {
      if (isReference(request)) {
        cancelAttempt(ID); // the user presses Stop while the key is being derived
        return ok(request, "1");
      }
      return ok(request, "1");
    });

    beginAttempt(ID);
    const grade = await gradeSubmission(PROBLEM, LEARNER, ID);
    endAttempt(ID);

    expect(runInSandbox).toHaveBeenCalledOnce();
    expect(runInSandbox.mock.calls.every(([r]) => isReference(r))).toBe(true);
    expect(grade.outcome).toBe("cancelled");
  });

  it("reaches no verdict at all", async () => {
    // Empty, not "every case failed". Nothing was compared, so there is nothing to report,
    // and a list of failures would be a judgement on code that never ran.
    runInSandbox.mockImplementation(async (request) => {
      if (isReference(request)) cancelAttempt(ID);
      return ok(request, "1");
    });

    beginAttempt(ID);
    const grade = await gradeSubmission(PROBLEM, LEARNER, ID);
    endAttempt(ID);

    expect(grade.verdicts).toEqual([]);
    expect(grade.solved).toBe(false);
  });
});

describe("stopping during the learner's run", () => {
  it("reports cancelled rather than scoring the empty result", async () => {
    // The sandbox resolves a cancelled run with no cases. Scoring that verbatim marks every
    // case failed — a wrong answer for code that was interrupted.
    runInSandbox.mockImplementation(async (request) => {
      if (isReference(request)) return ok(request, "1");
      return {
        runId: request.runId,
        outcome: "cancelled",
        cases: [],
        stdout: "",
        error: "Cancelled",
        measurements: {
          wallMs: 5,
          slowestCaseMs: 0,
          pythonPeakBytes: 0,
          wasmHeapBytes: 0,
          wasmGrowthBytes: 0,
        },
      } as ExecResult;
    });

    beginAttempt(ID);
    const grade = await gradeSubmission(PROBLEM, LEARNER, ID);
    endAttempt(ID);

    expect(runInSandbox).toHaveBeenCalledTimes(2);
    expect(grade.outcome).toBe("cancelled");
    expect(grade.verdicts).toEqual([]);
  });
});

describe("grading that was not stopped", () => {
  it("runs both phases and scores normally", async () => {
    // The guard must not fire on its own. A cancellation check that always trips would make
    // every run report "Stopped", which is a much louder failure than the bug it fixes —
    // but only if something asserts the happy path still works.
    runInSandbox.mockImplementation(async (request) => ok(request, "1"));

    beginAttempt(ID);
    const grade = await gradeSubmission(PROBLEM, LEARNER, ID);
    endAttempt(ID);

    expect(runInSandbox).toHaveBeenCalledTimes(2);
    expect(grade.outcome).toBe("ran");
    expect(grade.solved).toBe(true);
    expect(grade.verdicts).toHaveLength(1);
  });

  it("grades with no attempt id at all", async () => {
    // verify-curriculum and the smoke grade in bulk with nobody watching. An unstoppable run
    // is still a valid run.
    runInSandbox.mockImplementation(async (request) => ok(request, "1"));

    const grade = await gradeSubmission(PROBLEM, LEARNER);

    expect(grade.outcome).toBe("ran");
    expect(grade.solved).toBe(true);
  });

  it("is unaffected by a cancel for someone else's attempt", async () => {
    runInSandbox.mockImplementation(async (request) => {
      if (isReference(request)) cancelAttempt("44444444-4444-4444-8444-444444444444");
      return ok(request, "1");
    });

    beginAttempt(ID);
    const grade = await gradeSubmission(PROBLEM, LEARNER, ID);
    endAttempt(ID);

    expect(grade.outcome).toBe("ran");
  });
});
