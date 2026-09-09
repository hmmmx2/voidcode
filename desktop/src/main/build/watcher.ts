/**
 * Watching the project for changes made outside the editor.
 *
 * `preload/index.ts` has subscribed to `fs:changed` since Build Mode existed and nothing has
 * ever sent one. The consequence was quiet: edit a file in another editor, or `git checkout` a
 * branch, and VoidCode kept showing — and would happily save over — content that was no longer
 * on disk. `fs:save`'s baseline guard turned that into a `SaveConflictError` the user had no
 * way to resolve, because nothing in the UI could tell them what had changed.
 *
 * Built on `node:fs.watch({recursive: true})` rather than chokidar. Chokidar is pure JS, so the
 * native-module objection in `store/db.ts` does not apply to it — but it is still a dependency
 * to install, audit and ship, and `fs.watch` behind a narrow interface does the job. The
 * interface is the point: swapping the implementation later is one file.
 *
 * What `fs.watch` actually gives you, and what each costs:
 *
 *   - **Only `rename` and `change`.** Created versus deleted is not in the event; it takes a
 *     `stat` afterwards, and the answer can be stale by the time it arrives.
 *   - **Bursts.** A `git checkout`, an `npm install`, or a formatter run emits thousands of
 *     events in milliseconds. Forwarding them individually would be worse than not watching.
 *   - **Platform limits.** Recursive watching on Linux consumes one inotify watch per
 *     directory and fails with ENOSPC on large trees. That is reported, not swallowed.
 *   - **Our own writes.** Every save produces a change event for the file just saved. Without
 *     suppression the renderer reloads the buffer it just wrote, which at best flickers and at
 *     worst races a still-typing user.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";

export type ChangeKind = "created" | "changed" | "deleted" | "unknown";

export interface FileChange {
  /** Project-relative, forward slashes — the same form every other channel speaks. */
  path: string;
  kind: ChangeKind;
}

export interface FileChangeBatch {
  changes: FileChange[];
  /**
   * A bound stopped this batch short, so the renderer should refetch the tree rather than
   * apply `changes` and believe it is up to date. Silent truncation here would leave the
   * sidebar quietly wrong, which is the failure watching exists to prevent.
   */
  overflow: boolean;
}

/**
 * The same list as `tree.ts`, for the same reason and one more: `node_modules` is not what
 * anyone means by "my project", and a single `npm install` inside it would emit more events
 * than every other source of change combined.
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
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "target",
  ".idea",
  ".DS_Store",
]);

/** Long enough to collapse a checkout, short enough to feel immediate. */
const DEBOUNCE_MS = 150;

/**
 * Past this many distinct paths in one batch, stop naming them and tell the renderer to
 * refetch. A thousand individual reconciliations is slower than one tree read, and the user
 * cannot act on a list that long anyway.
 */
const MAX_CHANGES = 200;

/**
 * How long a path we wrote ourselves stays invisible.
 *
 * Generous, because the event arrives after the write completes and the gap is scheduler
 * dependent. The cost of being too generous is missing a genuine external change to a file we
 * touched in the same half-second; the cost of being too tight is the buffer-reload flicker
 * this exists to stop.
 */
const SELF_WRITE_GRACE_MS = 500;

/** True when any path segment is one of the skipped directories. */
export function shouldIgnore(relativePath: string): boolean {
  if (relativePath === "") return true;
  return relativePath.split(/[\\/]/).some((segment) => SKIP_DIRECTORIES.has(segment));
}

/** Native separators to the forward-slash form the rest of the app uses. */
export function toDisplayPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Collect raw watch events into batches.
 *
 * Pure apart from the timer, and deliberately unaware of the filesystem: it decides *which
 * paths* changed and *when to report*, never *what kind* of change. That keeps the burst
 * logic — the part with all the edge cases — testable with no temp directories.
 */
export class ChangeCoalescer {
  private events = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private overflow = false;

  constructor(
    private readonly onFlush: (events: ReadonlyMap<string, ReadonlySet<string>>, overflow: boolean) => void,
    private readonly debounceMs: number = DEBOUNCE_MS,
    private readonly maxChanges: number = MAX_CHANGES
  ) {}

  push(relativePath: string, eventType: string): void {
    if (shouldIgnore(relativePath)) return;

    const display = toDisplayPath(relativePath);
    const existing = this.events.get(display);

    if (existing !== undefined) {
      existing.add(eventType);
    } else if (this.events.size >= this.maxChanges) {
      // Keep what we have and mark the batch. Growing without bound is how a watcher turns a
      // checkout into an out-of-memory crash.
      this.overflow = true;
    } else {
      this.events.set(display, new Set([eventType]));
    }

    this.arm();
  }

  /** Report an overflow with no specific path — used when the OS says it dropped events. */
  markOverflow(): void {
    this.overflow = true;
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    // Re-armed on every event, so a continuous stream flushes only once it stops. A burst that
    // never stops would starve this — bounded by `maxChanges`, which forces a refetch instead.
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = undefined;
    const events = this.events;
    const overflow = this.overflow;
    if (events.size === 0 && !overflow) return;

    // Hand the map over and start a fresh one, rather than clearing it. Clearing emptied the
    // very map the callback was about to read — every batch arrived with the right shape and
    // no paths in it, and the overflow-only case still passed because it never looks at them.
    this.events = new Map();
    this.overflow = false;
    this.onFlush(events, overflow);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.events = new Map();
    this.overflow = false;
  }
}

