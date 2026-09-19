/**
 * The rules around writing a buffer back to disk.
 *
 * EVERY MISTAKE IN HERE IS SILENT, which is why they are pure functions with a test rather than
 * inline logic in a 1,300-line component. A save that updates the wrong baseline loses whatever
 * was typed during the round trip *and reports success*; a conflict misclassified as an ordinary
 * error offers the user no way back; a close path that lets the window go before its writes land
 * loses everything at once. None of them produce an error anybody sees.
 */
import { describe, it, expect } from "vitest";
import {
  CONFLICT_SUFFIX,
  afterSave,
  afterSaveAs,
  classifySaveFailure,
  conflictPathFor,
  isDirty,
  isOwnWrite,
  planCloseSaves,
} from "@/lib/build/editor-save";

const buffer = (contents: string, baseline: string | null, path = "a.py") => ({
  path,
  contents,
  baseline,
});

describe("what counts as dirty", () => {
  it("is the buffer differing from disk, with no separate flag", () => {
    expect(isDirty(buffer("x", "x"))).toBe(false);
    expect(isDirty(buffer("x = 2", "x = 1"))).toBe(true);
  });

  it("counts a file that is gone from disk", () => {
    /**
     * `baseline === null` is what `deleteEntry` and `reconcile` set when a file vanishes. The
     * text is still the user's, and closing the tab would be the only thing that ever discarded
     * it — so it has to be dirty, or the close prompt never appears for the one case where the
     * file cannot be recovered by reopening it.
     *
     * This is a property of `isDirty`, not of an explicit branch inside it: `isDirty` was written
     * with a `baseline === null ||` clause, and a mutation run showed that deleting the clause
     * changed nothing, because a string is never `===` to `null`. The clause went; the assertion
     * stays, because the behaviour is what the close prompt depends on and a later rewrite could
     * genuinely break it.
     */
    expect(isDirty(buffer("still here", null))).toBe(true);
    expect(isDirty(buffer("", null))).toBe(true);
  });
});

describe("the baseline after a save", () => {
  it("is the text that was written, not the buffer's current contents", () => {
    /**
     * THE ONE THAT LOSES WORK. `setFiles` runs after an `await`, so the user may have typed more
     * while the write was in flight. Setting `baseline = buffer.contents` inside the updater
     * marks those keystrokes as saved when they are not, and they are then lost at the next
     * conflict check or close. `BuildWorkspace` records this exact shape as a retired data-loss
     * defect from the old editor.
     */
    const typedDuringTheWrite = buffer("line one\nline two", "line one");
    const after = afterSave(typedDuringTheWrite, "line one");

    expect(after.baseline).toBe("line one");
    expect(after.contents).toBe("line one\nline two");
    expect(isDirty(after), "the keystrokes made during the round trip were marked saved").toBe(
      true
    );
  });

  it("leaves a quiet buffer clean", () => {
    const after = afterSave(buffer("x = 1", "x = 0"), "x = 1");
    expect(isDirty(after)).toBe(false);
  });
});

describe("save as", () => {
  it("rebinds the buffer when the target is inside the project", () => {
    const after = afterSaveAs(buffer("x = 1", "x = 0"), "x = 1", {
      path: "copy.py",
      rebind: true,
    });
    expect(after.path).toBe("copy.py");
    expect(isDirty(after)).toBe(false);
  });

  it("leaves the buffer alone when the target is outside the project", () => {
    /**
     * `rebind: false` means the user chose somewhere outside the project root, so main wrote the
     * file once and the buffer keeps its old identity — rebinding to an out-of-root path would
     * force every later `save` to accept one. The buffer is therefore still unsaved against the
     * file it is actually bound to, and moving the baseline would say otherwise: the dot would
     * clear, and the real file would never be written.
     */
    const original = buffer("x = 1", "x = 0");
    const after = afterSaveAs(original, "x = 1", { path: "/elsewhere/copy.py", rebind: false });

    expect(after).toEqual(original);
    expect(isDirty(after)).toBe(true);
  });
});

