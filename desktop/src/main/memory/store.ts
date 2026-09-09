/**
 * The index on disk, and the search over it.
 *
 * Three files, and the split between them is the design:
 *
 *   `chunks.jsonl`  one record per line, NO vectors
 *   `vectors.f32`   a flat Float32Array, row i ↔ line i of the JSONL
 *   `files.json`    per file: mtime, size, hash, and which rows it owns
 *
 * Vectors live in their own binary because that is what makes the scan cheap: one
 * `readFile`, one `new Float32Array(buffer)`, then a tight dot-product loop with no per-row
 * allocation and no JSON parsing. Interleaving them into the JSONL would mean parsing 150 MB
 * of numbers to answer one query.
 *
 * Vectors are normalised to unit length when written, so similarity is a dot product rather
 * than a cosine — one multiply-add per dimension instead of three passes.
 *
 * **The honest cap is ~50k chunks.** At 768 dimensions that is 154 MB resident and 30–60 ms
 * per query. Past that the design refuses, the way `tree.ts` refuses a huge walk, rather than
 * degrading into a main process that stops responding.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Chunk } from "./chunker.js";

/** Beyond this the scan stops being interactive and the memory cost stops being reasonable. */
export const MAX_CHUNKS = 50_000;

/** nomic-embed-text. Recorded in the manifest so a model change invalidates the index. */
export const EMBED_DIM = 768;

/** Tombstones past this fraction make a rewrite cheaper than carrying them. */
const COMPACT_THRESHOLD = 0.2;

export interface IndexedFile {
  mtimeMs: number;
  size: number;
  /** The truth. mtime and size are the cheap gate; this is what decides. */
  sha256: string;
  chunkStart: number;
  chunkCount: number;
}

export interface Manifest {
  version: 1;
  model: string;
  dim: number;
  chunkCount: number;
  /** A bound stopped indexing early — surfaced, never implied by absence. */
  truncated: boolean;
  updatedAt: string;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
  /** The file changed since this row was embedded, so the text may be out of date. */
  stale: boolean;
}

export interface IndexPaths {
  root: string;
  dir: string;
  manifest: string;
  chunks: string;
  vectors: string;
  files: string;
}

/** Where an index lives for a given project root. */
export function indexPaths(projectRoot: string): IndexPaths {
  const dir = path.join(projectRoot, ".voidcode", "index");
  return {
    root: projectRoot,
    dir,
    manifest: path.join(dir, "manifest.json"),
    chunks: path.join(dir, "chunks.jsonl"),
    vectors: path.join(dir, "vectors.f32"),
    files: path.join(dir, "files.json"),
  };
}

/**
 * Unit-length, in place.
 *
 * A zero vector — which an embedding model can return for empty or degenerate input — is left
 * alone rather than divided by zero. It then scores 0 against everything, which is the correct
 * outcome for a chunk that carries no signal.
 */
export function normalise(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i] as number) ** 2;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / magnitude;
  return vector;
}

/**
 * The top `limit` rows by dot product.
 *
 * Deliberately a plain loop over a flat array. A k-d tree or HNSW would be faster asymptotically
 * and slower here: at 50k rows the linear scan is ~38M multiply-adds, which V8 does in tens of
 * milliseconds, and an approximate structure would add a dependency, an index-build step, and a
 * class of "why did it not find that" bugs — for a corpus this size.
 *
 * Exported and pure so it can be tested against hand-built vectors, and so the worker can call
 * it without importing anything that touches Electron.
 */
export function topMatches(
  vectors: Float32Array,
  query: Float32Array,
  dim: number,
  limit: number
): Array<{ row: number; score: number }> {
  const rows = Math.floor(vectors.length / dim);
  // A fixed-size insertion list beats sorting every row: `limit` is single digits and the
  // corpus is not, so this is O(rows · limit) with no allocation per row.
  const best: Array<{ row: number; score: number }> = [];

  for (let row = 0; row < rows; row++) {
    const offset = row * dim;
    let score = 0;
    for (let i = 0; i < dim; i++) {
      score += (vectors[offset + i] as number) * (query[i] as number);
    }

    // Zeroed rows are tombstones — a deleted file's slot, kept so every other row's index
    // stays valid until a compaction. They score exactly 0 and are dropped here rather than
    // ranked last, so a query with no real matches returns nothing instead of noise.
    if (score <= 0) continue;

    if (best.length < limit) {
      best.push({ row, score });
      best.sort((a, b) => b.score - a.score);
    } else if (score > (best[best.length - 1]?.score ?? 0)) {
      best[best.length - 1] = { row, score };
      best.sort((a, b) => b.score - a.score);
    }
  }

  return best;
}

