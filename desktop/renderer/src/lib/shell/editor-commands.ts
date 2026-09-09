"use client";

import { useEffect, useMemo, useState } from "react";
import type { CommandId } from "@shared/commands";
import { useEditorHost } from "./editor-host";
import { useRegisterCommands, type CommandBinding } from "./commands";

/**
 * The editor half of the command registry.
 *
 * Every entry is a Monaco action we forward to. Nothing here reimplements an editor feature —
 * Find, multi-cursor and smart-select already exist and are good; they were simply
 * unreachable, because no code in the app held the editor instance.
 *
 * ENABLEMENT COMES FROM MONACO, VIA `isSupported()`. That is the detail worth understanding,
 * because it is what lets the menu be honest about languages without knowing anything about
 * them. `editor.action.formatDocument` reports unsupported when no formatting provider is
 * registered for the model's language — so on a `.py` file Format, Rename, Go to Definition
 * and Go to References grey out, and on a `.ts` file Monaco's bundled TypeScript worker
 * lights them up. When a language server eventually lands, they light up for Python too and
 * **this file does not change**.
 */

/** Command id to Monaco action id. */
const EDITOR_ACTIONS: ReadonlyArray<readonly [CommandId, string]> = [
  ["edit.find", "actions.find"],
  ["edit.replace", "editor.action.startFindReplaceAction"],
  ["edit.toggleComment", "editor.action.commentLine"],
  ["edit.formatDocument", "editor.action.formatDocument"],
  ["edit.rename", "editor.action.rename"],

  ["selection.expand", "editor.action.smartSelect.expand"],
  ["selection.shrink", "editor.action.smartSelect.shrinkSelection"],
  ["selection.copyLineUp", "editor.action.copyLinesUpAction"],
  ["selection.copyLineDown", "editor.action.copyLinesDownAction"],
  ["selection.moveLineUp", "editor.action.moveLinesUpAction"],
  ["selection.moveLineDown", "editor.action.moveLinesDownAction"],
  ["selection.addCursorAbove", "editor.action.insertCursorAbove"],
  ["selection.addCursorBelow", "editor.action.insertCursorBelow"],
  ["selection.selectAllOccurrences", "editor.action.selectHighlights"],

  ["go.toLine", "editor.action.gotoLine"],
  ["go.definition", "editor.action.revealDefinition"],
  ["go.references", "editor.action.goToReferences"],
];

/**
 * Binds every editor command for whichever editor is mounted.
 *
 * Called once from the shell. When no editor is mounted it registers nothing, so the whole
 * Edit and Selection menus grey out on the dashboard — with no route checks anywhere.
 */
export function useEditorCommands(): void {
  const editorInstance = useEditorHost();

  /**
   * Which actions the current model supports.
   *
   * Recomputed when the model or its language changes, because that is when the answer moves:
   * opening a `.ts` file registers the TypeScript worker's providers, opening a `.py` file
   * has none. Monaco offers no "a provider was registered" event, so an action that becomes
   * supported without a model change will not be noticed until the next one — worth knowing,
   * and not worth polling for.
   */
  const [supported, setSupported] = useState<ReadonlySet<CommandId>>(new Set());

  useEffect(() => {
    const editor = editorInstance;
    if (editor === undefined) {
      setSupported(new Set());
      return;
    }

    const recompute = (): void => {
      const next = new Set<CommandId>();
      for (const [id, action] of EDITOR_ACTIONS) {
        // `getAction` returns null for an action Monaco does not have at all; `isSupported`
        // answers whether it can run against the current model.
        if (editor.getAction(action)?.isSupported() === true) next.add(id);
      }
      setSupported((prev) => (sameSet(prev, next) ? prev : next));
    };

    recompute();
    const disposables = [
      editor.onDidChangeModel(recompute),
      editor.onDidChangeModelLanguage(recompute),
    ];
    return () => disposables.forEach((d) => d.dispose());
  }, [editorInstance]);

  const bindings = useMemo<CommandBinding[]>(() => {
    const editor = editorInstance;
    if (editor === undefined) return [];

    return EDITOR_ACTIONS.filter(([id]) => supported.has(id)).map(([id, action]) => ({
      id,
      run: () => {
        // Focus first. Every one of these acts on the selection, and running Find while the
        // palette or a menu had focus would open the widget with the editor still blurred —
        // you would type into nothing.
        editor.focus();
        void editor.getAction(action)?.run();
      },
    }));
  }, [editorInstance, supported]);

  useRegisterCommands(bindings);
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
