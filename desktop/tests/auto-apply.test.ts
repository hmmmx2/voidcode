/**
 * The write that Auto mode makes without asking.
 *
 * `openAgentStream` needs Electron's `MessageChannelMain`, which the test stub does not have —
 * so this exercises the pieces it composes, in the same order and with the same arguments, and
 * `agent-modes.test.ts` asserts that `stream.ts` really composes them that way. Between the
 * two, both halves are covered: that the sequence is correct, and that it is the sequence.
 *
 * What is being pinned is mostly what must NOT happen. An unarmed window writes nothing; a
 * checkpoint exists before the first byte lands; and the undo puts everything back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";

let userData: string;
vi.mock("electron", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../tests/stubs/electron.js");
  return { ...actual, app: { getPath: () => userData } };
});

const { __setProjectRoot } = await import("../src/main/workspace.js");
const { proposeWrite, commitAgentDiffs, describeAgentDiffs, __resetDiffs } = await import(
  "../src/main/build/diffs.js"
);
const { isArmed, __setArmedForTest, __resetArming } = await import("../src/main/agent/arming.js");
const { captureBeforeWrite, revertRun, __resetCheckpoints } = await import(
  "../src/main/agent/checkpoint.js"
);

function fakeSender(id: number): WebContents {
  return { id, once: () => {}, isDestroyed: () => false } as unknown as WebContents;
}

const sender = fakeSender(77);
let root: string;

beforeEach(async () => {
  __resetDiffs();
  __resetArming();
  __resetCheckpoints();
  userData = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-ud-"));
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-auto-"));
  await fsp.writeFile(path.join(root, "a.ts"), "original\n", "utf8");
  __setProjectRoot(sender, root);
});

afterEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

/** What `stream.ts` does once a run in Auto mode has proposed something. */
async function applyAsAuto(runId: string, ids: string[]): Promise<{ written: string[] }> {
  if (!isArmed(sender, root)) return { written: [] };

  for (const displayPath of describeAgentDiffs(sender, ids).displayPaths) {
    await captureBeforeWrite(runId, root, displayPath);
  }

  const outcome = await commitAgentDiffs(sender, ids, {
    approve: async () => false,
    armed: true,
  });
  return { written: outcome.results.filter((r) => r.ok).map((r) => r.path) };
}

describe("an unarmed window", () => {
  it("writes nothing, however the mode is set", async () => {
    /**
     * The mode is the renderer's choice; arming is not. A compromised renderer can ask for
     * Auto all it likes — the write is gated on a human having answered a window it has no
     * handle to.
     */
    const diff = await proposeWrite(sender, "a.ts", "rewritten\n", "agent");

    const result = await applyAsAuto("run-unarmed", [diff.id]);

    expect(result.written).toEqual([]);
    expect(await fsp.readFile(path.join(root, "a.ts"), "utf8")).toBe("original\n");
  });
});

describe("an armed window", () => {
  beforeEach(() => __setArmedForTest(sender, { root }));

  it("writes without a dialog, and never calls approve", async () => {
    /**
     * `approve` returns FALSE here.
     *
     * If the implementation ever satisfied the gate by calling it — or by passing a lambda
     * that returns true — this write would be refused and the test would fail. That is the
     * point: `armed` has to be the thing that opens the gate, not a callback dressed up as
     * consent.
     */
    const diff = await proposeWrite(sender, "a.ts", "rewritten\n", "agent");
    let asked = false;

    const outcome = await commitAgentDiffs(sender, [diff.id], {
      approve: async () => {
        asked = true;
        return false;
      },
      armed: true,
    });

    expect(asked).toBe(false);
    expect(outcome.approved).toBe(true);
    expect(outcome.viaArming).toBe(true);
    expect(await fsp.readFile(path.join(root, "a.ts"), "utf8")).toBe("rewritten\n");
  });

  it("can be undone, back to the byte", async () => {
    const diff = await proposeWrite(sender, "a.ts", "rewritten by the agent\n", "agent");
    await applyAsAuto("run-undo", [diff.id]);
    expect(await fsp.readFile(path.join(root, "a.ts"), "utf8")).toBe("rewritten by the agent\n");

    const undo = await revertRun("run-undo");

    expect(await fsp.readFile(path.join(root, "a.ts"), "utf8")).toBe("original\n");
    expect(undo.restored).toEqual(["a.ts"]);
    expect(undo.failed).toEqual([]);
  });

  it("undoes a file it created by deleting it", async () => {
    const diff = await proposeWrite(sender, "made.ts", "brand new\n", "agent");
    await applyAsAuto("run-created", [diff.id]);
    expect(await fsp.readFile(path.join(root, "made.ts"), "utf8")).toBe("brand new\n");

    await revertRun("run-created");

    const stillThere = await fsp
      .access(path.join(root, "made.ts"))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  });

  it("does not carry over to another project", async () => {
    // The grant named a folder. Pointing the same window somewhere else is a different
    // subject, and the user did not agree to it.
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-other-"));
    try {
      expect(isArmed(sender, other)).toBe(false);
    } finally {
      await fsp.rm(other, { recursive: true, force: true });
    }
  });
});
