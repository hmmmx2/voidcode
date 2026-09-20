/**
 * The project root is per window.
 *
 * It used to be one module-level `let`, so File ▸ New Window followed by Open Folder silently
 * repointed the *first* window too. Nothing crashed: window A kept showing project A's tree
 * while its `fs:read` resolved against project B, so you got the wrong file, or a "no project
 * is open" for a file plainly visible in the sidebar. A correctness bug wearing a UI bug's
 * clothes.
 *
 * Every test here needs two senders, because one proves nothing — the claim is about
 * isolation, and a single-window test passes just as happily against a global.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const {
  currentProjectRoot,
  readWorkspaceFile,
  writeWorkspacePath,
  NoWorkspaceError,
  __setProjectRoot,
  __resetWorkspaceRoots,
} = await import("../src/main/workspace.js");

import { fakeSender } from "./stubs/sender.js";

let alice: ReturnType<typeof fakeSender>;
let bob: ReturnType<typeof fakeSender>;
let rootA: string;
let rootB: string;

beforeEach(async () => {
  __resetWorkspaceRoots();
  alice = fakeSender();
  bob = fakeSender();
  // CANONICAL, because `currentProjectRoot` is now canonical — see the last describe in this
  // file. Without this the four `toBe(rootA)` assertions below compare a raw temp path with the
  // realpath the module stores, and they fail on exactly the runners where the two differ
  // (macOS `/var` → `/private/var`, Windows 8.3 aliases) while passing on a laptop.
  rootA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-ws-a-")));
  rootB = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-ws-b-")));
  await fs.writeFile(path.join(rootA, "only-in-a.py"), "a", "utf8");
  await fs.writeFile(path.join(rootB, "only-in-b.py"), "b", "utf8");
});

afterEach(async () => {
  __resetWorkspaceRoots();
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
});

describe("two windows, two projects", () => {
  it("keeps each window's root to itself", () => {
    __setProjectRoot(alice, rootA);
    __setProjectRoot(bob, rootB);

    expect(currentProjectRoot(alice)).toBe(rootA);
    expect(currentProjectRoot(bob)).toBe(rootB);
  });

  it("does not let one window's open folder repoint another's", () => {
    // THE REGRESSION. With a module-level root, the second assignment won here and Alice
    // silently started resolving against Bob's project.
    __setProjectRoot(alice, rootA);
    __setProjectRoot(bob, rootB);

    expect(currentProjectRoot(alice)).toBe(rootA);
  });

  it("resolves the same relative path to different files", async () => {
    __setProjectRoot(alice, rootA);
    __setProjectRoot(bob, rootB);

    await expect(readWorkspaceFile(alice, "only-in-a.py")).resolves.toContain("voidcode-ws-a-");
    await expect(readWorkspaceFile(bob, "only-in-b.py")).resolves.toContain("voidcode-ws-b-");
  });

  it("refuses a file that exists only in the other window's project", async () => {
    __setProjectRoot(alice, rootA);
    __setProjectRoot(bob, rootB);

    // Not "wrong contents" — the path does not resolve at all, which is the honest failure.
    await expect(readWorkspaceFile(alice, "only-in-b.py")).rejects.toThrow();
  });
});

describe("a window with no project", () => {
  it("is denied even while another window has one open", async () => {
    // `undefined` means deny, exactly as it does for mode. A second window inheriting the
    // first window's grant is the whole bug.
    __setProjectRoot(alice, rootA);

    await expect(readWorkspaceFile(bob, "only-in-a.py")).rejects.toThrow(NoWorkspaceError);
    await expect(writeWorkspacePath(bob, "new.py")).rejects.toThrow(NoWorkspaceError);
    expect(currentProjectRoot(bob)).toBeUndefined();
  });
});

describe("lifetime", () => {
  it("forgets a window's root when the window is destroyed", () => {
    __setProjectRoot(alice, rootA);
    expect(currentProjectRoot(alice)).toBe(rootA);

    alice.destroy();

    // Ids are monotonic and never reused, so a late message from a dead window must resolve
    // to nothing rather than to whoever occupies that slot next.
    expect(currentProjectRoot(alice)).toBeUndefined();
  });

  it("leaves other windows alone when one is destroyed", () => {
    __setProjectRoot(alice, rootA);
    __setProjectRoot(bob, rootB);

    alice.destroy();

    expect(currentProjectRoot(bob)).toBe(rootB);
  });
});

describe("confinement still holds per window", () => {
  it("refuses an escaping path", async () => {
    __setProjectRoot(alice, rootA);

    await expect(readWorkspaceFile(alice, "../escape.py")).rejects.toThrow();
    await expect(writeWorkspacePath(alice, "../../escape.py")).rejects.toThrow();
  });

  it("cannot be escaped by naming the other project absolutely", async () => {
    // Making the root per-window must not accidentally make an absolute path acceptable:
    // `resolveWithin` is still the only door.
    __setProjectRoot(alice, rootA);

    await expect(readWorkspaceFile(alice, path.join(rootB, "only-in-b.py"))).rejects.toThrow();
  });
});

describe("the root is stored as the filesystem spells it", () => {
  /**
   * THE BUG THIS PREVENTS WAS IN EVERY DISPLAYED PATH, and it hid because it needs a root whose
   * string is not its own realpath. `openProjectViaDialog` stored `filePaths[0]` verbatim;
   * containment was safe because `resolveWithin` canonicalises both sides on every call, so the
   * only thing that went wrong was the part nothing canonicalised — `path.relative(rawRoot,
   * canonicalAbsolute)`, which walks up out of one spelling of a directory and back down into the
   * other. `main.py` was reported as `../../../../../private/var/folders/.../main.py`, and that
   * string is the memory index's key, the approval dialog's subject line, and what the agent diff
   * panel renders.
   *
   * Eleven tests caught it on the macOS and Windows CI runners and none on a developer machine,
   * because `os.tmpdir()` is already canonical here and a project under `/Users/me` or
   * `C:\Users\me` is too. This test asks the question directly instead, so it does not depend on
   * which runner happens to have a symlinked temp directory.
   */
  it("canonicalises a root reached through a symlink", async (ctx) => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-ws-link-")));
    const real = path.join(parent, "real-project");
    const viaLink = path.join(parent, "link-to-project");
    await fs.mkdir(real);
    try {
      // "junction" on Windows, which — unlike a symlink there — needs no elevation and no
      // Developer Mode, so this should run on all three runners. `paths.test.ts` records the
      // elevation requirement for the symlink cases it needs.
      await fs.symlink(real, viaLink, "junction");
    } catch {
      // `ctx.skip()` rather than `return`: a test that returns early reports as PASSED having
      // asserted nothing, which is the shape of green that hides a missing check.
      ctx.skip();
      return;
    }

    __setProjectRoot(alice, viaLink);
    expect(currentProjectRoot(alice)).toBe(real);
    expect(currentProjectRoot(alice)).not.toBe(viaLink);
  });

  it("stores a root that cannot be resolved exactly as given", () => {
    // A directory that is not there is a race — unmounted or renamed between the dialog and the
    // bind — and `resolveWithin` refuses it on the next call with a real error. Throwing out of
    // the bind instead would surface as a modal dialog on a path the user just picked.
    const missing = path.join(rootA, "not-created");
    __setProjectRoot(bob, missing);
    expect(currentProjectRoot(bob)).toBe(missing);
  });
});
