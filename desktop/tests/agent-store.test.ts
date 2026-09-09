/**
 * The agent's transcript, after the fact.
 *
 * The property worth having is not "runs are listed" but **a run that did not finish is still
 * readable**. That is the run someone comes back for: the one that crashed, was killed, or died
 * with its window. A transcript written in one batch at the end records only the successes,
 * which is the opposite of an audit trail.
 *
 * The second property is scoping. A run belongs to a repository, and a window holding a
 * different project must not be able to read it back by id — uuids are unguessable, and
 * "unguessable" is not an access control.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const { beginRun, recordStep, finishRun, recentRuns, stepsFor } = await import(
  "../src/main/store/agent.js"
);

const ROOT = "/projects/alpha";
const OTHER = "/projects/beta";

beforeEach(() => {
  __useInMemory();
});

describe("recording a run", () => {
  it("keeps the steps of a run that never finished", () => {
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordStep(id, 0, { kind: "thought", text: "looking" });
    recordStep(id, 1, { kind: "tool", text: "found it", toolName: "read_file" });
    // No finishRun — the window died.

    const [run] = recentRuns(ROOT);
    expect(run).toMatchObject({ question: "q", stepCount: 2 });
    // Null rather than an invented "stop": the run genuinely has no ending.
    expect(run?.finishReason).toBeNull();
    expect(stepsFor(ROOT, id).map((s) => s.kind)).toEqual(["thought", "tool"]);
  });

  it("records the ending when there is one", () => {
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    finishRun(id, "stop");
    expect(recentRuns(ROOT)[0]?.finishReason).toBe("stop");
  });

  it("returns steps in the order they happened", () => {
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    // Written out of order to prove `seq` is what orders them, not insertion.
    recordStep(id, 2, { kind: "error", text: "third" });
    recordStep(id, 0, { kind: "thought", text: "first" });
    recordStep(id, 1, { kind: "tool", text: "second", toolName: "read_file" });

    expect(stepsFor(ROOT, id).map((s) => s.text)).toEqual(["first", "second", "third"]);
  });

  it("keeps the tool name and diff id a step carried", () => {
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordStep(id, 0, { kind: "proposal", text: "proposed", diffId: "d-1" });
    recordStep(id, 1, { kind: "tool", text: "read", toolName: "read_file" });

    const steps = stepsFor(ROOT, id);
    expect(steps[0]).toMatchObject({ kind: "proposal", diffId: "d-1", toolName: null });
    expect(steps[1]).toMatchObject({ kind: "tool", toolName: "read_file", diffId: null });
  });

  it("truncates an enormous step rather than storing all of it", () => {
    // A list_files result on a real project is tens of kilobytes, and a run can hold
    // twenty-four of them.
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordStep(id, 0, { kind: "tool", text: "x".repeat(200_000), toolName: "list_files" });

    const [step] = stepsFor(ROOT, id);
    expect(step!.text.length).toBeLessThan(10_000);
    expect(step!.text).toContain("[truncated]");
  });
});

describe("scoping", () => {
  it("lists only the open project's runs", () => {
    beginRun({ projectRoot: ROOT, question: "mine", provider: "ollama", model: "m" });
    beginRun({ projectRoot: OTHER, question: "theirs", provider: "ollama", model: "m" });

    expect(recentRuns(ROOT).map((r) => r.question)).toEqual(["mine"]);
    expect(recentRuns(OTHER).map((r) => r.question)).toEqual(["theirs"]);
  });

  it("refuses to hand another project's steps to this one", () => {
    const id = beginRun({ projectRoot: OTHER, question: "theirs", provider: "ollama", model: "m" });
    recordStep(id, 0, { kind: "thought", text: "secret" });

    // Holding the id is not enough. The same argument diffs.ts makes about ownership.
    expect(stepsFor(ROOT, id)).toEqual([]);
    expect(stepsFor(OTHER, id)).toHaveLength(1);
  });

  it("returns nothing for an unknown run rather than throwing", () => {
    expect(stepsFor(ROOT, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("ordering and bounds", () => {
  it("puts the newest run first even when the clock ties", () => {
    /**
     * `datetime('now')` is whole seconds, so runs started in the same second all share a
     * timestamp — the tie-break on rowid is what keeps the order stable. Without it the list
     * would shuffle between calls, which is how "most recent" quietly stops meaning anything.
     */
    const ids = ["a", "b", "c"].map((q) =>
      beginRun({ projectRoot: ROOT, question: q, provider: "ollama", model: "m" })
    );
    expect(ids).toHaveLength(3);
    expect(recentRuns(ROOT).map((r) => r.question)).toEqual(["c", "b", "a"]);
  });

  it("honours the limit", () => {
    for (let i = 0; i < 10; i++) {
      beginRun({ projectRoot: ROOT, question: `q${String(i)}`, provider: "ollama", model: "m" });
    }
    expect(recentRuns(ROOT, 3)).toHaveLength(3);
  });

  it("drops a run's steps with the run", () => {
    // ON DELETE CASCADE is only real with PRAGMA foreign_keys = ON, which db.ts sets per
    // connection. Asserting it here means a lost pragma shows up as a test failure rather
    // than as orphaned rows nobody counts.
    const id = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordStep(id, 0, { kind: "thought", text: "x" });

    // `openDatabase()`, not `__useInMemory()` — the latter closes and recreates the file,
    // which would wipe the row this test just wrote and pass for entirely the wrong reason.
    openDatabase().prepare("DELETE FROM agent_runs WHERE id = ?").run(id);
    expect(stepsFor(ROOT, id)).toEqual([]);
  });
});
