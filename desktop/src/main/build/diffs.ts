/**
 * The Build Mode write path: propose a diff, then commit it.
 *
 * This is the mechanism behind "no limits means no pedagogical withholding, not no safety
 * rails" (spec §2.10). The assistant may write whole files and refactor freely. What it
 * cannot do is write in one step — `fs:writeWithDiff` computes and stores a diff and
 * returns it; only a second, explicit `fs:commitDiff` touches the disk.
 *
 * That split is the entire reason an unrestricted agent is safe to point at a real repo.
 * A single `write_file` tool would make every agent turn an unreviewable mutation of the
 * user's work.
 *
 * Three properties worth stating, because each is a way this could have been got wrong:
 *
 *   **The path is resolved once, at propose time, and stored.** Commit does not re-resolve
 *   the caller's string. Otherwise a renderer could propose a diff for `src/a.ts`, have the
 *   user approve it, and commit against a different path.
 *
 *   **The file's content is captured at propose time and re-checked at commit.** If it
 *   changed in between — the user edited it, another tool wrote it — the commit is refused
 *   rather than silently clobbering work the diff was never computed against.
 *
 *   **Diffs expire.** A stale approval is not an approval; an id that has sat unused for an
 *   hour almost certainly belongs to a conversation the user has moved on from.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { writeWorkspacePath, currentProjectRoot } from "../workspace.js";

/** A single unified-diff hunk, in the shape a renderer can render directly. */
export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  /** Line number in the original file; absent for additions. */
  before?: number;
  /** Line number in the proposed file; absent for removals. */
  after?: number;
}

/**
 * Who proposed a diff.
 *
 * SET IN MAIN, NEVER ACCEPTED FROM A CALLER. A renderer that could label its own diffs would
 * relabel an agent's as `user` and walk straight through the gate below.
 */
export type DiffOrigin = "user" | "agent";

export interface PendingDiff {
  id: string;
  /** Absolute, already confined to the workspace. Never re-derived from caller input. */
  path: string;
  /** Workspace-relative, for display. */
  displayPath: string;
  /** True when the file does not exist yet. */
  isNew: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
  createdAt: number;
  /** Which route may apply this. Shown in the UI, and enforced at commit. */
  origin: DiffOrigin;
}

interface StoredDiff extends PendingDiff {
  /** What the file held when the diff was computed. `undefined` for a new file. */
  baseline: string | undefined;
  next: string;
  /**
   * The window that proposed it, and the only one that may commit it.
   *
   * Ids are the caller's only handle on a pending diff, and they are uuids — but "unguessable"
   * is not an access control. Without this, a second Build window that learned an id could
   * commit a write resolved against the *first* window's project root, which is precisely the
   * cross-window escape making the root per-window is meant to close.
   */
  ownerId: number;
}

const pending = new Map<string, StoredDiff>();

/** An approval older than this is treated as belonging to an abandoned conversation. */
const EXPIRY_MS = 60 * 60 * 1000;

export class DiffExpiredError extends Error {
  constructor() {
    super("That change is no longer pending — propose it again");
    this.name = "DiffExpiredError";
  }
}

export class FileChangedError extends Error {
  constructor(readonly displayPath: string) {
    super(`${displayPath} changed since this diff was computed; nothing was written`);
    this.name = "FileChangedError";
  }
}

/** An agent-proposed diff arrived at the human commit channel. */
export class AgentDiffError extends Error {
  constructor() {
    super("Agent changes must be applied from the approval dialog");
    this.name = "AgentDiffError";
  }
}

/**
 * Above this many lines on either side, fall back to a whole-file replacement.
 *
 * The bound is on *lines*, not bytes, because the LCS table is O(n·m) in memory and lines
 * are what index it. An earlier version guarded only a 2 MB byte cap, which sounds
 * conservative and is not: 2 MB of source is roughly 50k lines, and a 50k x 50k table is
 * 2.5 billion cells — the main process would die allocating it, taking every window with it.
 *
 * 3000 x 3000 is ~9M cells, tens of megabytes, and transient. Beyond that a line-level diff
 * has stopped being reviewable anyway, so degrading to "replace the file" loses the user
 * nothing they were going to read.
 */
const MAX_DIFF_LINES = 3000;

/**
 * Longest-common-subsequence diff.
 *
 * Written out rather than pulled from a package: it is thirty lines, and the alternative
 * is another dependency in the licence gate for something this contained.
 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;

  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    return [
      ...before.map((text, i): DiffLine => ({ kind: "remove", text, before: i + 1 })),
      ...after.map((text, i): DiffLine => ({ kind: "add", text, after: i + 1 })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: "context", text: before[i]!, before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "remove", text: before[i]!, before: i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: after[j]!, after: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: "remove", text: before[i]!, before: ++i });
  while (j < m) out.push({ kind: "add", text: after[j]!, after: ++j });

  return out;
}

/**
 * A second, cruder guard: refuse to read a huge file into memory at all. This one is about
 * not slurping a 500 MB artefact; `MAX_DIFF_LINES` is what protects the diff table.
 */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/**
 * Compute a diff and hold it. Writes nothing.
 *
 * Resolution goes through `writeWorkspacePath`, which allows a file that does not exist yet
 * but still checks every existing ancestor with realpath — so a symlinked directory cannot
 * be used to place a file outside the project.
 */
