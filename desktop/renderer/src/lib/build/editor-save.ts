/**
 * The rules around writing a buffer back to disk.
 *
 * Pure, and separated from `BuildWorkspace` for one reason above the others: the mistakes here
 * are all silent. A save that updates the wrong baseline loses whatever was typed during the
 * round trip and reports success; a conflict misclassified as an ordinary error offers the user
 * no way back; a close path that allows the window to go before its writes resolve loses the lot.
 * None of those produce an error anyone sees, so each is asserted rather than reviewed.
 */

/** Just enough of a `FileBuffer` for these rules. `baseline` is what disk last held. */
export interface SaveableBuffer {
  path: string;
  contents: string;
  baseline: string | null;
}

/**
 * Has this buffer diverged from disk?
 *
 * ONE COMPARISON, AND THE DELETED CASE FALLS OUT OF IT. `baseline === null` means the file is
 * gone — deleted under us, or never there — and that has to count as dirty: the text is still the
 * user's, and closing the tab would be the only thing that ever discarded it. A string is never
 * `===` to `null`, so `contents !== baseline` already says so.
 *
 * Written as an explicit `baseline === null ||` first, which a mutation run then showed to be
 * unreachable: deleting the clause changed no behaviour and no test. A clause that cannot be
 * mutated is not a guard, it is a comment with syntax — so it is a comment now, and
 * `editor-save.test.ts` asserts the behaviour it was describing.
 */
export function isDirty(buffer: SaveableBuffer): boolean {
  return buffer.contents !== buffer.baseline;
}

/**
 * The buffer after a successful save.
 *
 * `baseline` becomes THE TEXT THAT WAS WRITTEN, not the buffer's current contents. That is the
 * whole function, and it is a function because the difference is invisible at the call site:
 * `setFiles` runs after an `await`, so by then the user may have typed more. Setting
 * `baseline = buffer.contents` inside the updater marks those keystrokes as saved when they are
 * not, and they are then lost at the next conflict check or close — `BuildWorkspace` records
 * this exact shape as one of the data-loss defects that were retired with the old editor rather
 * than fixed.
 */
export function afterSave(buffer: SaveableBuffer, written: string): SaveableBuffer {
  return { ...buffer, baseline: written };
}

/**
 * The buffer after Save As.
 *
 * `rebind` is false when the user chose somewhere outside the project: the file is written once
 * and the buffer keeps its old identity, because rebinding to an out-of-root path would force
 * every later `save` to accept one. So the baseline must NOT move — the buffer is still unsaved
 * against the file it is actually bound to, and saying otherwise would hide that.
 */
export function afterSaveAs(
  buffer: SaveableBuffer,
  written: string,
  target: { path: string; rebind: boolean }
): SaveableBuffer {
  if (!target.rebind) return buffer;
  return { path: target.path, contents: buffer.contents, baseline: written };
}

/**
 * Why did a save fail?
 *
 * DETECTED, NOT PARSED. `IpcError`'s custom properties do not survive the preload boundary —
 * `src/preload/errors.ts` says so explicitly — so the renderer cannot read a code off the
 * rejection, and the message is an English sentence built in `build/save.ts` that would break
 * this the first time it was reworded. What the renderer *can* do is re-read the file and
 * compare: if disk no longer matches the baseline the save was pinned to, it is a conflict.
 * That is the definition rather than a heuristic, and the re-read also produces the text the
 * recovery paths need.
 *
 * `onDisk === null` means the file could not be read at all — permissions, or it was removed
 * between the failure and the re-read. That is not a conflict and must not offer "reload from
 * disk" as a remedy.
 */
export function classifySaveFailure(
  baseline: string | null,
  onDisk: string | null
): "conflict" | "unknown" {
  if (onDisk === null) return "unknown";
  return onDisk === baseline ? "unknown" : "conflict";
}

/**
 * Is this watcher event our own save coming back?
 *
 * `noteOwnWrite` in main suppresses the change event for a 500 ms grace window. When the
 * write-to-event latency exceeds it *and* the user typed in between, `reconcile` would mark the
 * buffer conflicted and warn the user about their own save — which reads as data loss and is
 * not.
 *
 * Keyed on the text rather than on a timestamp: a second grace window in the renderer would be a
 * second thing to tune, and "the file on disk is exactly what we last wrote" is the fact that
 * actually settles it.
 */
export function isOwnWrite(
  recentlySaved: ReadonlyMap<string, string>,
  path: string,
  onDisk: string
): boolean {
  return recentlySaved.get(path) === onDisk;
}

/** Every buffer a close has to write, in strip order. */
export function planCloseSaves(files: readonly SaveableBuffer[]): SaveableBuffer[] {
  return files.filter(isDirty);
}

/** The suffix a rescued buffer is written under when its save is refused during a close. */
export const CONFLICT_SUFFIX = ".voidcode-conflict";

/**
 * Where to put a buffer whose save was refused while the window was closing.
 *
 * THE WINDOW IS GOING REGARDLESS. `windows.ts` gives the renderer `CLOSE_GRACE_MS` — three
 * seconds — and then closes anyway, so there is no time for a dialog and nobody to read one. The
 * choices are a file the user did not ask for, or losing the edit. A file wins: it is visible in
 * the tree next time, and it names itself.
 *
 * Numbered rather than overwritten, because the second close in a row is exactly when this
 * happens twice. `taken` is the set of paths already in the project, so the rescue cannot clobber
 * a previous rescue — `fs:save` with a `null` baseline refuses an existing file anyway, and this
 * keeps that refusal from being the thing the user discovers.
 */
export function conflictPathFor(path: string, taken: ReadonlySet<string>): string {
  const base = `${path}${CONFLICT_SUFFIX}`;
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base}.${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  /**
   * A thousand rescues of one file is past the point where a cleverer name helps. This one is
   * already taken, so `fs:save` with a `null` baseline refuses it and the caller reports the
   * refusal — which is a worse outcome than a numbered file and a better one than a silent
   * overwrite. Deterministic on purpose: a timestamp here would make this function untestable
   * for the sake of a case nobody reaches.
   */
  return `${base}.999`;
}
