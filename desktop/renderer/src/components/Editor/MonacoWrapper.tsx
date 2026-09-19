"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import type { editor as MonacoEditorApi } from "monaco-editor";
import { defaultCode } from "@/lib/mock-data";
import { defineVoidTheme, VOID_THEME_NAME } from "@/lib/monaco-theme";
import { useLocalMonaco } from "@/lib/monaco-local";
import { usePublishEditor } from "@/lib/shell/editor-host";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  /* `bg-ide-code`, matching the theme's `editor.background`. The placeholder
     used to be `ide-panel`, one step lighter, so the editor visibly darkened
     the moment Monaco finished loading. */
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-ide-code">
      <div className="text-sm text-ink-3">Loading editor…</div>
    </div>
  ),
});

interface MonacoWrapperProps {
  language?: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
  /**
   * A stable identity for the buffer.
   *
   * Monaco keeps one text model per path and restores its view state when you come back, so
   * passing this is what makes tab switching preserve undo history and scroll position.
   * Without it the editor shares a single model across every file, and Ctrl+Z in the second
   * file undoes into the first.
   */
  path?: string;
  /** Show the file without letting it be typed into. Build Mode's viewer starts here. */
  readOnly?: boolean;
  /**
   * Whether this editor is the one on screen.
   *
   * Monaco measures itself on mount, and a mount inside a `display:none` subtree measures zero.
   * `automaticLayout` uses a ResizeObserver and does recover — but only after the browser has
   * delivered a resize, so the first frame after a tab switch can be a blank editor. Telling it
   * directly is one call and removes the flicker. `TerminalPanel` takes an `active` prop for the
   * same reason.
   *
   * Omitted means "always visible", which is what the Study workspace wants.
   */
  visible?: boolean;
  /**
   * Put the cursor on a line and scroll it into view.
   *
   * `nonce` is not decoration. `@monaco-editor/react` has a `line` prop, and its effect is an
   * update-effect keyed on the value — so revealing the same line twice does nothing, and
   * "jump to the error I clicked a moment ago" is exactly the case where a user clicks the same
   * row again. Revealing through the instance with a caller-supplied nonce makes every request
   * arrive.
   */
  reveal?: { line: number; column: number; nonce: number };
}

export default function MonacoWrapper({
  language = "python",
  value = defaultCode,
  onChange,
  path,
  readOnly = false,
  visible = true,
  reveal,
}: MonacoWrapperProps) {
  // Point the loader at the bundled copy before the editor mounts. Without this it
  // fetches monaco from jsDelivr and hangs forever with no network.
  useLocalMonaco();

  const publishEditor = usePublishEditor();
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (visible) editorRef.current?.layout();
  }, [visible]);

  useEffect(() => {
    if (reveal === undefined) return;
    const instance = editorRef.current;
    if (instance === null) return;
    instance.revealLineInCenterIfOutsideViewport(reveal.line);
    instance.setPosition({ lineNumber: reveal.line, column: reveal.column });
    // Focus only when this editor is the one on screen, or a background reveal steals the caret
    // out of the composer the user is typing in.
    if (visible) instance.focus();
  }, [reveal, visible]);

  return (
    <div className="h-full w-full">
      <MonacoEditor
        height="100%"
        language={language}
        /* Was raw `vs-dark` — blues, oranges and greens, a fifth colour system
           in the densest surface in the product. `voidcode-void` is the theme
           the landing-page demo already ships; see `lib/monaco-theme.ts` for
           why this cannot be fixed with CSS. */
        {...(path !== undefined ? { path } : {})}
        theme={VOID_THEME_NAME}
        beforeMount={defineVoidTheme}
        value={value}
        onChange={onChange}
        onMount={(instance) => {
          editorRef.current = instance;
          publishEditor(instance);
          // Cleared on dispose rather than on unmount: React can unmount this component while
          // Monaco is still tearing the editor down, and a handle to a disposed editor throws on
          // the next `getAction`.
          instance.onDidDispose(() => {
            editorRef.current = null;
            publishEditor(undefined);
          });
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          fontFamily: "var(--font-jetbrains-mono), monospace",
          scrollBeyondLastLine: false,
          padding: { top: 16 },
          lineNumbers: "on",
          renderLineHighlight: "line",
          cursorBlinking: "smooth",
          automaticLayout: true,
          tabSize: 4,
          readOnly,
          /*
            Off, because `inherit: true` in `monaco-theme.ts` takes vs-dark's bracket palette —
            four saturated hues that are louder than every token rule the theme actually defines,
            in the densest surface in the product. The theme names its own bracket colours.
          */
          bracketPairColorization: { enabled: false },
        }}
      />
    </div>
  );
}
