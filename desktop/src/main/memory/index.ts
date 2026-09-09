/**
 * Building and querying a project's memory.
 *
 * The pieces around this are the interesting ones — chunking, the flat vector store, the
 * gitignore reader. This is the part that decides *what gets indexed*, and its whole job is
 * refusing to do too much:
 *
 *   **Never at project-open.** Indexing is an explicit action. A folder-picker that quietly
 *   starts reading six thousand files and running a model over them is not something anyone
 *   asked for, and on a monorepo it would look like the app had hung.
 *
 *   **Bounded, and honest about it.** `MAX_INDEX_FILES` and `MAX_CHUNKS` are caps, not
 *   targets. When one is hit the manifest says `truncated` and the UI says so — the way
 *   `tree.ts` reports a truncated walk rather than implying it listed everything.
 *
 *   **Scoped indexing is a first-class affordance, not a fallback.** On a large repository
 *   "index this folder" is the only sane workflow, and it is the same code path with a
 *   different starting directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { chunkFile, hashOf, type Chunk } from "./chunker.js";
import { parseGitignore, isIgnored, type IgnoreRule } from "./gitignore.js";
import { embedAll, embeddingsAvailable, EMBED_MODEL, EmbeddingsUnavailableError } from "./embed.js";
import {
  readIndex,
  writeIndex,
  normalise,
  topMatches,
  tombstone,
  needsCompaction,
  compact,
  indexPaths,
  EMBED_DIM,
  MAX_CHUNKS,
  type IndexState,
  type IndexedFile,
  type SearchHit,
} from "./store.js";
import { consentFor, requestMemoryConsent } from "./consent.js";

/**
 * Files, not chunks.
 *
 * A 50k-file monorepo is ~400k chunks and hours of embedding — so the honest answer there is
 * "index a folder", not "wait". This cap is what makes that answer arrive in seconds instead
 * of after a long silence.
 */
export const MAX_INDEX_FILES = 6_000;

/** Larger than this is generated, vendored, or data. Reading it wastes the budget. */
const MAX_FILE_BYTES = 512 * 1024;

/** The same list `tree.ts` and `search.ts` use, for the same reason. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "target",
  ".idea",
  ".voidcode",
]);

/**
 * Extensions worth embedding, in priority order.
 *
 * An allowlist rather than a denylist: a project contains far more kinds of file than kinds of
 * *source*, and embedding a lockfile or a CSV produces vectors that match everything weakly and
 * nothing usefully.
 */
const SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb", ".php", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".swift", ".kt", ".scala", ".sh", ".sql", ".md", ".toml", ".yaml",
  ".yml", ".json", ".css", ".html",
];

export interface IndexCandidate {
  absolute: string;
  relative: string;
  size: number;
  mtimeMs: number;
}

/**
 * Which files to index, best first.
 *
 * The ordering is what makes the cap defensible: when 6,000 of 50,000 files can be indexed,
 * *which* 6,000 matters. Source before docs, shallower before deeper, smaller before larger —
 * a heuristic for "closest to what someone would search for".
 */
export function prioritise(candidates: readonly IndexCandidate[]): IndexCandidate[] {
  const rank = (file: IndexCandidate): number => {
    const extension = path.extname(file.relative).toLowerCase();
    const position = SOURCE_EXTENSIONS.indexOf(extension);
    return position === -1 ? SOURCE_EXTENSIONS.length : position;
  };

  return [...candidates].sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    const byDepth = a.relative.split("/").length - b.relative.split("/").length;
    if (byDepth !== 0) return byDepth;
    return a.size - b.size;
  });
}

async function collect(root: string, scope: string): Promise<IndexCandidate[]> {
  let rules: IgnoreRule[] = [];
  try {
    rules = parseGitignore(await fs.readFile(path.join(root, ".gitignore"), "utf8"));
  } catch {
    // No `.gitignore`, or the folder is not a repository at all. The skip list still applies.
  }

  const found: IndexCandidate[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        // Symlinked directories are not followed — the same rule `tree.ts` states, and for the
        // same two reasons: a link could enumerate the whole filesystem, and `ln -s . loop`
        // would never terminate.
        if (entry.isSymbolicLink()) continue;
        if (isIgnored(rules, relative, true)) continue;
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      if (isIgnored(rules, relative)) continue;

      try {
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_BYTES) continue;
        found.push({ absolute, relative, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Vanished between the listing and the stat.
      }
    }
  }

  await walk(scope);
  return found;
}

export interface IndexProgress {
  phase: "scanning" | "embedding" | "writing";
  done: number;
  total: number;
}

export interface IndexResult {
  indexed: number;
  chunks: number;
  truncated: boolean;
  skipped: number;
}

