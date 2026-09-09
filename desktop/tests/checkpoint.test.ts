/**
 * The undo for an Auto run.
 *
 * Auto writes without asking, so this is what makes that recoverable — and a checkpoint that
 * is subtly wrong is worse than none, because the offer of an undo is what makes the mode
 * defensible in the first place.
 *
 * Real files throughout. Every property here is about the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

let userData: string;

vi.mock("electron", () => ({
  app: { getPath: () => userDataPath() },
}));

/** Indirection so the mock can see a value assigned in `beforeEach`. */
function userDataPath(): string {
  return userData;
}

const { captureBeforeWrite, revertRun, hasCheckpoint, __resetCheckpoints, MAX_CHECKPOINT_FILES } =
  await import("../src/main/agent/checkpoint.js");

let project: string;

beforeEach(async () => {
  __resetCheckpoints();
  userData = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-ud-"));
  project = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-proj-"));
});

afterEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true });
  await fsp.rm(project, { recursive: true, force: true });
});

const write = (rel: string, text: string): Promise<void> =>
  fsp.writeFile(path.join(project, rel), text, "utf8");
const read = (rel: string): Promise<string> => fsp.readFile(path.join(project, rel), "utf8");
const exists = (rel: string): Promise<boolean> =>
  fsp.access(path.join(project, rel)).then(() => true).catch(() => false);

describe("restoring a modified file", () => {
  it("puts back what was there before", async () => {
    await write("a.ts", "original\n");

    await captureBeforeWrite("run-1", project, "a.ts");
    await write("a.ts", "the agent's version\n");

    const outcome = await revertRun("run-1");

    expect(await read("a.ts")).toBe("original\n");
    expect(outcome.restored).toEqual(["a.ts"]);
    expect(outcome.failed).toEqual([]);
  });

  it("keeps the FIRST state when a run writes the same file twice", async () => {
    /**
     * The bug a naive capture ships.
     *
     * A run that edits a file, reads it back and edits again would otherwise snapshot its own
     * intermediate version as the "original" — and reverting would land on a state that never
     * existed before the run started, which is worse than not reverting at all because it
     * looks like it worked.
     */
    await write("a.ts", "original\n");

    await captureBeforeWrite("run-1", project, "a.ts");
    await write("a.ts", "first edit\n");
    await captureBeforeWrite("run-1", project, "a.ts");
    await write("a.ts", "second edit\n");

    await revertRun("run-1");

    expect(await read("a.ts")).toBe("original\n");
  });
});

describe("deleting a file the run created", () => {
  it("removes it, rather than leaving it behind", async () => {
    /**
     * The half of revert that is easy to skip.
     *
     * A created file has no previous contents, so an implementation that only restores what it
     * captured leaves it on disk — and the project is not back where it started. `existed:
     * false` is recorded precisely so the revert knows to delete.
     */
    await captureBeforeWrite("run-1", project, "brand-new.ts");
    await write("brand-new.ts", "created by the agent\n");

    const outcome = await revertRun("run-1");

    expect(await exists("brand-new.ts")).toBe(false);
    expect(outcome.deleted).toEqual(["brand-new.ts"]);
  });

  it("does not fail when the created file is already gone", async () => {
    // Someone deleted it themselves between the run and the undo. The end state is what was
    // asked for, so this is success.
    await captureBeforeWrite("run-1", project, "gone.ts");
    await write("gone.ts", "x");
    await fsp.rm(path.join(project, "gone.ts"));

    const outcome = await revertRun("run-1");

    expect(outcome.failed).toEqual([]);
    expect(outcome.deleted).toEqual(["gone.ts"]);
  });
});

describe("several files", () => {
  it("restores modified and created files in one go", async () => {
    await write("kept.ts", "before\n");

    await captureBeforeWrite("run-1", project, "kept.ts");
    await captureBeforeWrite("run-1", project, "made.ts");
    await write("kept.ts", "after\n");
    await write("made.ts", "new\n");

    const outcome = await revertRun("run-1");

    expect(await read("kept.ts")).toBe("before\n");
    expect(await exists("made.ts")).toBe(false);
    expect(outcome.restored).toEqual(["kept.ts"]);
    expect(outcome.deleted).toEqual(["made.ts"]);
  });

  it("keeps going when one path cannot be restored", async () => {
    /**
     * One failure must not abandon the rest — the same rule `commitAgentDiffs` follows, and
     * for the same reason: the user asked for the whole thing.
     *
     * Making a restore genuinely fail takes some care. The first attempt used a path under a
     * regular file, but that path never existed at capture time either — so it was recorded
     * as created-by-the-run, and *deleting* it succeeds. It landed in `deleted`, not `failed`,
     * and the test was asserting against a case it had not built.
     *
     * This version captures a file that really exists, then replaces its parent directory
     * with a regular file. Restoring now has to `mkdir` over a file, which fails everywhere.
     */
    await write("ok.ts", "before\n");
    await fsp.mkdir(path.join(project, "sub"));
    await write("sub/inner.ts", "inner before\n");

    await captureBeforeWrite("run-1", project, "ok.ts");
    await captureBeforeWrite("run-1", project, "sub/inner.ts");
    await write("ok.ts", "after\n");

    await fsp.rm(path.join(project, "sub"), { recursive: true, force: true });
    await write("sub", "now a file\n");

    const outcome = await revertRun("run-1");

    expect(await read("ok.ts")).toBe("before\n");
    expect(outcome.restored).toEqual(["ok.ts"]);
    expect(outcome.failed.map((f) => f.path)).toEqual(["sub/inner.ts"]);
  });
});