export async function proposeWrite(
  sender: WebContents,
  candidate: string,
  next: string,
  origin: DiffOrigin = "user"
): Promise<PendingDiff> {
  const absolute = await writeWorkspacePath(sender, candidate);

  let baseline: string | undefined;
  try {
    baseline = await fs.readFile(absolute, "utf8");
  } catch {
    baseline = undefined; // new file
  }

  if ((baseline?.length ?? 0) > MAX_DIFF_BYTES || next.length > MAX_DIFF_BYTES) {
    throw new Error("File is too large to diff");
  }

  const beforeLines = baseline === undefined ? [] : baseline.split("\n");
  const lines = diffLines(beforeLines, next.split("\n"));

  const diff: StoredDiff = {
    id: randomUUID(),
    path: absolute,
    // Derived from the resolved path, not echoed from the caller's string. `candidate` may
    // be `./src/../src/a.ts` or an absolute path; showing it back verbatim would let the
    // label in the review UI disagree with the file actually being written.
    displayPath: displayPathFor(sender, absolute),
    isNew: baseline === undefined,
    lines,
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "remove").length,
    createdAt: Date.now(),
    origin,
    baseline,
    next,
    ownerId: sender.id,
  };

  pending.set(diff.id, diff);
  sweep();

  // The stored copy keeps `baseline`, `next` and `ownerId`; the caller gets none of them.
  // Sending the full proposed content back would let a renderer reconstruct and apply it
  // without going through commit — which is the whole control being built here.
  const { baseline: _b, next: _n, ownerId: _o, ...view } = diff;
  return view;
}

/**
 * Apply a diff a *person* proposed.
 *
 * TWO STEPS ARE NOT TWO PARTIES, and this is where that finally gets fixed.
 *
 * The propose/commit split has always enforced two steps *in main*, not two parties: a
 * compromised renderer can call `writeWithDiff` and then `commitDiff` itself, with no human
 * anywhere in the loop. That was an acceptable trade while the only proposer was a person
 * driving a panel — the renderer was merely automating what the user was already doing.
 *
 * It stops being acceptable the moment an agent acting on fetched web content is a proposer.
 * Then "the renderer can commit its own proposals" means "text from a web page can reach the
 * disk", and the review UI is decoration.
 *
 * So the two routes diverge here. A user-origin diff commits as before. An agent-origin diff
 * is refused on this channel outright and must go through `commitAgentDiffs`, which requires a
 * native dialog — the only surface a compromised renderer can neither fake nor suppress, and
 * therefore the only genuine second party available.
 *
 * The agent's write path is deliberately slower than the human's. That asymmetry is the point.
 */
