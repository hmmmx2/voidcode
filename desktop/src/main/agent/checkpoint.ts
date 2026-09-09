/**
 * What a file looked like before an Auto run touched it.
 *
 * Auto writes without asking, so the undo has to exist before the first write does. One JSON
 * file per run, holding the original contents of every path the run is about to change.
 *
 * ## What this is not
 *
 * **Not version control, and the UI must not imply it is.** It covers files the run *wrote*.
 * It does not cover what the run's commands did: `npm install`, a database migration, a
 * `git push` and a deleted node_modules are all outside it. "Undo this run" restores files,
 * and that is the most it can honestly claim.
 *
 * **Not in the project.** `userData/checkpoints/`, not `.voidcode/` — a snapshot of someone's
 * code does not belong inside their repository, where it would be picked up by `git add -A`
 * and committed by accident. The memory index lives in the project because it is derived from
 * the project; this is a copy of the project, which is a different thing.
 *
 * ## Bounds
 *
 * 200 files or 8MB per run, counted as entries are added. Past either, the run carries on and
 * the checkpoint records `truncated` — because stopping the run would be worse, and silently
 * dropping entries would offer an undo that half works. A truncated checkpoint has to say so
 * where the user can see it; `revertRun` returns the flag for exactly that reason.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

/** Enough for a large refactor, small enough that a runaway run cannot fill a disk. */
export const MAX_CHECKPOINT_FILES = 200;
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

interface CheckpointEntry {
  /** Project-relative, as the diff named it. */
  path: string;
  /**
   * Did the file exist before the run?
   *
   * `false` is the case that makes revert complete rather than approximate: a file the run
   * *created* has no previous contents to restore, so reverting it means deleting it. Without
   * this flag the best a revert could do is leave the new file in place, which is not the
   * state the user asked to go back to.
   */
  existed: boolean;
  content: string | null;
}

interface Checkpoint {
  runId: string;
  projectRoot: string;
  createdAt: number;
  truncated: boolean;
  entries: CheckpointEntry[];
}

/** In-memory while the run is live; flushed after every capture so a crash still leaves it. */
const open = new Map<string, Checkpoint>();

function directory(): string {
  return path.join(app.getPath("userData"), "checkpoints");
}

function fileFor(runId: string): string {
  // The id is a `randomUUID` minted in main and never supplied by a renderer, but it is
  // becoming a filename, so the basename is taken rather than trusted.
  return path.join(directory(), `${path.basename(runId)}.json`);
}

async function flush(checkpoint: Checkpoint): Promise<void> {
  await fsp.mkdir(directory(), { recursive: true });
  await fsp.writeFile(fileFor(checkpoint.runId), JSON.stringify(checkpoint), "utf8");
}

/**
 * Record what `relativePath` looks like now, if it has not been recorded already.
 *
 * Called before each auto-applied write. Lazily, so the cost is proportional to what the run
 * actually changed rather than to the size of the project — and idempotently, because a run
 * that writes the same file three times must snapshot the *first* state, not the second.
 *
 * **Returns whether the path is covered**, which the caller needs and used to have no way to
 * learn. This returned `void`, so `stream.ts` could only tell that a capture had *thrown* —
 * not that it had quietly stopped recording at the bound. A run that wrote past it was still
 * offered a clean-looking "Undo file changes", and the user found out it was partial only
 * after pressing it. An undo has to be honest about its coverage before it is taken, not
 * after.
 */
export async function captureBeforeWrite(
  runId: string,
  projectRoot: string,
  relativePath: string
): Promise<{ recorded: boolean }> {
  let checkpoint = open.get(runId);
  if (checkpoint === undefined) {
    checkpoint = {
      runId,
      projectRoot,
      createdAt: Date.now(),
      truncated: false,
      entries: [],
    };
    open.set(runId, checkpoint);
  }

  // The first state is the one worth keeping. A second capture would record the run's own
  // earlier edit as the "original", and reverting would land on a state that never existed
  // before the run started. Already recorded is still recorded.
  if (checkpoint.entries.some((entry) => entry.path === relativePath)) return { recorded: true };

  if (checkpoint.entries.length >= MAX_CHECKPOINT_FILES) {
    checkpoint.truncated = true;
    await flush(checkpoint);
    return { recorded: false };
  }

  const absolute = path.join(projectRoot, relativePath);
  let entry: CheckpointEntry;
  try {
    const content = await fsp.readFile(absolute, "utf8");
    const used = checkpoint.entries.reduce((sum, e) => sum + (e.content?.length ?? 0), 0);
    if (used + content.length > MAX_CHECKPOINT_BYTES) {
      checkpoint.truncated = true;
      await flush(checkpoint);
      return { recorded: false };
    }
    entry = { path: relativePath, existed: true, content };
  } catch {
    // No such file: the run is creating it. Recorded as an entry rather than skipped, because
    // "this did not exist" is the instruction revert needs in order to delete it.
    entry = { path: relativePath, existed: false, content: null };
  }

  checkpoint.entries.push(entry);
  await flush(checkpoint);
  return { recorded: true };
}

export interface RevertOutcome {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
  /** The checkpoint hit a bound, so this undo is partial. The UI must say so. */
  truncated: boolean;
}

/**
 * Put every captured file back.
 *
 * Per-path outcomes and the loop never aborts — one file that cannot be restored must not
 * abandon the other nineteen, which is the same rule `commitAgentDiffs` follows and for the
 * same reason: the user has already asked for the whole thing.
 */
export async function revertRun(runId: string): Promise<RevertOutcome> {
  const outcome: RevertOutcome = { restored: [], deleted: [], failed: [], truncated: false };

  let checkpoint: Checkpoint;
  try {
    checkpoint = JSON.parse(await fsp.readFile(fileFor(runId), "utf8")) as Checkpoint;
  } catch {
    return { ...outcome, failed: [{ path: runId, reason: "No checkpoint for that run" }] };
  }
  outcome.truncated = checkpoint.truncated;

  for (const entry of checkpoint.entries) {
    const absolute = path.join(checkpoint.projectRoot, entry.path);
    try {
      if (entry.existed && entry.content !== null) {
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, entry.content, "utf8");
        outcome.restored.push(entry.path);
      } else {
        // Created by the run. Going back means it is not there.
        await fsp.rm(absolute, { force: true });
        outcome.deleted.push(entry.path);
      }
    } catch (err) {
      outcome.failed.push({
        path: entry.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcome;
}

/** Whether a run can still be undone, for the panel's button. */
export async function hasCheckpoint(runId: string): Promise<boolean> {
  try {
    await fsp.access(fileFor(runId));
    return true;
  } catch {
    return false;
  }
}

/** The run is over; the file on disk is the record. Frees the in-memory copy only. */
export function closeCheckpoint(runId: string): void {
  open.delete(runId);
}

/** Test seam. */
export function __resetCheckpoints(): void {
  open.clear();
}