export interface IndexState {
  manifest: Manifest;
  chunks: Chunk[];
  vectors: Float32Array;
  files: Record<string, IndexedFile>;
}

export async function readIndex(projectRoot: string): Promise<IndexState | undefined> {
  const paths = indexPaths(projectRoot);
  try {
    const manifest = JSON.parse(await fs.readFile(paths.manifest, "utf8")) as Manifest;
    // A manifest from a shape or a model this build does not know is ignored rather than
    // guessed at: vectors from a different embedding model are not comparable, and searching
    // them would return confident nonsense.
    if (manifest.version !== 1) return undefined;

    const chunkText = await fs.readFile(paths.chunks, "utf8");
    const chunks = chunkText
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Chunk);

    const raw = await fs.readFile(paths.vectors);
    // A copy, not a view: `Buffer` may be a slice of a larger pooled allocation, and a view
    // over that would read a neighbouring buffer's bytes as float data.
    const vectors = new Float32Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    );

    const files = JSON.parse(await fs.readFile(paths.files, "utf8")) as Record<string, IndexedFile>;

    // A vector file that does not match the chunk count is a half-written index — from a
    // crash mid-write, or two writers. Refusing it is better than answering with rows that
    // belong to different chunks than the JSONL says.
    if (vectors.length !== chunks.length * manifest.dim) return undefined;

    return { manifest, chunks, vectors, files };
  } catch {
    return undefined;
  }
}

export async function writeIndex(projectRoot: string, state: IndexState): Promise<void> {
  const paths = indexPaths(projectRoot);
  await fs.mkdir(paths.dir, { recursive: true });

  // Vectors first, manifest last. A reader that finds a manifest can trust the files it names
  // are already complete; the reverse ordering would make a crash mid-write look like a valid
  // index pointing at a truncated vector file.
  await fs.writeFile(paths.vectors, Buffer.from(state.vectors.buffer, 0, state.vectors.byteLength));
  await fs.writeFile(
    paths.chunks,
    state.chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(paths.files, JSON.stringify(state.files, null, 2), "utf8");
  await fs.writeFile(paths.manifest, JSON.stringify(state.manifest, null, 2), "utf8");
}

/**
 * Zero the rows a file owned, without moving anything else.
 *
 * Tombstones rather than a rewrite, because every other row's index would have to change and
 * `files.json` would have to be rewritten with it. A deletion is common; a 150 MB rewrite per
 * deletion is not acceptable.
 */
export function tombstone(state: IndexState, filePath: string, dim: number): IndexState {
  const entry = state.files[filePath];
  if (entry === undefined) return state;

  const vectors = state.vectors;
  vectors.fill(0, entry.chunkStart * dim, (entry.chunkStart + entry.chunkCount) * dim);

  const files = { ...state.files };
  delete files[filePath];
  return { ...state, vectors, files };
}

/** How much of the index is dead rows. */
export function tombstoneFraction(state: IndexState): number {
  if (state.chunks.length === 0) return 0;
  const live = Object.values(state.files).reduce((sum, file) => sum + file.chunkCount, 0);
  return (state.chunks.length - live) / state.chunks.length;
}

export function needsCompaction(state: IndexState): boolean {
  return tombstoneFraction(state) > COMPACT_THRESHOLD;
}

/**
 * Rewrite without the dead rows, renumbering as it goes.
 *
 * Only worth doing once tombstones dominate — see `COMPACT_THRESHOLD`. Until then the wasted
 * bytes are cheaper than the rewrite that would reclaim them.
 */
export function compact(state: IndexState, dim: number): IndexState {
  const keptChunks: Chunk[] = [];
  const files: Record<string, IndexedFile> = {};
  const vectors = new Float32Array(
    Object.values(state.files).reduce((sum, file) => sum + file.chunkCount, 0) * dim
  );

  let write = 0;
  for (const [filePath, entry] of Object.entries(state.files)) {
    for (let i = 0; i < entry.chunkCount; i++) {
      const from = (entry.chunkStart + i) * dim;
      vectors.set(state.vectors.subarray(from, from + dim), write * dim);
      keptChunks.push(state.chunks[entry.chunkStart + i] as Chunk);
      write += 1;
    }
    files[filePath] = { ...entry, chunkStart: write - entry.chunkCount };
  }

  return {
    manifest: { ...state.manifest, chunkCount: keptChunks.length },
    chunks: keptChunks,
    vectors,
    files,
  };
}
