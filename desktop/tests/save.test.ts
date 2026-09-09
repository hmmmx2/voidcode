/**
 * Writing an editor buffer to disk.
 *
 * This is the only code besides `commitDiff` that writes to the user's filesystem, so the
 * tests are about the two things that make that safe: it cannot write outside the project
 * root, and it will not overwrite a file that changed since the buffer was opened.
 *
 * Mirrors `tests/diffs.test.ts`, which covers the same guarantees for the other write path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: async () => ({ response: 2 }) },
}));

const { saveWorkspaceFile, SaveConflictError } = await import("../src/main/build/save.js");
const { __setProjectRoot } = await import("../src/main/workspace.js");

import { fakeSender } from "./stubs/sender.js";

/** One window's grant. Path resolution is per window now, so every call names one. */
const sender = fakeSender();

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-save-"));
  __setProjectRoot(sender, root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const read = (relative: string): Promise<string> =>
  fs.readFile(path.join(root, relative), "utf8");

describe("saving", () => {
  it("writes a file that already exists", async () => {
    await fs.writeFile(path.join(root, "main.py"), "old", "utf8");

    const result = await saveWorkspaceFile(sender, "main.py", "new", "old");

    expect(await read("main.py")).toBe("new");
    expect(result.bytes).toBe(3);
    expect(result.path).toBe("main.py");
  });

  it("creates a file that does not exist yet, given a null baseline", async () => {
    // `null` means "this buffer is for a file that was not on disk". Save As and a new file
    // both land here, and `resolveWithinAllowingNew` is what permits it.
    await saveWorkspaceFile(sender, "fresh.py", "print(1)", null);
    expect(await read("fresh.py")).toBe("print(1)");
  });

  it("creates missing parent directories", async () => {
    await saveWorkspaceFile(sender, "pkg/sub/mod.py", "x = 1", null);
    expect(await read("pkg/sub/mod.py")).toBe("x = 1");
  });

  it("reports the project-relative path, not the absolute one", async () => {
    const result = await saveWorkspaceFile(sender, "pkg/mod.py", "x", null);
    // Forward slashes on every platform, matching what `fs:read` accepts back.
    expect(result.path).toBe("pkg/mod.py");
    expect(result.path).not.toContain(root);
  });

  it("counts bytes rather than characters", async () => {
    const result = await saveWorkspaceFile(sender, "unicode.py", "# π≈3", null);
    expect(result.bytes).toBe(Buffer.byteLength("# π≈3", "utf8"));
    expect(result.bytes).toBeGreaterThan("# π≈3".length);
  });
});

describe("refusing to clobber", () => {
  it("rejects when the file changed since the buffer was opened", async () => {
    await fs.writeFile(path.join(root, "main.py"), "opened", "utf8");
    // The assistant, another tool, or the user in another editor.
    await fs.writeFile(path.join(root, "main.py"), "changed by someone else", "utf8");

    await expect(saveWorkspaceFile(sender, "main.py", "mine", "opened")).rejects.toThrow(
      SaveConflictError
    );
    // Nothing written. A save that half-happens is worse than one that refuses.
    expect(await read("main.py")).toBe("changed by someone else");
  });

  it("rejects when the buffer thinks the file is new but it exists", async () => {
    await fs.writeFile(path.join(root, "taken.py"), "already here", "utf8");

    await expect(saveWorkspaceFile(sender, "taken.py", "mine", null)).rejects.toThrow(SaveConflictError);
    expect(await read("taken.py")).toBe("already here");
  });

  it("rejects when the buffer expects content but the file was deleted", async () => {
    // Deleting and recreating is a different intent from saving over what you opened.
    await expect(saveWorkspaceFile(sender, "gone.py", "mine", "was here")).rejects.toThrow(
      SaveConflictError
    );
  });

  it("names the file in the error, since that is the whole point of it", async () => {
    await fs.writeFile(path.join(root, "pkg", "deep.py").replace("pkg", "."), "a", "utf8");
    await expect(saveWorkspaceFile(sender, "deep.py", "b", "not-a")).rejects.toThrow(/deep\.py/);
  });
});

describe("confinement", () => {
  it("refuses to escape the project root", async () => {
    // The same guard `proposeWrite` uses. Without it, "save" is arbitrary file write.
    await expect(saveWorkspaceFile(sender, "../escape.py", "x", null)).rejects.toThrow();
    await expect(saveWorkspaceFile(sender, "../../escape.py", "x", null)).rejects.toThrow();
  });

  it("refuses an absolute path", async () => {
    const outside = path.join(os.tmpdir(), "voidcode-outside.py");
    await expect(saveWorkspaceFile(sender, outside, "x", null)).rejects.toThrow();
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it("refuses when no project is open", async () => {
    __setProjectRoot(sender, undefined);
    // Otherwise "save" would resolve against whatever the process cwd happens to be.
    await expect(saveWorkspaceFile(sender, "main.py", "x", null)).rejects.toThrow();
  });
});