export interface IndexOptions {
  sender: WebContents;
  projectRoot: string;
  /** A subdirectory to index instead of the whole project. Absolute. */
  scope?: string;
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
}

export class MemoryConsentDeclined extends Error {
  constructor() {
    super("Indexing was declined for this project");
    this.name = "MemoryConsentDeclined";
  }
}

/**
 * Build or refresh the index.
 *
 * Incremental by default: a file whose mtime, size *and* hash all match is skipped. mtime and
 * size are the cheap gate; the hash is what actually decides, because a checkout can restore a
 * file with a new mtime and identical contents, and re-embedding thousands of unchanged files
 * because git touched them is the difference between a two-second refresh and a two-minute one.
 */
export async function buildIndex(options: IndexOptions): Promise<IndexResult> {
  const { sender, projectRoot, scope = projectRoot, onProgress, signal } = options;

  if (!(await embeddingsAvailable())) {
    throw new EmbeddingsUnavailableError(
      `The embedding model "${EMBED_MODEL}" is not installed. Pull it in Ollama first.`
    );
  }

  onProgress?.({ phase: "scanning", done: 0, total: 0 });
  const all = await collect(projectRoot, scope);
  const prioritised = prioritise(all);
  const selected = prioritised.slice(0, MAX_INDEX_FILES);
  const truncatedByFiles = prioritised.length > MAX_INDEX_FILES;

  // Asked after the scan, so the prompt can say how many files and roughly how much disk —
  // agreeing to "index this project" without either is agreeing to something unspecified.
  if (consentFor(projectRoot) !== "granted") {
    const granted = await requestMemoryConsent({
      sender,
      projectRoot,
      fileCount: selected.length,
      // ~8 chunks a file at 3 KB a vector, plus the JSONL. Rounded up, because a low estimate
      // is the one that feels like a lie afterwards.
      estimatedMB: Math.max(1, Math.ceil((selected.length * 8 * 3.5) / 1024)),
    });
    if (!granted) throw new MemoryConsentDeclined();
  }

  const existing = await readIndex(projectRoot);
  const previousFiles = existing?.files ?? {};

  const fresh: Array<{ file: IndexCandidate; chunks: Chunk[] }> = [];
  const unchanged: string[] = [];

  for (const file of selected) {
    const previous = previousFiles[file.relative];
    if (
      previous !== undefined &&
      previous.mtimeMs === file.mtimeMs &&
      previous.size === file.size
    ) {
      unchanged.push(file.relative);
      continue;
    }

    let contents: string;
    try {
      contents = await fs.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }

    // The hash is the truth. A checkout that restored identical contents with a new mtime
    // would otherwise re-embed the whole project.
    if (previous !== undefined && previous.sha256 === hashOf(contents)) {
      unchanged.push(file.relative);
      continue;
    }

    const chunks = chunkFile(file.relative, contents);
    if (chunks.length > 0) fresh.push({ file, chunks });
  }

  // Nothing changed: keep what is there rather than rewriting an identical index.
  if (fresh.length === 0 && existing !== undefined) {
    return {
      indexed: unchanged.length,
      chunks: existing.chunks.length,
      truncated: existing.manifest.truncated,
      skipped: all.length - selected.length,
    };
  }

  const texts = fresh.flatMap((entry) => entry.chunks.map((chunk) => chunk.text));
  const capped = texts.slice(0, MAX_CHUNKS);
  const truncatedByChunks = texts.length > MAX_CHUNKS;

  onProgress?.({ phase: "embedding", done: 0, total: capped.length });
  const raw = await embedAll(
    capped,
    (progress) => onProgress?.({ phase: "embedding", ...progress }),
    signal
  );

  // Rebuilt rather than merged. A merge has to reconcile row offsets across a partial reindex,
  // and getting that wrong misattributes vectors to chunks — a failure that produces confident
  // nonsense rather than an error. Rebuilding is O(project) on a path the user invoked
  // explicitly, which is the right trade.
  const chunks: Chunk[] = [];
  const files: Record<string, IndexedFile> = {};
  const vectors = new Float32Array(Math.min(raw.length, capped.length) * EMBED_DIM);

  let row = 0;
  for (const entry of fresh) {
    const start = row;
    for (const chunk of entry.chunks) {
      if (row >= raw.length) break;
      const vector = normalise(Float32Array.from(raw[row] as number[]));
      vectors.set(vector, row * EMBED_DIM);
      chunks.push(chunk);
      row += 1;
    }
    if (row > start) {
      files[entry.file.relative] = {
        mtimeMs: entry.file.mtimeMs,
        size: entry.file.size,
        sha256: hashOf(entry.chunks.map((c) => c.text).join("\n")),
        chunkStart: start,
        chunkCount: row - start,
      };
    }
  }

  onProgress?.({ phase: "writing", done: row, total: row });
  await writeIndex(projectRoot, {
    manifest: {
      version: 1,
      model: EMBED_MODEL,
      dim: EMBED_DIM,
      chunkCount: chunks.length,
      truncated: truncatedByFiles || truncatedByChunks,
      updatedAt: new Date().toISOString(),
    },
    chunks,
    vectors,
    files,
  });

  return {
    indexed: fresh.length,
    chunks: chunks.length,
    truncated: truncatedByFiles || truncatedByChunks,
    skipped: all.length - selected.length,
  };
}

