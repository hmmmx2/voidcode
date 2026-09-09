/**
 * Splitting a file into pieces small enough to embed and large enough to mean something.
 *
 * Line windows rather than a syntax-aware split. A real one needs a parser per language, and
 * the languages this has to cover are whatever the user opened — so the choice is between a
 * good split for five languages and an adequate split for all of them.
 *
 * Two decisions worth stating:
 *
 *   **Overlap.** Windows share a few lines with their neighbours, so a function that straddles
 *   a boundary appears whole in one of them. Without it, the single most useful thing to
 *   retrieve — a definition and its body — is reliably cut in half.
 *
 *   **Line numbers travel with the text.** A hit has to be openable, and "somewhere in this
 *   file" is not a result. Everything downstream keys on `startLine`.
 *
 * Pure, so the boundaries can be tested without a filesystem or a model.
 */
import { createHash } from "node:crypto";

export interface Chunk {
  /** Stable across reindexing: same file, same position, same text ⇒ same id. */
  id: string;
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
  /** A cheap guess at the enclosing definition, when the language makes one visible. */
  symbol: string | null;
}

/**
 * Roughly 40 lines of code, which is a function or two.
 *
 * Larger dilutes the embedding — a vector for 200 lines is a vector for nothing in particular.
 * Smaller retrieves fragments with no context around them.
 */
const LINES_PER_CHUNK = 40;

/** Enough to carry a signature and its opening lines across a boundary. */
const OVERLAP_LINES = 8;

/**
 * A single line longer than this is minified output or embedded data.
 *
 * Files made of them are skipped rather than chunked: a 200KB single line produces one
 * meaningless embedding and costs more than the rest of the project put together.
 */
const MAX_LINE_LENGTH = 2_000;

/** Definition-ish lines, in the languages this project actually contains. */
const SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,
];

/** The last definition at or before a line — what a reader would call "where am I". */
function symbolFor(lines: readonly string[], upto: number): string | null {
  for (let i = upto; i >= 0; i--) {
    const line = lines[i] ?? "";
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return null;
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** True for content that is not worth embedding at all. */
export function isUnchunkable(contents: string): boolean {
  if (contents.trim() === "") return true;
  // A NUL byte in the first chunk is the cheap standard test for "not text" — the same one
  // `search.ts` uses, for the same reason.
  if (contents.slice(0, 8_000).includes("\0")) return true;

  const lines = contents.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  // Minified or generated. One useless vector at a disproportionate cost.
  return longest > MAX_LINE_LENGTH && lines.length < 50;
}

export function chunkFile(path: string, contents: string): Chunk[] {
  if (isUnchunkable(contents)) return [];

  const lines = contents.split("\n");
  const chunks: Chunk[] = [];
  const step = LINES_PER_CHUNK - OVERLAP_LINES;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + LINES_PER_CHUNK, lines.length);
    const text = lines.slice(start, end).join("\n");

    // Whitespace-only windows happen at the end of files with trailing blank lines, and
    // embedding them wastes a call to produce a vector nothing should ever match.
    if (text.trim() !== "") {
      const contentHash = hashOf(text);
      chunks.push({
        // Position and content, so the id is stable across a reindex that did not change the
        // file — and different the moment the text does, which is what makes a tombstone
        // sweep able to tell replacement from reordering.
        id: hashOf(`${path}:${start + 1}:${contentHash}`),
        path,
        startLine: start + 1,
        endLine: end,
        text,
        contentHash,
        symbol: symbolFor(lines, start),
      });
    }

    // The last window reaches the end; stepping again would produce a duplicate tail.
    if (end === lines.length) break;
  }

  return chunks;
}