describe("bounds", () => {
  it("says when it stopped capturing rather than offering a whole undo", async () => {
    /**
     * Past the cap the run continues and the checkpoint records `truncated`. Silently dropping
     * entries would offer an undo that half works, which is the one outcome worse than
     * refusing to offer one.
     */
    for (let i = 0; i <= MAX_CHECKPOINT_FILES; i += 1) {
      await write(`f${i}.ts`, `before ${i}\n`);
      await captureBeforeWrite("run-1", project, `f${i}.ts`);
    }

    const outcome = await revertRun("run-1");

    expect(outcome.truncated).toBe(true);
    expect(outcome.restored).toHaveLength(MAX_CHECKPOINT_FILES);
    // 201 real files written, captured and restored. Well under 5s on its own and over it when
    // the whole suite runs at once — a flaky test rather than a slow one, so the timeout is
    // raised instead of the work being trimmed. Trimming it would stop exercising the bound.
  }, 30_000);
});

describe("reporting its own coverage", () => {
  /**
   * The caller has to be able to tell a whole undo from a partial one BEFORE offering it.
   *
   * This returned `void`, so `stream.ts` could only detect a capture that *threw* — not one
   * that hit the bound and quietly stopped recording. A run that wrote past the limit was
   * still offered a clean-looking "Undo file changes", and the user discovered it was partial
   * after pressing it. Reporting after the fact is not reporting.
   */
  it("says a path was recorded", async () => {
    await write("a.ts", "original\n");
    expect(await captureBeforeWrite("run-1", project, "a.ts")).toEqual({ recorded: true });
  });

  it("counts a file it is about to create as recorded", async () => {
    // There is nothing to snapshot, but "this did not exist" is exactly the instruction revert
    // needs in order to delete it — so the coverage is complete, not missing.
    expect(await captureBeforeWrite("run-1", project, "new.ts")).toEqual({ recorded: true });
  });

  it("still says recorded when the path was already captured", async () => {
    // The second call is a no-op precisely because the first one covered it. Reporting false
    // here would mark a perfectly revertable run as partial.
    await write("a.ts", "original\n");
    await captureBeforeWrite("run-1", project, "a.ts");
    expect(await captureBeforeWrite("run-1", project, "a.ts")).toEqual({ recorded: true });
  });

  it("says NOT recorded once it stops recording", async () => {
    for (let i = 0; i < MAX_CHECKPOINT_FILES; i += 1) {
      await write(`f${i}.ts`, "x\n");
      expect((await captureBeforeWrite("run-1", project, `f${i}.ts`)).recorded).toBe(true);
    }

    await write("one-too-many.ts", "x\n");
    expect(await captureBeforeWrite("run-1", project, "one-too-many.ts")).toEqual({
      recorded: false,
    });
    // 200 real files, same as the bound test above: fast alone, over the 5s default when the
    // whole suite runs at once.
  }, 30_000);
});

describe("where it is kept", () => {
  it("writes nothing into the project", async () => {
    // A snapshot of someone's code inside their repository gets committed by accident the
    // first time anyone runs `git add -A`.
    await write("a.ts", "original\n");
    await captureBeforeWrite("run-1", project, "a.ts");

    expect(await fsp.readdir(project)).toEqual(["a.ts"]);
    expect(await hasCheckpoint("run-1")).toBe(true);
  });

  it("survives without the run still being in memory", async () => {
    // A run whose window died mid-way must still be undoable, so the file is flushed at every
    // capture rather than at the end.
    await write("a.ts", "original\n");
    await captureBeforeWrite("run-1", project, "a.ts");
    await write("a.ts", "changed\n");

    __resetCheckpoints();

    expect(await read("a.ts")).toBe("changed\n");
    await revertRun("run-1");
    expect(await read("a.ts")).toBe("original\n");
  });

  it("reports a run it has never heard of, rather than claiming success", async () => {
    const outcome = await revertRun("no-such-run");
    expect(outcome.restored).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });
});
