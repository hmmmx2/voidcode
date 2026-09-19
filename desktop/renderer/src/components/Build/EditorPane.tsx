"use client";

import { useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import MonacoWrapper from "@/components/Editor/MonacoWrapper";
import { Breadcrumbs } from "./Breadcrumbs";
import { monacoLanguageFor } from "@shared/languages";

/**
 * One file, shown.
 *
 * READ-ONLY FOR NOW, AND THAT IS A PHASE BOUNDARY RATHER THAN A DESIGN. Saving has a real
 * mechanism behind it — `fs:save` carries the app's only optimistic-concurrency check, and
 * `build/watcher.ts` is built around that guard — and wiring it up means command ids, a dirty
 * set, a discard prompt and the window-close handshake `windows.ts` says "ships with save, not
 * after it". Landing the viewer first keeps both diffs reviewable. Until then the editor says so
 * rather than silently swallowing keystrokes.
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
  changedOnDisk,
  watching,
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
  changedOnDisk: boolean;
  watching: boolean;
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
          Read-only
        </span>
      </div>

      {changedOnDisk && (
        /*
          The banner says what happened and, when the watcher is off, why it might not have.
          `watch.watching` is already in the workspace's state for exactly this: "nothing changed"
          must not be indistinguishable from "I stopped being able to tell".
        */
        <div className="shrink-0 border-b border-line bg-ide-raised px-3 py-1.5 text-[12px] text-ink-2">
          This file changed on disk since it was opened.
          {!watching && " The file watcher is not running, so further changes will not be noticed."}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <MonacoWrapper
          path={path}
          value={contents}
          language={language ?? monacoLanguageFor(path) ?? "plaintext"}
          readOnly
          visible={visible}
          reveal={reveal}
        />
      </div>
    </div>
  );
}
