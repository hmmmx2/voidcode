"use client";

import dynamic from "next/dynamic";
import { defaultCode } from "@/lib/mock-data";
import { defineVoidTheme, VOID_THEME_NAME } from "@/lib/monaco-theme";

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
}

export default function MonacoWrapper({
  language = "python",
  value = defaultCode,
  onChange,
}: MonacoWrapperProps) {
  return (
    <div className="h-full w-full">
      <MonacoEditor
        height="100%"
        language={language}
        /* Was raw `vs-dark` — blues, oranges and greens, a fifth colour system
           in the densest surface in the product. `voidcode-void` is the theme
           the landing-page demo already ships; see `lib/monaco-theme.ts` for
           why this cannot be fixed with CSS. */
        theme={VOID_THEME_NAME}
        beforeMount={defineVoidTheme}
        value={value}
        onChange={onChange}
        options={{
          minimap: { enabled: false },
          fontSize: 16, // DEMO: raised from 14 so code survives downscale to 1440x900 in a ~600px card. Revert to 14 after filming.
          lineHeight: 24,
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
