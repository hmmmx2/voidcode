/**
 * Workspace confinement (spec §2.11).
 *
 * The symlink cases are the point. A string-based containment check passes every
 * `..` test and still lets an agent read `~/.ssh` through a link that lives inside
 * the workspace.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isWithin,
  resolveWithin,
  resolveWithinAllowingNew,
  PathEscapeError,
} from "../src/main/paths.js";

let tmp: string;
let root: string;
let outside: string;
/** Windows needs elevation or Developer Mode to create symlinks. */
let symlinksAvailable = true;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-paths-"));
  root = path.join(tmp, "project");
  outside = path.join(tmp, "secrets");

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, "src", "main.py"), "print(1)\n");
  await fs.writeFile(path.join(outside, "id_rsa"), "PRIVATE KEY\n");

  // A sibling whose name has the root as a string prefix. This is the case a
  // naive `startsWith` gets wrong.
  await fs.mkdir(`${root}-secrets`, { recursive: true });
  await fs.writeFile(path.join(`${root}-secrets`, "leak.txt"), "nope\n");

  try {
    await fs.symlink(outside, path.join(root, "escape-dir"), "dir");
    await fs.symlink(path.join(outside, "id_rsa"), path.join(root, "escape-file"));
  } catch {
    symlinksAvailable = false;
  }
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("isWithin", () => {
  it("accepts the root itself and descendants", () => {
    expect(isWithin("/a/proj", "/a/proj")).toBe(true);
    expect(isWithin("/a/proj", path.join("/a/proj", "src", "x.ts"))).toBe(true);
  });

  it("rejects a sibling that merely shares a string prefix", () => {
    // The trailing-separator case. Without it this returns true and the whole
    // guard is decorative.
    expect(isWithin("/a/proj", "/a/proj-secrets/leak.txt")).toBe(false);
  });

  it("rejects ancestors and unrelated paths", () => {
    expect(isWithin("/a/proj", "/a")).toBe(false);
    expect(isWithin("/a/proj", "/b/other")).toBe(false);
  });
});

describe("resolveWithin", () => {
  it("resolves a normal file inside the root", async () => {
    const resolved = await resolveWithin(root, "src/main.py");
    expect(resolved).toBe(await fs.realpath(path.join(root, "src", "main.py")));
  });

  it("rejects traversal out of the root", async () => {
    await expect(resolveWithin(root, "../secrets/id_rsa")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects an absolute path outside the root", async () => {
    await expect(resolveWithin(root, path.join(outside, "id_rsa"))).rejects.toBeInstanceOf(
      PathEscapeError
    );
  });

  it("rejects the string-prefix sibling", async () => {
    await expect(
      resolveWithin(root, path.join(`${root}-secrets`, "leak.txt"))
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a symlinked file that points outside", async () => {
    if (!symlinksAvailable) {
      // Reported rather than silently skipped: on a machine that cannot create
      // symlinks this case is untested, and pretending otherwise is worse than
      // saying so. CI runs on all three platforms, where at least Linux and
      // macOS exercise it.
      console.warn("[paths.test] symlinks unavailable on this host; escape cases not exercised");
      return;
    }
    await expect(resolveWithin(root, "escape-file")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a path traversing a symlinked directory", async () => {
    if (!symlinksAvailable) return;
    await expect(resolveWithin(root, "escape-dir/id_rsa")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("propagates ENOENT rather than reporting an escape", async () => {
    // "does not exist" and "not allowed" are different answers; collapsing them
    // makes both harder to handle at the call site.
    await expect(resolveWithin(root, "src/nope.py")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("resolveWithinAllowingNew", () => {
  it("permits a new file in an existing directory", async () => {
    const target = await resolveWithinAllowingNew(root, "src/created.ts");
    expect(isWithin(await fs.realpath(root), target)).toBe(true);
  });

  it("permits a new file in a directory that does not exist yet", async () => {
    const target = await resolveWithinAllowingNew(root, "src/deep/nested/created.ts");
    expect(isWithin(await fs.realpath(root), target)).toBe(true);
  });

  it("rejects a new file outside the root", async () => {
    await expect(
      resolveWithinAllowingNew(root, "../secrets/planted.txt")
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a new file under a symlinked directory", async () => {
    if (!symlinksAvailable) return;
    // The important write case: the target does not exist, so only the ancestor
    // check can catch this.
    await expect(
      resolveWithinAllowingNew(root, "escape-dir/planted.txt")
    ).rejects.toBeInstanceOf(PathEscapeError);
  });
});
