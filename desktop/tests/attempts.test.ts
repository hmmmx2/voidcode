/**
 * Stopping a run.
 *
 * The interesting case is not "cancel kills the run" — it is that a grade is TWO sandbox runs
 * (the reference that derives the answer key, then the learner's code) and cancelling has to
 * mean both. The naive fix, cancelling whatever the sandbox is currently doing, passes a
 * casual test and still lets the user press Stop during the reference phase and watch the run
 * carry on into the second one.
 *
 * `host.js` is mocked so these are about the attempt layer's decisions, not about Pyodide.
 * The real sandbox is covered by sandbox-runtime.test.ts and the smoke.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cancelCurrentRun = vi.fn();

vi.mock("../src/main/exec/host.js", () => ({
  cancelCurrentRun,
  runInSandbox: vi.fn(),
}));

const { beginAttempt, endAttempt, cancelAttempt, attemptCancelled, __clearAttempts } =
  await import("../src/main/exec/attempts.js");

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  __clearAttempts();
  cancelCurrentRun.mockClear();
});

describe("cancelling an attempt", () => {
  it("stops the sandbox and reports that it did", () => {
    beginAttempt(ID);
    expect(cancelAttempt(ID)).toBe(true);
    expect(cancelCurrentRun).toHaveBeenCalledOnce();
  });

  it("marks the attempt, so a grade between phases can see it", () => {
    // This flag is the whole point. Killing the pending run settles one promise; the grade
    // then decides whether to start the next phase, and only this tells it not to.
    beginAttempt(ID);
    expect(attemptCancelled(ID)).toBe(false);
    cancelAttempt(ID);
    expect(attemptCancelled(ID)).toBe(true);
  });

  it("marks before it kills", () => {
    // `cancelCurrentRun` settles the pending promise synchronously, so a grade awaiting it
    // can resume inside that call. If the flag were set afterwards it would already be past
    // the check and into the next phase.
    beginAttempt(ID);
    cancelCurrentRun.mockImplementationOnce(() => {
      expect(attemptCancelled(ID)).toBe(true);
    });
    cancelAttempt(ID);
    expect(cancelCurrentRun).toHaveBeenCalledOnce();
  });
});

describe("stale and unknown ids", () => {
  it("does nothing for an attempt that already finished", () => {
    // The race every Stop button has: the run ends while the click is in flight. Answering
    // `false` is honest, and — more importantly — it must not touch the sandbox, which by
    // then may be running something else.
    beginAttempt(ID);
    endAttempt(ID);

    expect(cancelAttempt(ID)).toBe(false);
    expect(cancelCurrentRun).not.toHaveBeenCalled();
  });

  it("does not let one attempt cancel another", () => {
    // This is the guard the old runId provided, moved up a level. Without it, a late Stop
    // for a finished run kills the run that replaced it.
    beginAttempt(ID);
    expect(cancelAttempt(OTHER)).toBe(false);
    expect(cancelCurrentRun).not.toHaveBeenCalled();
    expect(attemptCancelled(ID)).toBe(false);
  });

  it("treats a missing id as not cancelled rather than throwing", () => {
    // Internal callers (verify-curriculum, the smoke) grade with no attempt at all.
    expect(attemptCancelled(undefined)).toBe(false);
    expect(attemptCancelled("not-registered")).toBe(false);
  });

  it("forgets the flag when the id is released", () => {
    // Ids are random, but a registry that kept cancelled entries would grow for the life of
    // the process — and `attemptCancelled` would answer for runs that ended long ago.
    beginAttempt(ID);
    cancelAttempt(ID);
    endAttempt(ID);
    expect(attemptCancelled(ID)).toBe(false);

    beginAttempt(ID);
    expect(attemptCancelled(ID)).toBe(false);
  });
});
