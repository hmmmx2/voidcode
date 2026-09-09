/**
 * The Build Mode write path.
 *
 * The claim under test is narrow and load-bearing: **`fs:writeWithDiff` cannot change a file.**
 * Everything else here supports that one property, because it is what lets an unrestricted
 * assistant point at someone's real repository. If a diff could reach disk without a commit —
 * or if a commit could be steered to a different file than the one reviewed — the review step
 * would be decoration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  proposeWrite,
  commitDiff,
  DiffExpiredError,
  FileChangedError,
  __resetDiffs,
  __diffLines,
} from "../src/main/build/diffs.js";
import { __setProjectRoot } from "../src/main/workspace.js";
import { PathEscapeError } from "../src/main/paths.js";

import { fakeSender } from "./stubs/sender.js";

/** One window's grant. Path resolution is per window now, so every call names one. */
const sender = fakeSender();

let root: string;

beforeEach(async () => {
  __resetDiffs();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-diffs-"));
  // `realpath` because macOS hands back `/var/...` where the real path is `/private/var/...`,
  // and the confinement check compares realpaths. Without this every case would fail as an
  // escape attempt on that platform.
  root = await fs.realpath(root);
  __setProjectRoot(sender, root);
});

afterEach(async () => {
  __setProjectRoot(sender, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, contents: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

function read(relative: string): Promise<string> {
  return fs.readFile(path.join(root, relative), "utf8");
}

describe("proposing a write", () => {
  it("does not touch the file", async () => {
    await write("a.ts", "original\n");

    const diff = await proposeWrite(sender, "a.ts", "replaced\n");

    expect(diff.id).toBeTruthy();
    // The entire point of the design.
    expect(await read("a.ts")).toBe("original\n");
  });

  it("does not create a file that does not exist yet", async () => {
    const diff = await proposeWrite(sender, "new/nested.ts", "hello\n");

    expect(diff.isNew).toBe(true);
    await expect(fs.access(path.join(root, "new/nested.ts"))).rejects.toThrow();
  });

  it("never returns the proposed content", async () => {
    await write("a.ts", "original\n");

    const diff = await proposeWrite(sender, "a.ts", "SECRET_PAYLOAD\n");

    // A renderer that received `next` could write it itself and skip review entirely. The
    // added lines are visible in `lines` — that is the review — but the assembled file is not.
    expect(diff).not.toHaveProperty("next");
    expect(diff).not.toHaveProperty("baseline");
  });

  it("reports a project-relative display path, not the caller's string", async () => {
    await write("src/a.ts", "x\n");

    const diff = await proposeWrite(sender, "src/../src/a.ts", "y\n");

    // Echoing the caller's string back would let the label in the review UI disagree with
    // the file actually being written.
    expect(diff.displayPath).toBe("src/a.ts");
  });

  it("rejects a path that escapes the project root", async () => {
    await expect(proposeWrite(sender, "../outside.ts", "x\n")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(proposeWrite(sender, "../../etc/hosts", "x\n")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("counts added and removed lines", async () => {
    await write("a.ts", "one\ntwo\nthree\n");

    const diff = await proposeWrite(sender, "a.ts", "one\nTWO\nthree\n");

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.filter((l) => l.kind === "context")).toHaveLength(3); // one, three, ""
  });
});

describe("committing a diff", () => {
  it("writes exactly the reviewed content", async () => {
    await write("a.ts", "original\n");
    const diff = await proposeWrite(sender, "a.ts", "replaced\n");

    const result = await commitDiff(sender, diff.id);

    expect(await read("a.ts")).toBe("replaced\n");
    expect(result.path).toBe("a.ts");
  });

  it("creates intermediate directories for a new file", async () => {
    const diff = await proposeWrite(sender, "deeply/nested/new.ts", "hello\n");

    await commitDiff(sender, diff.id);

    expect(await read("deeply/nested/new.ts")).toBe("hello\n");
  });

  it("refuses a second commit of the same diff", async () => {
    await write("a.ts", "original\n");
    const diff = await proposeWrite(sender, "a.ts", "replaced\n");
    await commitDiff(sender, diff.id);

    // Otherwise one approval could be replayed to undo a later edit.
    await expect(commitDiff(sender, diff.id)).rejects.toBeInstanceOf(DiffExpiredError);
  });

  it("refuses an id it never issued", async () => {
    await expect(commitDiff(sender, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
      DiffExpiredError
    );
  });

  it("refuses to write when the file changed underneath, and leaves it intact", async () => {
    await write("a.ts", "original\n");
    const diff = await proposeWrite(sender, "a.ts", "from the model\n");

    // The user edits the file while the diff sits in the review panel.
    await write("a.ts", "the user's own work\n");

    await expect(commitDiff(sender, diff.id)).rejects.toBeInstanceOf(FileChangedError);
    // Committing anyway would silently discard work the diff was never computed against.
    expect(await read("a.ts")).toBe("the user's own work\n");
  });

  it("refuses when a file appeared where the diff expected none", async () => {
    const diff = await proposeWrite(sender, "new.ts", "from the model\n");
    await write("new.ts", "someone got there first\n");

    await expect(commitDiff(sender, diff.id)).rejects.toBeInstanceOf(FileChangedError);
    expect(await read("new.ts")).toBe("someone got there first\n");
  });

  it("refuses a commit from a window that did not propose it", async () => {
    // A diff id is the caller's only handle on a pending write, and it is a uuid — but
    // "unguessable" is not an access control. Without an owner check, a second Build window
    // that learned an id could commit a write resolved against the FIRST window's root,
    // which is exactly the cross-window escape making the root per-window closes.
    await write("a.ts", "original\n");
    const diff = await proposeWrite(sender, "a.ts", "replaced\n");

    const intruder = fakeSender();
    await expect(commitDiff(intruder, diff.id)).rejects.toBeInstanceOf(DiffExpiredError);
    expect(await read("a.ts")).toBe("original\n");

    // And the refusal must not consume the diff — the window that owns it may still be about
    // to apply it legitimately.
    await expect(commitDiff(sender, diff.id)).resolves.toMatchObject({ path: "a.ts" });
    expect(await read("a.ts")).toBe("replaced\n");
  });
});

describe("the diff algorithm", () => {
  it("marks unchanged lines as context", () => {
    const lines = __diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("finds a single-line insertion rather than rewriting the file", () => {
    const lines = __diffLines(["a", "c"], ["a", "b", "c"]);

    expect(lines.filter((l) => l.kind === "add")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "remove")).toHaveLength(0);
    expect(lines.find((l) => l.kind === "add")?.text).toBe("b");
  });

  it("numbers lines against the correct side", () => {
    const lines = __diffLines(["a", "gone"], ["a", "new"]);

    const removed = lines.find((l) => l.kind === "remove");
    const added = lines.find((l) => l.kind === "add");
    expect(removed).toMatchObject({ before: 2 });
    expect(removed?.after).toBeUndefined();
    expect(added).toMatchObject({ after: 2 });
    expect(added?.before).toBeUndefined();
  });

  it("falls back to whole-file replacement past the line bound instead of allocating", () => {
    // The guard that matters. An O(n*m) table over 50k lines is 2.5 billion cells; the
    // main process would die allocating it, taking every window with it. This must return
    // promptly rather than exhaust memory.
    const before = Array.from({ length: 40_000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[0] = "changed";

    const lines = __diffLines(before, after);

    expect(lines.filter((l) => l.kind === "context")).toHaveLength(0);
    expect(lines.filter((l) => l.kind === "remove")).toHaveLength(40_000);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(40_000);
  });
});
