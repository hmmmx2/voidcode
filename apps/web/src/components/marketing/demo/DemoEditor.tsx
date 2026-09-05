"use client";

import dynamic from "next/dynamic";
import { CodeStatic } from "./CodeStatic";
import {
  defineVoidTheme,
  VOID_THEME_NAME,
  type MonacoThemeApi,
} from "@/lib/monaco-theme";

/**
 * Monaco, deferred as far as it can reasonably be deferred.
 *
 * `@monaco-editor/react` has no `loader.config({ monaco })` call anywhere in
 * this app, so it fetches ~2 MB from `cdn.jsdelivr.net` at runtime. That is
 * invisible inside the authed workspace and very visible on a public landing
 * page, which is why this component is only rendered once the demo is in view
 * and only above `md` — and why the marketing layout preconnects to jsDelivr.
 *
 * Until it resolves, `CodeStatic` holds the exact same space with the exact same
 * font metrics and colours, so the swap does not shift layout or flash.
 */
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <CodeStatic code={PLACEHOLDER} />,
});

const PLACEHOLDER = "";

/**
 * The demo's chrome differs from the workspace editor's in exactly two values.
 *
 * The shared theme (`lib/monaco-theme.ts`) targets the workspace, where the
 * editor sits on the near-black `ide-code` surface. Here it sits inside the
 * demo's `#1e1e1e` panel, and an editor background darker than its own frame
 * would carve a hole in the middle of the hero. Tokens are identical; only the
 * surface moves.
 */
function defineTheme(monaco: MonacoThemeApi) {
  defineVoidTheme(monaco, {
    "editor.background": "#1e1e1e",
    "editor.lineHighlightBackground": "#212121",
    "editorWidget.background": "#212121",
    "editorWidget.border": "#333333",
    "editorSuggestWidget.background": "#212121",
    "editorSuggestWidget.border": "#333333",
  });
}

export function DemoEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <MonacoEditor
      height="100%"
      language="python"
      theme={VOID_THEME_NAME}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      beforeMount={defineTheme}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 24,
        fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace",
        scrollBeyondLastLine: false,
        padding: { top: 16, bottom: 16 },
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        renderLineHighlight: "line",
        cursorBlinking: "smooth",
        automaticLayout: true,
        tabSize: 4,
        // Monaco captures Tab, which on a marketing page is a keyboard trap
        // sitting directly between the hero CTAs and the rest of the document.
        // Tab-moves-focus is the right default here; a visitor who genuinely
        // wants to indent can still use Ctrl+M to toggle it back.
        tabFocusMode: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        overviewRulerLanes: 0,
        contextmenu: false,
        quickSuggestions: false,
        occurrencesHighlight: "off",
        renderWhitespace: "none",
      }}
    />
  );
}
