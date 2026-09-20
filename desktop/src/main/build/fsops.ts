/**
 * Creating, renaming and deleting files — the operations the tree could show but never do.
 *
 * Everything here goes through the same two doors as `fs:read` and `fs:save`: `resolveWithin`
 * for something that must already exist, `resolveWithinAllowingNew` for something that must
 * not. There is no third path to disk, which is the property that makes reasoning about the
 * agent's reach tractable — it is exactly the renderer's reach.
 *
 * Three rules are worth stating because each closes a way to lose data:
 *
 *   - **Never overwrite.** Create and rename both refuse an existing destination. A "New File"
 *     that silently truncated an existing one, or a rename that ate its target, is a data-loss
 *     bug with a friendly name on it.
 *   - **Never touch the root.** Renaming or deleting the project root is not an operation
 *     anybody means from a file tree, and it would leave the window pointed at a path that no
 *     longer exists.
 *   - **Delete means trash.** See `deleteEntry`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import type { WebContents } from "electron";
import { resolveWithin, resolveWithinAllowingNew } from "../paths.js";
import { currentProjectRoot, NoWorkspaceError } from "../workspace.js";

export type EntryKind = "file" | "directory";

/** The caller asked for something the filesystem already has. Never an overwrite. */
export class EntryExistsError extends Error {
  constructor(readonly displayPath: string) {
    super(`${displayPath} already exists`);
    this.name = "EntryExistsError";
  }
}

/** Refusing to operate on the project root itself. */
export class RootProtectedError extends Error {
  constructor() {
    super("The project folder itself cannot be renamed or deleted from here");
    this.name = "RootProtectedError";
  }
}

/**
 * The OS declined to move something to the trash.
 *
 * Its own error because the honest response is to stop, not to fall back to `fs.rm`. See
 * `deleteEntry`.
 */
export class TrashUnavailableError extends Error {
  constructor(readonly displayPath: string, cause: unknown) {
    super(
      `${displayPath} could not be moved to the trash (${cause instanceof Error ? cause.message : String(cause)})`
    );
    this.name = "TrashUnavailableError";
  }
}

async function realRootFor(sender: WebContents): Promise<string> {
  const root = currentProjectRoot(sender);
  if (root === undefined) throw new NoWorkspaceError();
  // Canonicalised, because the comparison below is against a `resolveWithin` result, which has
  // also been through `realpath`. What matters is that BOTH sides go through the same call, not
  // which spelling it lands on.
  //
  // THE NOTE THAT USED TO BE HERE WAS WRONG, and it cost half a fix elsewhere. It said that on
  // Windows this turns a stored `C:\PROGRA~1` into `C:\Program Files`. It does not:
  // `fs.realpath` resolves symlinks and junctions and returns an 8.3 short name UNCHANGED — only
  // `fs.realpath.native` expands it. Measured. Harmless here, because the root and the candidate
  // are resolved by the same non-expanding function and therefore match either way; not harmless
  // as a description, because `workspace.ts` read this sentence, used plain `realpathSync` for a
  // root it needed the LONG form of, and left nine Windows tests failing.
  return fs.realpath(root);
}

/** Project-relative, forward slashes — the form every other channel speaks. */
/**
 * The path form every `EntryResult` carries: project-relative, forward slashes on every platform.
 *
 * Exported because it is now a contract rather than a formatting detail. The `fs:delete` handler
 * feeds this straight into `forgetFile`, which keys the memory index on exactly this form — so if
 * the two ever diverge, pruning silently stops working with no error and no log line.
 * `tests/memory-index.test.ts` derives both sides from one root and one absolute path to hold them
 * together.
 */
export function displayPathFor(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative === "" ? path.basename(absolute) : relative.split(path.sep).join("/");
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

export interface EntryResult {
  path: string;
  kind: EntryKind;
}

/**
 * Create an empty file or a directory.
 *
 * `resolveWithinAllowingNew` is the right door: the target must not exist, but every existing
 * ancestor is still realpath-checked, so a symlinked directory inside the project cannot be
 * used to place a file outside it.
 *
 * `lstat` rather than `stat` for the existence check — a **broken symlink** is something that
 * exists as far as `open(O_EXCL)` is concerned, and `stat` would report it missing and let
 * this claim to create a file it then failed to write.
 */
export async function createEntry(
  sender: WebContents,
  candidate: string,
  kind: EntryKind
): Promise<EntryResult> {
  const root = await realRootFor(sender);
  const absolute = await resolveWithinAllowingNew(root, candidate);

  if (absolute === root) throw new EntryExistsError(displayPathFor(root, absolute));
  if (await exists(absolute)) throw new EntryExistsError(displayPathFor(root, absolute));

  if (kind === "directory") {
    await fs.mkdir(absolute, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    // `wx` fails if the path appeared between the check above and here. The check is for a
    // good error message; this flag is what actually makes it safe.
    const handle = await fs.open(absolute, "wx");
    await handle.close();
  }

  return { path: displayPathFor(root, absolute), kind };
}

/**
 * Rename or move. One syscall, because on every filesystem this app targets they are the
 * same operation — a move is a rename whose destination has a different parent.
 */
export async function renameEntry(
  sender: WebContents,
  from: string,
  to: string
): Promise<EntryResult> {
  const root = await realRootFor(sender);

  // Source must exist, so `resolveWithin`; ENOENT propagates rather than being folded into
  // the escape error, because "no such file" and "not allowed" are different answers.
  const source = await resolveWithin(root, from);
  if (source === root) throw new RootProtectedError();

  const destination = await resolveWithinAllowingNew(root, to);
  if (destination === root) throw new EntryExistsError(displayPathFor(root, destination));

  if (source !== destination && (await exists(destination))) {
    throw new EntryExistsError(displayPathFor(root, destination));
  }

  const stat = await fs.lstat(source);

  // Moving a directory inside itself: `fs.rename` reports EINVAL on POSIX but the message is
  // opaque, and on some Windows configurations it succeeds partially. Refusing explicitly is
  // both clearer and safer.
  if (stat.isDirectory() && destination.startsWith(source + path.sep)) {
    throw new RootProtectedError();
  }

  await fs.rename(source, destination);

  return {
    path: displayPathFor(root, destination),
    kind: stat.isDirectory() ? "directory" : "file",
  };
}

/**
 * Delete, via the OS trash.
 *
 * `shell.trashItem`, not `fs.rm`, and this is the whole decision: a file tree's Delete is the
 * one destructive action a user reaches for casually, usually with the keyboard, sometimes on
 * the wrong row. Trash makes that recoverable in the place they already know to look.
 *
 * **No fallback to unlink.** If trash fails — a network share, a filesystem with no trash spec,
 * a sandbox that forbids it — the honest answer is to stop and say so. Quietly upgrading a
 * recoverable delete into an unrecoverable one, precisely when the environment is unusual, is
 * the opposite of what the user asked for.
 */
export async function deleteEntry(sender: WebContents, candidate: string): Promise<EntryResult> {
  const root = await realRootFor(sender);
  const absolute = await resolveWithin(root, candidate);
  if (absolute === root) throw new RootProtectedError();

  const stat = await fs.lstat(absolute);
  const display = displayPathFor(root, absolute);

  try {
    await shell.trashItem(absolute);
  } catch (err) {
    throw new TrashUnavailableError(display, err);
  }

  return { path: display, kind: stat.isDirectory() ? "directory" : "file" };
}
