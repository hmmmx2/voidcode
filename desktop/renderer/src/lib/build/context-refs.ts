/**
 * Turning "@ this folder" into text the model actually receives.
 *
 * A folder reference is the one place in this app where a single click can mean four hundred
 * files. Something has to stop, and the whole design question is what the user is told when it
 * does. This repo surfaces truncation everywhere it happens — `BuildProjectTree.truncated`,
 * `fs.search`, `CommandResult.truncated`, the Output ring buffer's `dropped` — and a folder that
 * quietly sent twelve of four hundred would be the one place it did not.
 *
 * So the result is three lists, not one: what went in, what did not, and whether a cap was the
 * reason. "12 files, 3 skipped" is a different sentence from "12 files, and there were more".
 *
 * **The byte cap is a budget across the whole expansion, not a limit per file.** Capping each
 * file at 200 KB and then sending twenty of them is a 4 MB prompt — which is the failure this
 * exists to prevent, and the mutation the tests are written around.
 *
 * Pure, and structurally typed. It takes a `read` callback rather than the host so a test needs
 * no IPC; and it declares the tree shape it needs rather than importing `BuildProjectTree` from
 * `host.d.ts`, because that is renderer-ambient and pulling it into a test drags `window.host`
 * into the main tsconfig, which does not have it.
 */

/** The part of the project tree this needs. `BuildTreeNode` satisfies it. */
export interface RefTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: RefTreeNode[];
}

export interface RefTree {
  entries: RefTreeNode[];
}

export type ContextRef =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

/** Why a file that was asked for did not go in. Shown to the user, so it reads as prose. */
export type SkipReason = "binary" | "too large" | "budget" | "unreadable";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface IncludedFile {
  path: string;
  contents: string;
}

export interface Expansion {
  included: IncludedFile[];
  skipped: SkippedFile[];
  /**
   * A cap stopped the walk, so there were files it never even looked at.
   *
   * Distinct from a non-empty `skipped`: one file being binary is not the same as forty files
   * never being considered, and the sentence shown differs.
   */
  truncated: boolean;
}

export interface RefLimits {
  /** Across the whole expansion, not per file. */
  maxBytes: number;
  maxFiles: number;
}

/**
 * Roughly a hundred pages of prose, or a few thousand lines of code.
 *
 * Large enough that a folder of source is genuinely useful, small enough that it cannot silently
 * become most of a context window. Both numbers are deliberately modest: the failure mode of too
 * small is a visible "3 skipped" the user can act on, and the failure mode of too large is a
 * request that is slow, expensive and worse at answering.
 */
export const DEFAULT_REF_LIMITS: RefLimits = {
  maxBytes: 200 * 1024,
  maxFiles: 25,
};

/**
 * Extensions never worth sending.
 *
 * Checked before reading, so a 40 MB video is skipped without being pulled through IPC first.
 * A content check follows for anything that gets past this — an extension is a hint, not a fact.
 */
const BINARY_EXTENSIONS: readonly string[] = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svgz",
  "pdf", "zip", "gz", "tar", "bz2", "xz", "7z", "rar",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv", "flac",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin", "wasm", "class", "o", "a",
  "db", "sqlite", "sqlite3", "pyc", "pyo", "lock",
];

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function looksBinaryByName(path: string): boolean {
  return BINARY_EXTENSIONS.includes(extensionOf(path));
}

/**
 * A NUL byte in the first few KB.
 *
 * The same heuristic `git` uses, and it catches the cases an extension list cannot: a `.dat`, a
 * file with no extension at all, a `.log` that turns out to be a core dump.
 */