describe("why a save failed", () => {
  it("calls it a conflict when disk no longer matches the baseline", () => {
    /**
     * Detected, not parsed. `IpcError`'s custom properties do not survive the preload boundary —
     * `src/preload/errors.ts` says so — so there is no code to branch on, and the message is an
     * English sentence a rewording would break. Disk differing from the baseline the save was
     * pinned to *is* the conflict.
     */
    expect(classifySaveFailure("x = 1", "x = 2")).toBe("conflict");
    expect(classifySaveFailure(null, "someone else made this")).toBe("conflict");
  });

  it("does not call it a conflict when disk still matches", () => {
    // Permissions, a full disk, a path that became a directory. Offering "reload from disk" here
    // would be a remedy for a problem the user does not have.
    expect(classifySaveFailure("x = 1", "x = 1")).toBe("unknown");
    expect(classifySaveFailure(null, null)).toBe("unknown");
  });

  it("does not call an unreadable file a conflict", () => {
    // `null` on the re-read means we could not look, not that it changed.
    expect(classifySaveFailure("x = 1", null)).toBe("unknown");
  });
});

describe("telling our own save from somebody else's edit", () => {
  it("recognises the text this window last wrote", () => {
    /**
     * `noteOwnWrite` in main suppresses the watcher event for 500 ms. When the write-to-event
     * latency exceeds that *and* the user typed in the gap, the buffer is dirty again by the time
     * `reconcile` runs, and it would warn the user about their own save — which reads as data
     * loss and is not.
     */
    const saved = new Map([["a.py", "x = 1"]]);
    expect(isOwnWrite(saved, "a.py", "x = 1")).toBe(true);
  });

  it("does not recognise a different edit to the same file", () => {
    const saved = new Map([["a.py", "x = 1"]]);
    expect(isOwnWrite(saved, "a.py", "x = 2")).toBe(false);
    expect(isOwnWrite(saved, "b.py", "x = 1")).toBe(false);
    expect(isOwnWrite(new Map(), "a.py", "x = 1")).toBe(false);
  });
});

describe("what a closing window has to write", () => {
  it("is every dirty buffer, in strip order", () => {
    const files = [
      buffer("x", "x", "clean.py"),
      buffer("y2", "y", "dirty.py"),
      buffer("z", null, "deleted.py"),
    ];
    expect(planCloseSaves(files).map((f) => f.path)).toEqual(["dirty.py", "deleted.py"]);
  });

  it("is empty when nothing changed, so a close costs nothing", () => {
    expect(planCloseSaves([buffer("x", "x")])).toEqual([]);
  });
});

describe("rescuing a buffer whose save was refused during a close", () => {
  it("writes beside the original, named after it", () => {
    /**
     * The window is going regardless — `windows.ts` closes it after `CLOSE_GRACE_MS` — so the
     * choice is a file the user did not ask for or a lost edit. A file wins: it is visible in the
     * tree next time and it names itself.
     */
    expect(conflictPathFor("src/app.py", new Set())).toBe(`src/app.py${CONFLICT_SUFFIX}`);
  });

  it("numbers rather than overwrites a previous rescue", () => {
    // The second close in a row is exactly when this happens twice.
    const taken = new Set([`a.py${CONFLICT_SUFFIX}`, `a.py${CONFLICT_SUFFIX}.1`]);
    expect(conflictPathFor("a.py", taken)).toBe(`a.py${CONFLICT_SUFFIX}.2`);
  });

  it("is deterministic, so it can be tested at all", () => {
    // No timestamp in the fallback: it would make this function untestable for a case nobody
    // reaches, and `fs:save` with a null baseline refuses an existing file anyway.
    const taken = new Set([conflictPathFor("a.py", new Set())]);
    expect(conflictPathFor("a.py", taken)).toBe(conflictPathFor("a.py", taken));
  });
});