export async function commitDiff(
  sender: WebContents,
  id: string
): Promise<{ path: string; bytes: number }> {
  const diff = pending.get(id);
  if (diff === undefined) throw new DiffExpiredError();

  // Reported as expired rather than as forbidden, and deliberately without deleting it: the
  // window that owns this diff may still be about to apply it legitimately, and telling a
  // caller "that id exists but is not yours" confirms the id is real.
  if (diff.ownerId !== sender.id) throw new DiffExpiredError();

  /**
   * Not deleted, and named plainly rather than reported as expired.
   *
   * Unlike the ownership check there is nothing to conceal — the caller already knows this id,
   * it just used the wrong door. Keeping the diff alive matters: the legitimate route is still
   * open, and consuming it here would let a compromised renderer *destroy* every proposal the
   * user was about to review by racing them to this channel.
   */
  if (diff.origin === "agent") throw new AgentDiffError();

  if (Date.now() - diff.createdAt > EXPIRY_MS) {
    pending.delete(id);
    throw new DiffExpiredError();
  }

  // Re-read rather than trust the snapshot: between propose and commit the user may have
  // edited the file, or another tool call may have written it. Committing anyway would
  // discard changes the diff was never computed against, and the user approved a diff, not
  // a blind overwrite.
  let current: string | undefined;
  try {
    current = await fs.readFile(diff.path, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== diff.baseline) {
    pending.delete(id);
    throw new FileChangedError(diff.displayPath);
  }

  await fs.mkdir(path.dirname(diff.path), { recursive: true });
  await fs.writeFile(diff.path, diff.next, "utf8");
  pending.delete(id);

  return { path: diff.displayPath, bytes: Buffer.byteLength(diff.next, "utf8") };
}

/** What a batch of agent changes touches, so the dialog can name it before anything is written. */
export interface AgentDiffBatch {
  ids: string[];
  displayPaths: string[];
}

/**
 * Describe a set of agent diffs without applying any of them.
 *
 * Separated from the commit so the approval dialog is built from what main holds, not from
 * labels the renderer passed in. A prompt that says "Apply 3 changes to src/a.ts" while
 * committing something else is worse than no prompt: it manufactures consent for an act the
 * user did not agree to.
 *
 * Ids that are unknown, expired, or another window's are dropped here rather than throwing —
 * one stale id in a batch of four must not cost the user the other three.
 */
export function describeAgentDiffs(sender: WebContents, ids: readonly string[]): AgentDiffBatch {
  const cutoff = Date.now() - EXPIRY_MS;
  const batch: AgentDiffBatch = { ids: [], displayPaths: [] };

  for (const id of ids) {
    const diff = pending.get(id);
    if (diff === undefined) continue;
    if (diff.ownerId !== sender.id) continue;
    if (diff.origin !== "agent") continue;
    if (diff.createdAt < cutoff) continue;

    batch.ids.push(id);
    batch.displayPaths.push(diff.displayPath);
  }

  return batch;
}

export interface AgentCommitResult {
  path: string;
  ok: boolean;
  reason: string | null;
}

/**
 * Apply agent-proposed diffs, once a human has said yes to the batch.
 *
 * `approve` is injected rather than called directly so this module stays free of Electron's
 * dialog API and remains testable — the same shape as the upload-consent gate. What it must
 * not become is optional: a default that approves would turn the one real control in this
 * phase into a parameter someone forgets to pass.
 *
 * Per-file outcomes, and the loop never aborts. One file that changed underneath the agent
 * must not silently cancel the other five the user just approved — that is the `saveAll` bug
 * P3 fixed, and it would be worse here because the user has already agreed.
 *
 * ## `armed`, and why it sits beside `approve` rather than replacing it
 *
 * Auto mode writes without a per-batch dialog. The obvious way to build that is to pass
 * `async () => true` as `approve` — one line, and it deletes the only real control in this
 * module while leaving every signature looking untouched. Anyone reading `commitAgentDiffs`
 * afterwards would see a callback being awaited and conclude a human had answered.
 *
 * So the bypass is a *separate, named parameter*, and the two are not interchangeable:
 *
 *   - `approve` is a human answering this batch. Still required, still non-optional.
 *   - `armed` is a human having answered, earlier, for this window and this project, through
 *     the same main-owned window — see `arming.ts`.
 *
 * Exactly one of them has to be satisfied, and which one is recorded in the result. A caller
 * that wants an unattended write has to say `armed: true` in the caller's own source, where a
 * reviewer can see it, rather than hiding it inside a lambda.
 *
 * The two-parties property survives either way: the second party still exists and is still
 * main's window. Under Auto it consented once, to the mode, with the scope stated — rather
 * than once per batch.
 */
export async function commitAgentDiffs(
  sender: WebContents,
  ids: readonly string[],
  gate: {
    approve: (batch: AgentDiffBatch) => Promise<boolean>;
    /** The window is armed for this project. See `arming.ts`; never defaults to true. */
    armed?: boolean;
  }
): Promise<{ approved: boolean; results: AgentCommitResult[]; viaArming: boolean }> {
  const batch = describeAgentDiffs(sender, ids);
  if (batch.ids.length === 0) return { approved: false, results: [], viaArming: false };

  const viaArming = gate.armed === true;
  // `armed` short-circuits the dialog. It does not short-circuit consent — see above.
  if (!viaArming && !(await gate.approve(batch))) {
    return { approved: false, results: [], viaArming: false };
  }

  const results: AgentCommitResult[] = [];
  for (const id of batch.ids) {
    const diff = pending.get(id);
    if (diff === undefined) continue;

    /**
     * Re-checked *after* approval, not before.
     *
     * The dialog is modal but the file system is not frozen while it is open — a watcher, a
     * terminal command, or the user in another editor can all write in that window. Checking
     * only at describe time would apply a diff against content nobody reviewed.
     */
    let current: string | undefined;
    try {
      current = await fs.readFile(diff.path, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== diff.baseline) {
      pending.delete(id);
      results.push({ path: diff.displayPath, ok: false, reason: "changed on disk since proposed" });
      continue;
    }

    try {
      await fs.mkdir(path.dirname(diff.path), { recursive: true });
      await fs.writeFile(diff.path, diff.next, "utf8");
      results.push({ path: diff.displayPath, ok: true, reason: null });
    } catch (err) {
      results.push({
        path: diff.displayPath,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    pending.delete(id);
  }

  return { approved: true, results, viaArming };
}

/** Project-relative, with forward slashes, for display. Falls back to the basename. */
function displayPathFor(sender: WebContents, absolute: string): string {
  const root = currentProjectRoot(sender);
  if (root === undefined) return path.basename(absolute);
  const relative = path.relative(root, absolute);
  return relative === "" ? path.basename(absolute) : relative.split(path.sep).join("/");
}

function sweep(): void {
  const cutoff = Date.now() - EXPIRY_MS;
  for (const [id, diff] of pending) {
    if (diff.createdAt < cutoff) pending.delete(id);
  }
}

/** Test seam. */
export function __resetDiffs(): void {
  pending.clear();
}

/** Exported for tests; the algorithm is worth checking directly. */
export const __diffLines = diffLines;
