/**
 * Find in Files.
 *
 * The bounds are the interesting part. An unbounded project-wide search runs in the main
 * process, so every missing limit is a way to freeze the whole app — and the skip list is what
 * separates "search my project" from "read every byte of node_modules".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const { searchInFiles, NoProjectError } = await import("../src/main/build/search.js");
const { __setProjectRoot } = await import("../src/main/workspace.js");

import { fakeSender } from "./stubs/sender.js";

/** One window's grant. Path resolution is per window now, so every call names one. */
const sender = fakeSender();

let root: string;

async function write(relative: string, contents: string): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-search-"));
  __setProjectRoot(sender, root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  __setProjectRoot(sender, undefined);
});

describe("searching", () => {
  it("finds a line and reports where it is", async () => {
    await write("main.py", "import os\ndef softmax(x):\n    return x\n");

    const { matches } = await searchInFiles(sender, "softmax");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "main.py", line: 2, column: 5 });
    expect(matches[0]?.preview).toBe("def softmax(x):");
  });

  it("uses forward slashes in nested paths, matching what fs:read takes back", async () => {
    await write("pkg/sub/mod.py", "needle\n");
    const { matches } = await searchInFiles(sender, "needle");
    expect(matches[0]?.path).toBe("pkg/sub/mod.py");
  });

  it("is case-insensitive by default and exact on request", async () => {
    await write("a.py", "Softmax\n");

    expect((await searchInFiles(sender, "softmax")).matches).toHaveLength(1);
    expect((await searchInFiles(sender, "softmax", { caseSensitive: true })).matches).toHaveLength(0);
    expect((await searchInFiles(sender, "Softmax", { caseSensitive: true })).matches).toHaveLength(1);
  });

  it("reports one match per line, not one per occurrence", async () => {
    // Two hits on one line is one result to a reader.
    await write("a.py", "x = softmax(softmax(y))\n");
    expect((await searchInFiles(sender, "softmax")).matches).toHaveLength(1);
  });

  it("returns nothing for an empty query rather than matching every line", async () => {
    await write("a.py", "anything\n");
    const result = await searchInFiles(sender, "   ");
    expect(result.matches).toHaveLength(0);
    expect(result.filesSearched).toBe(0);
  });

  it("refuses when no project is open", async () => {
    __setProjectRoot(sender, undefined);
    await expect(searchInFiles(sender, "x")).rejects.toThrow(NoProjectError);
  });
});

describe("bounds", () => {
  it("skips the directories nobody means by 'my project'", async () => {
    await write("src/a.py", "needle\n");
    await write("node_modules/pkg/index.js", "needle\n");
    await write(".git/config", "needle\n");
    await write("dist/bundle.js", "needle\n");

    const { matches } = await searchInFiles(sender, "needle");
    expect(matches.map((m) => m.path)).toEqual(["src/a.py"]);
  });

  it("skips binary files", async () => {
    // A NUL byte is the cheap standard test. Without it a search reports thousands of hits
    // inside compiled output.
    await write("data.bin", `needle\0${"\0".repeat(50)}`);
    await write("real.py", "needle\n");

    const { matches } = await searchInFiles(sender, "needle");
    expect(matches.map((m) => m.path)).toEqual(["real.py"]);
  });

  it("skips very large files", async () => {
    // Reading a 200MB CSV into memory to grep it is how a search takes the process down.
    await write("huge.txt", `${"x".repeat(2_100_000)}needle`);
    await write("small.txt", "needle");

    const { matches } = await searchInFiles(sender, "needle");
    expect(matches.map((m) => m.path)).toEqual(["small.txt"]);
  });

  it("caps matches and says it did", async () => {
    // Silent truncation reads as "that is all of them", which is the failure this reports
    // rather than commits.
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i} needle`).join("\n");
    await write("many.txt", lines);

    const result = await searchInFiles(sender, "needle");
    expect(result.matches).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it("does not claim truncation when it found everything", async () => {
    await write("a.py", "needle\n");
    const result = await searchInFiles(sender, "needle");
    expect(result.truncated).toBe(false);
    expect(result.filesSearched).toBe(1);
  });

  it("survives an unreadable directory rather than failing the whole search", async () => {
    await write("ok/a.py", "needle\n");
    const result = await searchInFiles(sender, "needle");
    expect(result.matches).toHaveLength(1);
  });
});
