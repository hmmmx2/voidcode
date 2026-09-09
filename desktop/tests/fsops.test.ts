/**
 * Creating, renaming and deleting.
 *
 * Two properties carry the weight. **Confinement**, which is the same claim `fs:read` and
 * `fs:save` make and has to be re-proved for every new door to the filesystem — a create that
 * accepted `../` would be a whole-disk write reachable from a context menu. And **never
 * overwrite**, because a New File that truncated an existing one, or a rename that ate its
 * destination, is data loss wearing an ordinary label.
 *
 * `shell.trashItem` is stubbed. Testing that Electron can talk to the OS trash is not this
 * suite's job; testing that a refusal from it stops the delete rather than downgrading to an
 * unrecoverable `fs.rm` very much is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const trashItem = vi.fn<(p: string) => Promise<void>>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { trashItem: (p: string) => trashItem(p) },
}));

const { createEntry, renameEntry, deleteEntry, EntryExistsError, RootProtectedError, TrashUnavailableError } =
  await import("../src/main/build/fsops.js");
const { __setProjectRoot, __resetWorkspaceRoots, NoWorkspaceError } = await import(
  "../src/main/workspace.js"
);
const { PathEscapeError } = await import("../src/main/paths.js");

import { fakeSender } from "./stubs/sender.js";

let sender: ReturnType<typeof fakeSender>;
let root: string;

const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8");
const there = (relative: string) =>
  fs.lstat(path.join(root, relative)).then(
    () => true,
    () => false
  );

beforeEach(async () => {
  __resetWorkspaceRoots();
  sender = fakeSender();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-fsops-"));
  __setProjectRoot(sender, root);
  trashItem.mockReset();
  trashItem.mockResolvedValue(undefined);
});

afterEach(async () => {
  __resetWorkspaceRoots();
  await fs.rm(root, { recursive: true, force: true });
});

describe("creating", () => {
  it("creates an empty file and reports its project-relative path", async () => {
    const result = await createEntry(sender, "src/main.py", "file");

    expect(result).toEqual({ path: "src/main.py", kind: "file" });
    expect(await read("src/main.py")).toBe("");
  });

  it("creates missing parent directories on the way", async () => {
    await createEntry(sender, "a/b/c/deep.py", "file");
    expect(await there("a/b/c/deep.py")).toBe(true);
  });

  it("creates a directory", async () => {
    const result = await createEntry(sender, "pkg", "directory");
    expect(result.kind).toBe("directory");
    expect((await fs.lstat(path.join(root, "pkg"))).isDirectory()).toBe(true);
  });

  it("refuses to overwrite an existing file", async () => {
    await fs.writeFile(path.join(root, "keep.py"), "precious", "utf8");

    await expect(createEntry(sender, "keep.py", "file")).rejects.toBeInstanceOf(EntryExistsError);
    // The point of the refusal.
    expect(await read("keep.py")).toBe("precious");
  });

  it("refuses a broken symlink, which stat would call missing", async () => {
    // `lstat`, not `stat`: a dangling link exists as far as an exclusive open is concerned,
    // and reporting it absent would make this claim to create a file it then failed to write.
    try {
      await fs.symlink(path.join(root, "nowhere"), path.join(root, "dangling"));
    } catch {
      return; // Windows without developer mode — the guard is still in the code.
    }
    await expect(createEntry(sender, "dangling", "file")).rejects.toBeInstanceOf(EntryExistsError);
  });

  it("refuses to escape the project root", async () => {
    await expect(createEntry(sender, "../escape.py", "file")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(createEntry(sender, "../../escape.py", "directory")).rejects.toBeInstanceOf(
      PathEscapeError
    );
    expect(await there("../escape.py")).toBe(false);
  });

  it("refuses when no project is open", async () => {
    __setProjectRoot(sender, undefined);
    await expect(createEntry(sender, "a.py", "file")).rejects.toBeInstanceOf(NoWorkspaceError);
  });
});

describe("renaming", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(root, "old.py"), "content", "utf8");
  });

  it("renames a file, keeping its contents", async () => {
    const result = await renameEntry(sender, "old.py", "new.py");

    expect(result).toEqual({ path: "new.py", kind: "file" });
    expect(await read("new.py")).toBe("content");
    expect(await there("old.py")).toBe(false);
  });

  it("moves into a subdirectory, which is the same operation", async () => {
    await fs.mkdir(path.join(root, "src"));
    await renameEntry(sender, "old.py", "src/old.py");
    expect(await read("src/old.py")).toBe("content");
  });

  it("refuses to overwrite the destination", async () => {
    await fs.writeFile(path.join(root, "taken.py"), "someone else's work", "utf8");

    await expect(renameEntry(sender, "old.py", "taken.py")).rejects.toBeInstanceOf(EntryExistsError);
    expect(await read("taken.py")).toBe("someone else's work");
    expect(await there("old.py")).toBe(true);
  });

  it("refuses to move a directory inside itself", async () => {
    // `fs.rename` reports EINVAL for this on POSIX with an opaque message, and behaves
    // inconsistently on Windows. Refusing explicitly is clearer and safer.
    await fs.mkdir(path.join(root, "pkg"));
    await expect(renameEntry(sender, "pkg", "pkg/nested")).rejects.toBeInstanceOf(RootProtectedError);
  });

  it("refuses to rename the project root", async () => {
    await expect(renameEntry(sender, ".", "renamed")).rejects.toBeInstanceOf(RootProtectedError);
  });

  it("refuses either end escaping the root", async () => {
    await expect(renameEntry(sender, "old.py", "../escaped.py")).rejects.toBeInstanceOf(
      PathEscapeError
    );
    await expect(renameEntry(sender, "../outside.py", "inside.py")).rejects.toThrow();
    expect(await there("old.py")).toBe(true);
  });

  it("reports a missing source as missing, not as forbidden", async () => {
    // "No such file" and "not allowed" are genuinely different answers; collapsing them makes
    // both harder to act on.
    await expect(renameEntry(sender, "ghost.py", "new.py")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("deleting", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(root, "doomed.py"), "x", "utf8");
  });

  it("moves the file to the trash rather than unlinking it", async () => {
    const result = await deleteEntry(sender, "doomed.py");

    expect(result).toEqual({ path: "doomed.py", kind: "file" });
    expect(trashItem).toHaveBeenCalledWith(path.join(root, "doomed.py"));
  });

  it("does NOT fall back to an unrecoverable delete when the trash refuses", async () => {
    // The whole reason trashing is not wrapped in a try/catch that calls `fs.rm`. A network
    // share or a sandbox that forbids the trash is exactly when a quiet upgrade from
    // recoverable to permanent would be least expected and most costly.
    trashItem.mockRejectedValue(new Error("no trash on this volume"));

    await expect(deleteEntry(sender, "doomed.py")).rejects.toBeInstanceOf(TrashUnavailableError);
    expect(await there("doomed.py")).toBe(true);
  });

  it("refuses to delete the project root", async () => {
    await expect(deleteEntry(sender, ".")).rejects.toBeInstanceOf(RootProtectedError);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses to escape the root", async () => {
    await expect(deleteEntry(sender, "../..")).rejects.toBeInstanceOf(PathEscapeError);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("reports a directory as a directory", async () => {
    await fs.mkdir(path.join(root, "pkg"));
    expect(await deleteEntry(sender, "pkg")).toEqual({ path: "pkg", kind: "directory" });
  });
});

describe("one window cannot reach another's project", () => {
  it("resolves each operation against its own sender's root", async () => {
    const other = fakeSender();
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-fsops-other-"));
    __setProjectRoot(other, otherRoot);

    try {
      await createEntry(other, "theirs.py", "file");

      // Created in the other window's project, and invisible from this one.
      expect(await there("theirs.py")).toBe(false);
      await expect(deleteEntry(sender, "theirs.py")).rejects.toThrow();
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});
