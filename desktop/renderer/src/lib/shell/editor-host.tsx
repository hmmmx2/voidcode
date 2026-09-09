"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { editor } from "monaco-editor";

/**
 * The live Monaco instance, so the shell can drive it.
 *
 * BEFORE THIS, NOTHING IN THE APP HELD THE EDITOR. `@monaco-editor/react` creates the
 * `IStandaloneCodeEditor` internally and only hands it out through `onMount`, which no call
 * site used — a repo-wide search for `onMount`, `editorRef` or `getAction` returned nothing.
 * So Find, Replace, Format, Rename, Go to Line and the selection commands had no way to reach
 * the thing they operate on, and their menu items sat there emitting intents into the void.
 *
 * The editor belongs to whichever workspace mounted it, and that workspace publishes a handle
 * rather than the shell reaching down into it.
 *
 * **This was a registry, and no longer needs to be.** Split view meant one Monaco per editor
 * group, so hosts were keyed by `groupId`, `surface` told the Study editor from the Build one,
 * and the store tracked which had focus — with the most recently published as a fallback so a
 * command worked immediately after a split. The Build workspace has no editor now: code is read
 * as diffs in the conversation, and the only Monaco left is the one the Study workspace mounts
 * for writing a solution. One editor needs no key, no surface and no notion of focus, so all
 * three are gone rather than kept as a single-entry map pretending to be general.
 */

interface EditorHostStore {
  editor: editor.IStandaloneCodeEditor | undefined;
  publish: (next: editor.IStandaloneCodeEditor | undefined) => void;
}

const EditorHostContext = createContext<EditorHostStore>({
  editor: undefined,
  publish: () => {},
});

export function EditorHostProvider({ children }: { children: React.ReactNode }) {
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | undefined>(undefined);

  const publish = useCallback((next: editor.IStandaloneCodeEditor | undefined) => {
    setInstance((prev) => {
      // Compared before storing: the producer publishes from a callback that can fire more than
      // once for the same editor, and a fresh value each time would re-run every consumer's
      // effects — which for `useEditorCommands` means re-registering seventeen bindings.
      if (prev === next) return prev;
      return next;
    });
  }, []);

  const store = useMemo<EditorHostStore>(() => ({ editor: instance, publish }), [instance, publish]);

  return <EditorHostContext.Provider value={store}>{children}</EditorHostContext.Provider>;
}

/** For the shell — the command bindings read this. `undefined` when no editor is mounted. */
export function useEditorHost(): editor.IStandaloneCodeEditor | undefined {
  return useContext(EditorHostContext).editor;
}

/** For a workspace — call from Monaco's `onMount`, and again with `undefined` on dispose. */
export function usePublishEditor(): (next: editor.IStandaloneCodeEditor | undefined) => void {
  return useContext(EditorHostContext).publish;
}
