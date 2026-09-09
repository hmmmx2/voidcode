/**
 * Project memory: chunking, the flat vector store, and what makes an index go stale.
 *
 * No model anywhere. Vectors are hand-built, which is the point — the ranking, the tombstones
 * and the compaction are arithmetic, and arithmetic tested against a live embedding model is
 * tested against a moving target.
 *
 * The invalidation pair is the load-bearing one. mtime and size are a *gate*, the hash is the
 * *truth*: a checkout restores files with new mtimes and identical contents, and re-embedding
 * a whole project because git touched it is the difference between a two-second refresh and a
 * two-minute one. Getting it backwards in the other direction is worse — an index that quietly
 * describes code that no longer exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
}));

const { chunkFile, hashOf, isUnchunkable } = await import("../src/main/memory/chunker.js");
const {
  normalise,
  topMatches,
  tombstone,
  tombstoneFraction,
  needsCompaction,
  compact,
  readIndex,
  writeIndex,
  indexPaths,
  EMBED_DIM,
} = await import("../src/main/memory/store.js");
const { prioritise } = await import("../src/main/memory/index.js");

import type { IndexState } from "../src/main/memory/store.js";
import type { Chunk } from "../src/main/memory/chunker.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-memory-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const lines = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

describe("chunking", () => {
  it("carries line numbers, so a hit can be opened", () => {
    // "Somewhere in this file" is not a search result.
    const chunks = chunkFile("a.py", lines(100));
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBeGreaterThan(1);
    expect(chunks[1]?.startLine).toBeGreaterThan(1);
  });

  it("overlaps windows, so a definition is whole in at least one", () => {
    // Without overlap the single most useful thing to retrieve — a signature and its body —
    // is reliably cut in half.
    const chunks = chunkFile("a.py", lines(100));
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine);
  });

  it("does not emit a duplicate tail", () => {
    const chunks = chunkFile("a.py", lines(45));
    const starts = chunks.map((c) => c.startLine);
    expect(new Set(starts).size).toBe(starts.length);
    expect(chunks.at(-1)?.endLine).toBe(45);
  });

  it("gives the same id for the same file, position and text", () => {
    // Stability is what lets a reindex tell "unchanged" from "moved".
    const first = chunkFile("a.py", lines(60));
    const second = chunkFile("a.py", lines(60));
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });

  it("changes the id when the text does", () => {
    const before = chunkFile("a.py", lines(60))[0];
    const after = chunkFile("a.py", lines(60).replace("line 0", "line zero"))[0];
    expect(after?.id).not.toBe(before?.id);
  });

  it("names the enclosing definition when the language shows one", () => {
    const chunks = chunkFile("a.py", "def solve(x):\n" + lines(10));
    expect(chunks[0]?.symbol).toBe("solve");
  });

  it("skips content that is not worth a vector", () => {
    expect(isUnchunkable("")).toBe(true);
    expect(isUnchunkable("   \n\n  ")).toBe(true);
    // A NUL byte: the same cheap "not text" test `search.ts` uses.
    expect(isUnchunkable(`x = 1\0${"\0".repeat(40)}`)).toBe(true);
    // Minified: one enormous line, few lines total. One useless vector at a big cost.
    expect(isUnchunkable("a".repeat(5_000))).toBe(true);
    expect(isUnchunkable("def f():\n    return 1\n")).toBe(false);
  });
});

describe("vector arithmetic", () => {
  it("normalises to unit length, so similarity is a dot product", () => {
    const v = normalise(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0] as number, v[1] as number)).toBeCloseTo(1, 5);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    // A model can return one for degenerate input. It then scores 0 against everything, which
    // is the correct outcome for a chunk carrying no signal.
    const v = normalise(Float32Array.from([0, 0]));
    expect([...v]).toEqual([0, 0]);
  });

  it("ranks by similarity", () => {
    const dim = 2;
    // Rows: exact match, orthogonal, near match.
    const vectors = Float32Array.from([1, 0, 0, 1, 0.9, 0.44]);
    const hits = topMatches(vectors, Float32Array.from([1, 0]), dim, 3);

    expect(hits[0]?.row).toBe(0);
    expect(hits[1]?.row).toBe(2);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("returns at most the limit", () => {
    const vectors = Float32Array.from([1, 0, 0.9, 0.1, 0.8, 0.2, 0.7, 0.3]);
    expect(topMatches(vectors, Float32Array.from([1, 0]), 2, 2)).toHaveLength(2);
  });

  it("drops tombstoned rows rather than ranking them last", () => {
    // A zeroed row is a deleted file's slot. Returning it as a weak match would put a
    // deleted file in the results of a query that matched nothing.
    const vectors = Float32Array.from([0, 0, 1, 0]);
    const hits = topMatches(vectors, Float32Array.from([1, 0]), 2, 5);
    expect(hits.map((h) => h.row)).toEqual([1]);
  });

  it("returns nothing when nothing matches", () => {
    const vectors = Float32Array.from([0, 1]);
    expect(topMatches(vectors, Float32Array.from([1, 0]), 2, 5)).toEqual([]);
  });
});

function stateWith(files: Record<string, { start: number; count: number }>): IndexState {
  const total = Object.values(files).reduce((sum, f) => sum + f.count, 0);
  const chunks: Chunk[] = Array.from({ length: total }, (_, i) => ({
    id: `c${i}`,
    path: "x",
    startLine: i,
    endLine: i,
    text: `t${i}`,
    contentHash: `h${i}`,
    symbol: null,
  }));

  return {
    manifest: {
      version: 1,
      model: "test",
      dim: 2,
      chunkCount: total,
      truncated: false,
      updatedAt: "now",
    },
    chunks,
    // Row i is [1, i], so a row can be identified after a move.
    vectors: Float32Array.from(chunks.flatMap((_, i) => [1, i])),
    files: Object.fromEntries(
      Object.entries(files).map(([name, f]) => [
        name,
        { mtimeMs: 1, size: 1, sha256: "s", chunkStart: f.start, chunkCount: f.count },
      ])
    ),
  };
}

describe("deleting a file", () => {
  it("zeroes its rows without moving anything else", () => {
    // A rewrite per deletion would mean rewriting 150 MB every time a file is removed.
    const state = stateWith({ "a.py": { start: 0, count: 2 }, "b.py": { start: 2, count: 2 } });
    const next = tombstone(state, "a.py", 2);

    expect([...next.vectors.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    // b.py's rows are untouched and still where `files.json` says they are.
    expect([...next.vectors.subarray(4, 8)]).toEqual([1, 2, 1, 3]);
    expect(next.files["b.py"]?.chunkStart).toBe(2);
  });

  it("stops claiming the file is indexed", () => {
    const next = tombstone(stateWith({ "a.py": { start: 0, count: 2 } }), "a.py", 2);
    expect(next.files["a.py"]).toBeUndefined();
  });

  it("does nothing for a file that was never indexed", () => {
    const state = stateWith({ "a.py": { start: 0, count: 1 } });
    expect(tombstone(state, "ghost.py", 2)).toBe(state);
  });
});

/**
 * The two ends of `forgetFile`, which was written and never called.
 *
 * `tombstone`, `needsCompaction` and `compact` were all tested directly above; `forgetFile` — the
 * six lines composing them — had no caller anywhere, so deleting a file through the file tree left
 * its chunks in the index. Not a correctness bug: `searchMemory` stats every hit and marks a vanished
 * file `stale`, and the next build drops the rows. It is a `limit` bug. `topMatches` returns the best
 * 8 rows and dead rows compete for those slots, so a deleted file's chunks push live results out of a
 * result set the caller asked for 8 of.
 *
 * It is wired to `fs:delete` now, and the assertion that matters is not that the call exists but that
 * **the two path formats agree**. `forgetFile` keys on the index's project-relative,
 * forward-slash path; the handler passes `deleteEntry`'s result. If either side ever changes, pruning
 * silently stops working — no error, no log line, just an index that quietly keeps growing.
 */
