"use client";

import dynamic from "next/dynamic";
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
}

export default function MonacoWrapper({
  language = "python",
  value = defaultCode,
  onChange,
  path,
}: MonacoWrapperProps) {
  // Point the loader at the bundled copy before the editor mounts. Without this it
  // fetches monaco from jsDelivr and hangs forever with no network.
  useLocalMonaco();

  const publishEditor = usePublishEditor();

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
          publishEditor(instance);
          // Cleared on dispose rather than on unmount: React can unmount this component while
          // Monaco is still tearing the editor down, and a handle to a disposed editor throws on
          // the next `getAction`.
          instance.onDidDispose(() => publishEditor(undefined));
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
        }}
      />
    </div>
  );
}
