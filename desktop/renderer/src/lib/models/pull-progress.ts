/**
 * What a download looks like, as it happens.
 *
 * Pure, so the rule below can be tested without a window, a host or a nine-gigabyte model —
 * following `dock.ts` and `assistant-view.ts`, which exist for the same reason. `usePulls` is
 * the React half and holds nothing but the state these functions return.
 *
 * **Completion is `status === "success"`, never `fraction >= 1`.** Ollama's layer downloads
 * finish before the manifest write does, so the fraction reaches 1 and then several more frames
 * arrive — "verifying sha256", "writing manifest". A bar that finishes on the fraction sits at
 * 100% looking hung for the last few seconds of every pull. `OllamaProvider.pull` already
 * refuses to resolve without an explicit success frame; this mirrors that rule rather than
 * inventing a second one that can disagree with it.
 */

export type PullPhase = "pulling" | "done" | "failed";

export interface Pull {
  id: string;
  phase: PullPhase;
  /** Ollama's own status string, shown verbatim — "pulling manifest", "verifying sha256", … */
  status: string;
  /** Absent until Ollama starts reporting bytes, which is a second or two in. */
  fraction: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
  /** The reason it failed, in whatever words main used. Null while it has not. */
  error: string | null;
}

export type Pulls = ReadonlyMap<string, Pull>;

/** The frame Ollama sends, as it arrives: unvalidated, from the other side of the boundary. */
interface ProgressFrame {
  id: string;
  status: string;
  fraction?: number;
  completedBytes?: number;
  totalBytes?: number;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A row for a pull that has just been asked for, before any frame has arrived. */
export function beginPull(pulls: Pulls, id: string): Pulls {
  const next = new Map(pulls);
  next.set(id, {
    id,
    phase: "pulling",
    // Named before the first frame, which is a second or two of silence otherwise — long
    // enough for a second click.
    status: "starting",
    fraction: null,
    completedBytes: null,
    totalBytes: null,
    error: null,
  });
  return next;
}

/**
 * Fold one progress frame in.
 *
 * `mine` is the set of ids this page started. Every window subscribed to the channel can see a
 * frame, and rendering a progress bar for a download this page did not begin is confusing rather
 * than helpful — so an unrecognised id is dropped rather than creating a row.
 *
 * Returns the same map when nothing changed, so a stale frame cannot cause a re-render.
 */
export function applyFrame(pulls: Pulls, raw: unknown, mine: ReadonlySet<string>): Pulls {
  const frame = raw as ProgressFrame | null | undefined;
  if (typeof frame?.id !== "string" || typeof frame.status !== "string") return pulls;
  if (!mine.has(frame.id)) return pulls;

  // A frame after the pull resolved is stale; `done` is sticky so a late "verifying" frame
  // cannot reopen a finished row.
  if (pulls.get(frame.id)?.phase === "done") return pulls;

  const next = new Map(pulls);
  next.set(frame.id, {
    id: frame.id,
    phase: frame.status === "success" ? "done" : "pulling",
    status: frame.status,
    fraction: finite(frame.fraction),
    completedBytes: finite(frame.completedBytes),
    totalBytes: finite(frame.totalBytes),
    error: null,
  });
  return next;
}

/**
 * The pull's promise resolved.
 *
 * Authoritative even if the success frame was missed — main will not resolve `models:pull`
 * without one, so a resolution is a success frame that this window did not happen to see.
 */
export function completePull(pulls: Pulls, id: string): Pulls {
  const existing = pulls.get(id);
  if (existing === undefined) return pulls;
  const next = new Map(pulls);
  next.set(id, { ...existing, phase: "done", fraction: 1 });
  return next;
}

/**
 * The pull's promise rejected.
 *
 * Main's message is kept verbatim: "Only Ollama can download models" is the whole explanation,
 * and replacing it with "Download failed" throws away the only part worth reading.
 */
export function failPull(pulls: Pulls, id: string, error: unknown): Pulls {
  const existing = pulls.get(id);
  const next = new Map(pulls);
  next.set(id, {
    ...(existing ?? {
      id,
      status: "failed",
      fraction: null,
      completedBytes: null,
      totalBytes: null,
    }),
    phase: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  return next;
}

/** Forget a row entirely. */
export function dismissPull(pulls: Pulls, id: string): Pulls {
  if (!pulls.has(id)) return pulls;
  const next = new Map(pulls);
  next.delete(id);
  return next;
}