export function looksBinaryByContent(contents: string): boolean {
  // Scanned by char code rather than searching for a NUL literal: a raw NUL in this source file
  // is invisible in a diff, survives copy-paste badly, and makes the file read as binary to grep.
  const limit = Math.min(contents.length, 8_000);
  for (let i = 0; i < limit; i += 1) {
    if (contents.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Find a node by path, so a folder reference can be expanded against the tree already fetched. */
function findNode(tree: RefTree, path: string): RefTreeNode | null {
  const walk = (nodes: readonly RefTreeNode[]): RefTreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const hit = node.children === undefined ? null : walk(node.children);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(tree.entries);
}

/** Every file under a node, depth-first, in tree order. */
function filesUnder(node: RefTreeNode): string[] {
  if (node.kind === "file") return [node.path];
  return (node.children ?? []).flatMap(filesUnder);
}

/**
 * The files a set of references names, in order, without duplicates.
 *
 * Order is the order the user added them, and within a folder it is tree order — so "the first
 * 25" is a sentence that means something rather than an arbitrary subset.
 */
export function candidatesFor(tree: RefTree, refs: readonly ContextRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const ref of refs) {
    const paths =
      ref.kind === "file" ? [ref.path] : (() => {
        const node = findNode(tree, ref.path);
        return node === null ? [] : filesUnder(node);
      })();

    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Read what fits, and say what did not.
 *
 * Stops reading once the budget is spent rather than reading everything and discarding — a
 * folder of four hundred files should not cost four hundred IPC round trips to send twelve.
 */
export async function expandRefs(
  tree: RefTree,
  refs: readonly ContextRef[],
  read: (path: string) => Promise<string>,
  limits: RefLimits = DEFAULT_REF_LIMITS
): Promise<Expansion> {
  const candidates = candidatesFor(tree, refs);
  const included: IncludedFile[] = [];
  const skipped: SkippedFile[] = [];
  let budget = limits.maxBytes;
  let truncated = false;

  for (const [index, path] of candidates.entries()) {
    // The count cap and the byte budget both mean "there is more than this" rather than "this
    // one file was unsuitable", which is what `truncated` records.
    if (included.length >= limits.maxFiles || budget <= 0) {
      truncated = true;
      break;
    }
    if (looksBinaryByName(path)) {
      skipped.push({ path, reason: "binary" });
      continue;
    }

    let contents: string;
    try {
      contents = await read(path);
    } catch {
      // A file in the tree that cannot be read is normal: deleted since the walk, or permissions.
      skipped.push({ path, reason: "unreadable" });
      continue;
    }

    if (looksBinaryByContent(contents)) {
      skipped.push({ path, reason: "binary" });
      continue;
    }

    const size = contents.length;
    if (size > limits.maxBytes) {
      // Too big for the budget even on its own, so no ordering of the list would let it in.
      // Named separately from "budget" because the user can act on it — open it instead.
      skipped.push({ path, reason: "too large" });
      continue;
    }
    if (size > budget) {
      /**
       * It would fit an empty budget but not what is left, so this is where the walk ends.
       *
       * Continuing to look for smaller files that still fit would pack the budget tighter, and
       * it would also mean reading every remaining file to reject almost all of them — four
       * hundred IPC round trips to add one more. Stopping keeps the cost proportional and keeps
       * "the first N, in order" true, which is the sentence the summary makes.
       */
      skipped.push({ path, reason: "budget" });
      truncated = true;
      break;
    }

    included.push({ path, contents });
    budget -= size;
  }

  return { included, skipped, truncated };
}

/**
 * The line above the composer.
 *
 * Written as a sentence rather than a count because "12 files" alone invites the assumption that
 * twelve was all there was.
 */
export function summarise(expansion: Expansion): string {
  const files = expansion.included.length;
  const parts = [`${files} ${files === 1 ? "file" : "files"}`];

  if (expansion.skipped.length > 0) {
    // Grouped by reason, most common first, so the sentence stays short with many skips.
    const byReason = new Map<SkipReason, number>();
    for (const skip of expansion.skipped) {
      byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
    }
    const reasons = [...byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    parts.push(`${expansion.skipped.length} skipped (${reasons})`);
  }

  if (expansion.truncated) parts.push("more not included");
  return parts.join(" · ");
}

// ── Dragging ────────────────────────────────────────────────────────────────────────────────

/**
 * The type an internal drag carries.
 *
 * A drag from the file tree knows the project-relative path exactly, so it travels as one. A
 * drop from the operating system does not and cannot — see `droppedTextName` below.
 */
export const REF_MIME = "application/x-voidcode-path";

export function encodeRefDrag(ref: ContextRef): string {
  return JSON.stringify({ kind: ref.kind, path: ref.path });
}

/**
 * Read a dragged reference, or null.
 *
 * Total, and hostile: `dataTransfer` is filled by whatever was dragged, and a page in another
 * window can set any type it likes. A path is checked for shape here and confined to the project
 * root by `fs.read` later — this is the first gate, not the only one.
 */
export function decodeRefDrag(raw: string): ContextRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { kind, path } = parsed as { kind?: unknown; path?: unknown };
  if (kind !== "file" && kind !== "folder") return null;
  if (typeof path !== "string" || path === "" || path.length > 4096) return null;
  // An absolute path or a traversal is not something the tree would ever have produced.
  if (path.startsWith("/") || path.includes("..") || /^[A-Za-z]:/.test(path)) return null;
  return { kind, path };
}

/**
 * What a file dropped from the operating system is called.
 *
 * **It is a name, never a path.** `File.path` was removed in Electron 32, and the replacement —
 * `webUtils.getPathForFile` — is deliberately not exposed in the preload: it hands the renderer
 * arbitrary filesystem locations, and the only thing it buys is a file outside the project,
 * which `fs.read` would refuse anyway. So an OS drop arrives as bytes with a filename, and
 * calling that filename a path in the prompt would tell the model something untrue about where
 * the text came from.
 */
export function droppedTextName(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
  return base === "" ? "dropped file" : base;
}

/** Per dropped file. Smaller than the whole-expansion budget, since these are pasted wholesale. */
export const MAX_DROPPED_BYTES = 100 * 1024;

/** Why a dropped file cannot be inlined as text, or null if it can. */
export function rejectionForDrop(file: { name: string; size: number }): string | null {
  if (looksBinaryByName(file.name)) return "binary";
  if (file.size > MAX_DROPPED_BYTES) return "too large";
  return null;
}
