/**
 * Path containment. Used by both the `app://` handler and workspace file access.
 *
 * There is one correct way to answer "is this path inside that directory?" and it
 * is not string comparison. Three things defeat the naive version:
 *
 *   - `..` segments          `path.normalize` handles these, so this is the easy part
 *   - symlinks               a link inside the root pointing at ~/.ssh normalises
 *                            to a perfectly innocent-looking path
 *   - Windows 8.3 short names `C:\PROGRA~1` and `C:\Program Files` are the same
 *                            directory with different strings
 *
 * Only the filesystem knows where a path lands, so we ask it. `fs.realpath`
 * resolves links and, on Windows, canonicalises short names.
 */
import path from "node:path";
import fs from "node:fs/promises";

export class PathEscapeError extends Error {
  constructor(readonly attempted: string) {
    super("Path resolves outside the permitted root");
    this.name = "PathEscapeError";
  }
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and confirm it lands
 * inside `root`.
 *
 * Returns the real, canonical path. Throws `PathEscapeError` if it escapes, and
 * lets ENOENT propagate — "does not exist" and "is not allowed" are genuinely
 * different answers and collapsing them makes both harder to handle.
 *
 * Note the trailing-separator comparison: without it, root `/home/a/proj` would
 * wrongly accept `/home/a/proj-secrets`, because the string is a prefix even
 * though the directory is not an ancestor.
 */
export async function resolveWithin(root: string, candidate: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(realRoot, candidate);

  const real = await fs.realpath(absolute);

  if (!isWithin(realRoot, real)) {
    throw new PathEscapeError(candidate);
  }
  return real;
}

/**
 * Pure containment check on already-canonical paths.
 *
 * Split out so it can be unit-tested without touching the filesystem, and so the
 * "create a new file inside the workspace" case — where the target does not exist
 * yet, so `realpath` would throw — can canonicalise the *parent* and check that.
 */
export function isWithin(realRoot: string, realCandidate: string): boolean {
  // Normalise separators before comparing. `realpath` output is already native, but
  // this function is also called with hand-built paths, and on Windows a root of
  // `C:/proj` would not string-match a candidate of `C:\proj\src` despite being its
  // ancestor. `path.normalize` is platform-correct here: it rewrites `/` to `\` on
  // Windows and leaves `\` alone on POSIX, where it is a legal filename character.
  //
  // Note this deliberately does *not* resolve symlinks — that is `realpath`'s job,
  // and doing it here would make the pure check impure and untestable offline.
  const root = path.normalize(realRoot);
  const candidate = path.normalize(realCandidate);

  if (candidate === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(withSep);
}

/**
 * Containment for a path that may not exist yet.
 *
 * Walks up to the nearest existing ancestor, canonicalises that, then re-joins the
 * missing tail. Writing a new file must not require the file to already be there,
 * but it also must not skip the symlink check on the directories leading to it —
 * a symlinked *directory* is the more useful escape anyway.
 */
export async function resolveWithinAllowingNew(root: string, candidate: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(realRoot, candidate);
  const normalised = path.normalize(absolute);

  const missing: string[] = [];
  let cursor = normalised;

  for (;;) {
    try {
      const realCursor = await fs.realpath(cursor);
      const result = missing.length === 0 ? realCursor : path.join(realCursor, ...missing.reverse());
      // Check the resolved ancestor, then the reconstructed target. The ancestor
      // check is the one that matters: if it is outside, no tail can bring it back.
      if (!isWithin(realRoot, realCursor) || !isWithin(realRoot, result)) {
        throw new PathEscapeError(candidate);
      }
      return result;
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        // Walked to the filesystem root without finding anything real.
        throw new PathEscapeError(candidate);
      }
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
