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
  rootA = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-ws-a-"));
  rootB = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-ws-b-"));
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