describe("pruning on delete", () => {
  it("keys on the same path form the delete handler returns", async () => {
    const { displayPathFor } = await import("../src/main/build/fsops.js");
    /**
     * Both sides derived from one root and one absolute path, rather than two hand-written strings.
     * A literal here would pass while the real functions disagreed, which is the whole failure mode.
     */
    const projectRoot = path.join(os.tmpdir(), "proj");
    const absolute = path.join(projectRoot, "src", "deep", "file.ts");

    const fromDelete = displayPathFor(projectRoot, absolute);
    const fromIndex = path.relative(projectRoot, absolute).split(path.sep).join("/");

    expect(fromDelete).toBe(fromIndex);
    // And it is the form the index actually stores — forward slashes even on Windows.
    expect(fromDelete).toBe("src/deep/file.ts");
  });

  it("is called by fs:delete, for files and not directories", () => {
    /**
     * Read from the handler rather than driven, because `fs:delete` goes through the OS trash and a
     * test that reached `shell.trashItem` would be testing Electron. The directory half is the
     * declared limitation: `forgetFile` takes one path and the index has no tree, so a directory's
     * descendants fall back to the stale flag.
     */
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main/ipc/handlers/index.ts"),
      "utf8"
    );
    const handler = /setHandler\("fs:delete"[\s\S]*?\n  \}\);/.exec(source)?.[0] ?? "";
    expect(handler, "no fs:delete handler found").not.toBe("");
    expect(handler).toContain("forgetFile(root, result.path)");
    expect(handler).toContain('result.kind === "file"');
    /**
     * And the failure is swallowed. The delete has already happened through the trash by then, so
     * rejecting would report a successful destructive action as failed — the user sees the file gone
     * and is told it did not work.
     */
    expect(handler).toMatch(/catch[\s\S]*logError/);
  });
});

