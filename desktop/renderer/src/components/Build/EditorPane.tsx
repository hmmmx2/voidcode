"use client";

import { useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import MonacoWrapper from "@/components/Editor/MonacoWrapper";
import { Breadcrumbs } from "./Breadcrumbs";
import { monacoLanguageFor } from "@shared/languages";

/**
 * One file, shown.
 *
 * EDITABLE, AND SAVED EXPLICITLY. Ctrl+S, a dot on the tab while the buffer differs from disk,
 * and a native prompt when a dirty tab is closed. Not autosave: `fs:save` carries the app's only
 * optimistic-concurrency check, and a background write every second would either fight that guard
 * or have to weaken it. The header says "Unsaved" rather than leaving the state to the tab dot
 * alone, because the dot is small and the consequence is not.
 *
 * ONE EDITOR INSTANCE, SWITCHED BY THE `path` PROP. `@monaco-editor/react` keeps a module-level
 * map of view states keyed by path and, when `path` changes, saves the outgoing cursor/scroll/
 * folds, swaps the model and restores the incoming one. So per-tab view state costs nothing
 * here. Mounting one editor per tab would cost an instance each and lose that for free behaviour.
 *
 * WHAT THAT LEAVES US TO DO IS THE OPPOSITE: DISPOSAL. The library's `getOrCreateModel` returns
 * an *existing* model for a URI and ignores the value passed alongside it, and on unmount it
 * disposes only the model that happens to be current. So a closed tab leaks its model, and
 * reopening that path resurrects the old one — with its old undo stack, and its old contents
 * until the `value` effect catches up. Worse across projects: `Uri.parse` of a project-relative
 * path is unique within a window but not between them, so the same filename in the next project
 * would inherit the previous project's history.
 */
export default function EditorPane({
  path,
  contents,
  language,
  openPaths,
  visible,
  reveal,
  dirty,
  changedOnDisk,
  watching,
  onChange,
  onSave,
  onReload,
  onSaveAs,
}: {
  /** The file to show, or `undefined` when no file is open. */
  path: string | undefined;
  contents: string | undefined;
  /** Overrides the extension lookup. Only used when a caller knows better. */
  language?: string | undefined;
  /** Every open tab's path, so models for closed tabs can be disposed. */
  openPaths: readonly string[];
  visible: boolean;
  reveal?: { line: number; column: number; nonce: number } | undefined;
  dirty: boolean;
  changedOnDisk: boolean;
  watching: boolean;
  onChange: (next: string | undefined) => void;
  onSave: () => void;
  onReload: () => void;
  onSaveAs: () => void;
}) {
  const monaco = useMonaco();

  /**
   * Dispose models for files that are no longer open.
   *
   * Runs on every change to the open set rather than on close, so it also catches the case a
   * close handler cannot see: a project change, which empties the list in one step.
   *
   * The active path is excluded explicitly. Disposing the model the editor is currently
   * displaying leaves it holding a disposed reference, which throws on the next keystroke —
   * and the active path is always in `openPaths`, so this is belt and braces rather than the
   * primary guard.
   */
  useEffect(() => {
    if (monaco === undefined || monaco === null) return;
    /**
     * Compared by the URI the library itself builds, not by a path string we reconstruct.
     * `@monaco-editor/react` keys models with `monaco.Uri.parse(path)`; building the same key
     * the same way is the only version of this that cannot drift from it.
     */
    const keep = new Set(openPaths.map((p) => monaco.Uri.parse(p).toString()));
    for (const model of monaco.editor.getModels()) {
      const key = model.uri.toString();
      if (keep.has(key)) continue;
      /**
       * Study's editor shares this page's Monaco. Its model is created with no path at all, so
       * it lands on an `inmemory://` URI rather than a bare relative one — but the shell survives
       * navigation, so being explicit here is cheaper than finding out the hard way.
       */
      if (model.uri.scheme !== "file") continue;
      model.dispose();
    }
  }, [monaco, openPaths]);

  if (path === undefined || contents === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-ide-code px-6 text-center">
        <p className="text-[13px] text-ink-2">No file open.</p>
        <p className="max-w-[42ch] text-[12px] text-ink-3">
          Click a file in the explorer to read it here. The conversation is still one tab away.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ide-code">
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
        <Breadcrumbs path={path} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-3">
          {dirty ? "Unsaved" : "Saved"}
        </span>
      </div>

      {changedOnDisk && (
        /*
          The banner says what happened, offers the three things that can be done about it, and —
          when the watcher is off — why it might not have said anything at all. `watch.watching`
          is already in the workspace's state for exactly this: "nothing changed" must not be
          indistinguishable from "I stopped being able to tell".

          OVERWRITE IS NOT A BUTTON HERE, deliberately. Saving again after a reload is one click
          away and reads as a decision; a button labelled Overwrite beside a warning is the one
          people press to make the warning go away. The workspace has no force flag either, which
          is what keeps `fs:save`'s baseline check meaning something.
        */
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ide-raised px-3 py-1.5 text-[12px] text-ink-2">
          <span>
            This file changed on disk since it was opened.
            {!watching &&
              " The file watcher is not running, so further changes will not be noticed."}
          </span>
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={onReload}
              className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              Reload from disk
            </button>
            <button
              type="button"
              onClick={onSaveAs}
              className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              Save a copy…
            </button>
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <MonacoWrapper
          path={path}
          value={contents}
          language={language ?? monacoLanguageFor(path) ?? "plaintext"}
          visible={visible}
          reveal={reveal}
          onChange={onChange}
          /*
            Monaco's own Ctrl+S, so the key works when the caret is inside the editor.

            `installKeybindings` listens in the capture phase and would win anyway, but only while
            the command is enabled — and enablement is what stops Ctrl+S firing from the chat
            composer. Binding it here as well means the editor never swallows the key silently,
            which is the failure mode that teaches people the app does not save.
          */
          onSaveKey={onSave}
        />
      </div>
    </div>
  );
}