/**
 * Drop a file's rows after it is deleted, compacting once the dead weight justifies it.
 *
 * ── WHAT THIS IS AND IS NOT FOR ───────────────────────────────────────────────────────────────
 *
 * Not a correctness fix. `searchMemory` already stats every hit's file and marks a vanished one
 * `stale` — "gone since indexing, stale in the strongest sense" — and the next `buildIndex` drops
 * the rows wholesale. So an unpruned index is never *wrong*.
 *
 * It is a quality fix, and the reason is `limit`. `topMatches` returns the best 8 rows by cosine
 * distance and dead rows compete for those slots on equal terms, so a deleted file's chunks push
 * live results out of a result set the caller asked for 8 of. Marking them stale is honest but the
 * answer is still shorter than it should be.
 *
 * `relative` must be in the index's own path form: project-relative, forward slashes, as produced
 * by `path.relative(root, absolute).split(path.sep).join("/")`. `build/fsops.ts`'s `displayPathFor`
 * produces exactly that, which is what makes the `fs:delete` handler able to pass its result
 * straight through. If either side ever changes, this prunes nothing and says nothing — so the
 * agreement is asserted in `tests/memory-index.test.ts` rather than left to this paragraph.
 *
 * **Files only.** Deleting a directory leaves its descendants' rows behind, because the caller has
 * one path and the index has no tree. Those fall back to the stale flag and the next rebuild, which
 * is the pre-existing behaviour for everything. Declared rather than silently half-done.
 */
export async function forgetFile(projectRoot: string, relative: string): Promise<void> {
  const state = await readIndex(projectRoot);
  if (state === undefined) return;

  let next = tombstone(state, relative, state.manifest.dim);
  if (needsCompaction(next)) next = compact(next, next.manifest.dim);
  await writeIndex(projectRoot, next);
}

export interface MemoryStatus {
  indexed: boolean;
  consent: ReturnType<typeof consentFor>;
  chunkCount: number;
  fileCount: number;
  truncated: boolean;
  updatedAt: string | null;
  embeddingsAvailable: boolean;
  /** Where the index lives, so the UI can name it rather than describe it. */
  location: string;
}

export async function memoryStatus(projectRoot: string): Promise<MemoryStatus> {
  const state = await readIndex(projectRoot);
  return {
    indexed: state !== undefined,
    consent: consentFor(projectRoot),
    chunkCount: state?.chunks.length ?? 0,
    fileCount: Object.keys(state?.files ?? {}).length,
    truncated: state?.manifest.truncated ?? false,
    updatedAt: state?.manifest.updatedAt ?? null,
    embeddingsAvailable: await embeddingsAvailable(),
    location: indexPaths(projectRoot).dir,
  };
}

/**
 * Search the index.
 *
 * Staleness is reported rather than hidden: a file whose mtime or size has moved since it was
 * embedded may no longer contain what the chunk says. Returning it silently would make the
 * memory occasionally, invisibly wrong — which is worse than a result that admits it.
 */
export async function searchMemory(
  projectRoot: string,
  query: string,
  limit = 8
): Promise<SearchHit[]> {
  const state = await readIndex(projectRoot);
  if (state === undefined || state.chunks.length === 0) return [];

  const [embedding] = await embedAll([query]);
  if (embedding === undefined) return [];

  const queryVector = normalise(Float32Array.from(embedding));
  const matches = topMatches(state.vectors, queryVector, state.manifest.dim, limit);

  const hits: SearchHit[] = [];
  for (const match of matches) {
    const chunk = state.chunks[match.row];
    if (chunk === undefined) continue;

    const recorded = state.files[chunk.path];
    let stale = false;
    try {
      const stat = await fs.stat(path.join(projectRoot, chunk.path));
      stale = recorded === undefined || stat.mtimeMs !== recorded.mtimeMs || stat.size !== recorded.size;
    } catch {
      // Gone since indexing. Stale in the strongest sense.
      stale = true;
    }

    hits.push({ chunk, score: match.score, stale });
  }

  return hits;
}
