/**
 * Find in Files.
 *
 * Plain text, not regex, and that is a decision rather than a shortcut: a regex from the
 * renderer is a denial-of-service surface — `(a+)+$` against a long line will hang the main
 * process, and catastrophic backtracking is very easy to write by accident. If regex search is
 * ever wanted it needs a timeout and a bounded engine, which is its own piece of work.
 *
 * Bounded the way `tree.ts` is bounded, and for the same reason: a project can contain a
 * gigabyte of vendored code, and an unbounded walk means the app stops responding while
 * someone waits for a result they will not read.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { currentProjectRoot } from "../workspace.js";

export interface SearchMatch {
  /** Project-relative, forward slashes — the same form `fs:read` takes back. */
  path: string;
  line: number;
  /** The whole line, trimmed and clipped, so the UI has context without reading the file. */
  preview: string;
  column: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when a bound stopped the search early, so the UI can say "showing the first N". */
  truncated: boolean;
  filesSearched: number;
}

/**
 * The same skip list as the file tree, for the same reason: `node_modules` is not what anyone
 * means by "search my project", and walking it is most of the cost.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  ".cache",
  "coverage",
  ".turbo",
  ".idea",
  ".vscode",
]);

const MAX_MATCHES = 500;
const MAX_FILES = 5_000;
const MAX_DEPTH = 12;

/**
 * Files larger than this are skipped.
 *
 * A 2 MB source file is either generated or a data blob; either way the matches in it are not
 * what anyone is looking for, and reading a 200 MB CSV into memory to grep it is how a search
 * takes the process down.
 */
const MAX_FILE_BYTES = 2_000_000;

/** Enough context to recognise the line, short enough that the panel stays a list. */
const MAX_PREVIEW = 200;

export class NoProjectError extends Error {
  constructor() {
    super("No project is open");
    this.name = "NoProjectError";
  }
}

export async function searchInFiles(
  sender: WebContents,
  query: string,
  options: { caseSensitive?: boolean; signal?: AbortSignal } = {}
): Promise<SearchResult> {
  const root = currentProjectRoot(sender);
  if (root === undefined) throw new NoProjectError();

  const needle = options.caseSensitive === true ? query : query.toLowerCase();
  // An empty query would match every line of every file — the most expensive possible way to
  // return nothing useful.
  if (needle.trim() === "") return { matches: [], truncated: false, filesSearched: 0 };

  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let truncated = false;

  /**
   * Checked in the same place as `truncated`, because it means the same thing to this walk:
   * stop descending and return what there is.
   *
   * A search over a large project is seconds of I/O, and Stop closing the port has to reach
   * it. Without this the walk runs to completion after the run is already over — the user sees
   * the panel go idle while the disk keeps working.
   *
   * **One check, in the loop, not two.** A second at the top of `walk` looks like belt and
   * braces and is dead: every recursive call is made from inside the loop, which has already
   * checked, so removing it changes nothing a test can observe. It was written first and
   * deleted once mutation testing showed no assertion could tell it from its absence. An
   * untested guard is one somebody later "fixes" in the wrong direction.
   */
  const stopped = (): boolean => options.signal?.aborted === true;

  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || truncated) return;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory — permissions, or it vanished mid-walk. Skip rather than fail
      // the whole search for one folder.
      return;
    }

    for (const entry of entries) {
      // Per entry rather than per directory: a flat folder of ten thousand files is one
      // `walk` call, so a check only at the top would never fire inside it.
      if (truncated || stopped()) return;

      const child = path.join(directory, entry.name);
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        // Symlinked directories are not followed, matching `tree.ts`: a link inside the
        // project could otherwise walk the whole filesystem, or loop forever.
        if (entry.isSymbolicLink()) continue;
        await walk(child, childRelative, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      if (filesSearched >= MAX_FILES) {
        truncated = true;
        return;
      }

      let stat;
      try {
        stat = await fs.stat(child);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let contents: string;
      try {
        contents = await fs.readFile(child, "utf8");
      } catch {
        continue;
      }
      filesSearched += 1;

      // A NUL byte in the first chunk is the cheap, standard test for "this is not text".
      // Without it, a search reports thousands of matches inside binaries.
      if (contents.slice(0, 8_000).includes("\0")) continue;

      const lines = contents.split("\n");
      for (const [index, line] of lines.entries()) {
        const haystack = options.caseSensitive === true ? line : line.toLowerCase();
        const column = haystack.indexOf(needle);
        if (column === -1) continue;

        matches.push({
          path: childRelative,
          line: index + 1,
          column: column + 1,
          preview: line.trim().slice(0, MAX_PREVIEW),
        });

        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          return;
        }
        // No `break` here. One `indexOf` per line already gives one result per line — a line
        // containing the needle twice is one result to a reader — and breaking would leave
        // the *file* after its first hit, which is a different and much wronger rule.
      }
    }
  }

  await walk(root, "", 0);
  return { matches, truncated, filesSearched };
}