/**
 * Decide what happened to one path, after the fact.
 *
 * `fs.watch` never says. The only evidence available once the dust settles is whether the file
 * is there now, plus which event types we saw — and both can be stale, which is what `unknown`
 * is for. A watcher that guessed confidently here would tell the renderer to reload a file
 * that had actually been deleted.
 */
export async function resolveChangeKind(
  root: string,
  displayPath: string,
  eventTypes: ReadonlySet<string>
): Promise<ChangeKind> {
  const absolute = path.join(root, displayPath);
  try {
    await fsp.lstat(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "deleted";
    // Permissions, or a path that vanished mid-check. Saying so beats guessing.
    return "unknown";
  }
  // It exists. A `rename` event means it appeared (or was moved into place); a bare `change`
  // means its contents moved under an existing path.
  return eventTypes.has("rename") ? "created" : "changed";
}

interface Session {
  watcher: fs.FSWatcher;
  coalescer: ChangeCoalescer;
  root: string;
  /** Paths this app wrote, and when — see `SELF_WRITE_GRACE_MS`. */
  ownWrites: Map<string, number>;
}

const sessions = new Map<number, Session>();

/**
 * Record that we are about to write this path, so its own event does not come back as news.
 *
 * Called by the handlers rather than inside `save.ts`/`diffs.ts`/`fsops.ts`, so there is one
 * place that knows both the sender and the resulting display path, and the write modules stay
 * unaware of watching entirely.
 */
export function noteOwnWrite(sender: WebContents, displayPath: string): void {
  const session = sessions.get(sender.id);
  if (session === undefined) return;
  session.ownWrites.set(displayPath, Date.now());
}

function isOwnWrite(session: Session, displayPath: string): boolean {
  const at = session.ownWrites.get(displayPath);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_GRACE_MS) {
    session.ownWrites.delete(displayPath);
    return false;
  }
  session.ownWrites.delete(displayPath);
  return true;
}

export interface WatchStatus {
  watching: boolean;
  /** Why not, when `watching` is false. Shown to the user rather than swallowed. */
  reason: string | null;
}

/**
 * Start watching a window's project. Replaces any existing watch for that window.
 *
 * Returns whether it succeeded. A failure here is not fatal — the editor works fine without a
 * watcher — but it must be visible, because the difference between "nothing changed" and "I
 * stopped being able to tell" matters to anyone who trusts the sidebar.
 */
export function startWatching(
  sender: WebContents,
  root: string,
  emit: (batch: FileChangeBatch) => void
): WatchStatus {
  stopWatching(sender);

  const ownWrites = new Map<string, number>();

  const coalescer = new ChangeCoalescer((events, overflow) => {
    void (async () => {
      const session = sessions.get(sender.id);
      if (session === undefined) return;

      const changes: FileChange[] = [];
      for (const [displayPath, eventTypes] of events) {
        if (isOwnWrite(session, displayPath)) continue;
        changes.push({ path: displayPath, kind: await resolveChangeKind(root, displayPath, eventTypes) });
      }

      // An entire batch of our own writes is not news. Emitting an empty batch would be
      // harmless but would train the renderer to ignore them.
      if (changes.length === 0 && !overflow) return;
      if (!sender.isDestroyed()) emit({ changes, overflow });
    })();
  });

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false });
  } catch (err) {
    coalescer.dispose();
    // ENOSPC on Linux means the inotify watch limit is exhausted — common on large trees and
    // not something the app can fix. EMFILE is the same story for file descriptors.
    const code = (err as NodeJS.ErrnoException).code;
    return {
      watching: false,
      reason:
        code === "ENOSPC"
          ? "the system watch limit is exhausted; external changes will not be detected"
          : `watching is unavailable (${code ?? "unknown error"})`,
    };
  }

  watcher.on("change", (eventType, filename) => {
    // A null filename means the OS knows something changed but not what. Treat it as an
    // overflow rather than dropping it — "something happened, refetch" is the truthful reading.
    if (filename === null || filename === undefined) {
      coalescer.markOverflow();
      return;
    }
    coalescer.push(String(filename), String(eventType));
  });

  watcher.on("error", () => {
    // The watch is dead. Stop rather than leaving a handle that reports nothing, so the state
    // is "not watching" instead of "watching, silently".
    stopWatching(sender);
  });

  const id = sender.id;
  sessions.set(id, { watcher, coalescer, root, ownWrites });
  // By id, not by re-reading the sender: it is destroyed by the time this runs, and touching
  // it throws.
  sender.once("destroyed", () => stopWatchingById(id));

  return { watching: true, reason: null };
}

export function stopWatching(sender: WebContents): void {
  stopWatchingById(sender.id);
}

/** The same, by id, for callers that no longer have a live WebContents to ask. */
function stopWatchingById(id: number): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  sessions.delete(id);
  session.coalescer.dispose();
  try {
    session.watcher.close();
  } catch {
    // Already closed, or the handle died with the window.
  }
}