describe("compaction", () => {
  it("waits until the dead weight justifies the rewrite", () => {
    const state = stateWith({ "a.py": { start: 0, count: 1 }, "b.py": { start: 1, count: 9 } });
    expect(needsCompaction(tombstone(state, "a.py", 2))).toBe(false);

    const heavy = tombstone(stateWith({ "a.py": { start: 0, count: 5 }, "b.py": { start: 5, count: 5 } }), "a.py", 2);
    expect(tombstoneFraction(heavy)).toBeCloseTo(0.5, 5);
    expect(needsCompaction(heavy)).toBe(true);
  });

  it("renumbers so every row still belongs to its chunk", () => {
    // The failure this guards is misattribution: vectors that survive a compaction pointing at
    // the wrong chunks produce confident nonsense rather than an error.
    const state = stateWith({ "a.py": { start: 0, count: 2 }, "b.py": { start: 2, count: 2 } });
    const compacted = compact(tombstone(state, "a.py", 2), 2);

    expect(compacted.chunks).toHaveLength(2);
    expect(compacted.files["b.py"]?.chunkStart).toBe(0);
    // b.py's original rows [1,2] and [1,3], now at the front.
    expect([...compacted.vectors]).toEqual([1, 2, 1, 3]);
    expect(compacted.chunks.map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});

describe("reading an index back", () => {
  it("round-trips", async () => {
    const state = stateWith({ "a.py": { start: 0, count: 2 } });
    await writeIndex(root, state);
    const read = await readIndex(root);

    expect(read?.chunks).toHaveLength(2);
    expect([...(read?.vectors ?? [])]).toEqual([1, 0, 1, 1]);
    expect(read?.files["a.py"]?.chunkCount).toBe(2);
  });

  it("refuses a vector file that does not match the chunk count", async () => {
    // A half-written index, from a crash mid-write. Answering with rows that belong to
    // different chunks than the JSONL says is worse than answering with nothing.
    const state = stateWith({ "a.py": { start: 0, count: 2 } });
    await writeIndex(root, state);
    await fs.writeFile(indexPaths(root).vectors, Buffer.alloc(4));

    expect(await readIndex(root)).toBeUndefined();
  });

  it("refuses a manifest from a version it does not know", async () => {
    const state = stateWith({ "a.py": { start: 0, count: 1 } });
    await writeIndex(root, state);
    await fs.writeFile(
      indexPaths(root).manifest,
      JSON.stringify({ ...state.manifest, version: 99 })
    );

    expect(await readIndex(root)).toBeUndefined();
  });

  it("returns nothing for a project that was never indexed", async () => {
    expect(await readIndex(root)).toBeUndefined();
  });

  it("writes inside .voidcode/index, where the user was told it would be", () => {
    expect(indexPaths(root).dir).toBe(path.join(root, ".voidcode", "index"));
  });
});

describe("choosing what to index when there is too much", () => {
  const file = (relative: string, size = 100): { absolute: string; relative: string; size: number; mtimeMs: number } => ({
    absolute: `/x/${relative}`,
    relative,
    size,
    mtimeMs: 1,
  });

  it("puts source ahead of docs and data", () => {
    // When 6,000 of 50,000 files can be indexed, *which* 6,000 is the whole question.
    const ordered = prioritise([file("notes.md"), file("data.json"), file("main.ts")]);
    expect(ordered[0]?.relative).toBe("main.ts");
  });

  it("prefers shallower files", () => {
    const ordered = prioritise([file("a/b/c/deep.ts"), file("top.ts")]);
    expect(ordered[0]?.relative).toBe("top.ts");
  });

  it("prefers smaller files at the same depth", () => {
    const ordered = prioritise([file("big.ts", 9_000), file("small.ts", 10)]);
    expect(ordered[0]?.relative).toBe("small.ts");
  });

  it("keeps unknown extensions last rather than dropping them", () => {
    const ordered = prioritise([file("thing.xyz"), file("main.ts")]);
    expect(ordered.map((f) => f.relative)).toEqual(["main.ts", "thing.xyz"]);
  });
});

describe("the dimension the manifest records", () => {
  it("matches what the embedding model produces", () => {
    // A model change has to invalidate the index: vectors from a different model are not
    // comparable, and searching them returns confident nonsense.
    expect(EMBED_DIM).toBe(768);
  });

  it("is what a stored hash is derived from", () => {
    expect(hashOf("a")).not.toBe(hashOf("b"));
    expect(hashOf("a")).toBe(hashOf("a"));
  });
});
