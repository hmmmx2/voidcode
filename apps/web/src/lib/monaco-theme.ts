/**
 * The one Monaco theme, shared by the marketing demo and the workspace editor.
 *
 * This was written for the landing page's demo and lived inside
 * `marketing/demo/DemoEditor.tsx`, while the actual editor students write code
 * in — `Editor/MonacoWrapper.tsx` — ran raw `theme="vs-dark"`. That is blues,
 * oranges and greens: a fifth colour system, in the densest and most-looked-at
 * surface in the product, on a site that is otherwise monochrome.
 *
 * `vs-dark` also can't be fixed with CSS. Monaco paints into its own DOM with
 * inline colours from the theme registry, so no token, utility or cascade
 * override reaches it — registering a theme is the only lever there is.
 *
 * WHY MONOCHROME CODE, WHICH IS NOT AN OBVIOUS CALL. Syntax colour is real
 * information and removing it does cost scanning speed. It is here because the
 * alternative costs more: `vs-dark`'s palette is louder than anything else on
 * the page, so the editor would read as a third-party widget embedded in the
 * product rather than as part of it. Structure still comes through — keywords
 * clip to white and bold, comments drop to #555, everything else sits between,
 * so the ramp carries the same grouping that hue did.
 *
 * If this proves too flat in real use, the fix is a desaturated hue set in
 * `RULES` below and it is a one-file change. That is deliberate: the decision
 * is isolated here rather than spread across two call sites.
 */

/**
 * The slice of the Monaco namespace this file touches.
 *
 * Declared structurally rather than imported from `monaco-editor`, because that
 * package is only an *optional peer* of `@monaco-editor/react` here — the editor
 * is fetched from a CDN at runtime, so the types are not reliably installed and
 * a direct import fails to resolve. One theme call does not justify adding a
 * multi-megabyte dependency purely for its `.d.ts`.
 */
export type MonacoThemeApi = {
  editor: {
    defineTheme(
      name: string,
      theme: {
        base: "vs-dark";
        inherit: boolean;
        rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
        colors: Record<string, string>;
      }
    ): void;
  };
};

export const VOID_THEME_NAME = "voidcode-void";

/**
 * Token rules. These mirror `marketing/demo/CodeStatic.tsx`'s hand tokenizer
 * exactly, so the static placeholder and the live editor are indistinguishable
 * and the swap between them does not flash.
 *
 * Monaco wants hex WITHOUT the leading `#`, which is why these are bare and the
 * `colors` map below is not. Getting that wrong fails silently — the rule is
 * dropped and you get the inherited `vs-dark` colour, which looks like the theme
 * "didn't apply" rather than like one malformed line.
 */
const RULES = [
  { token: "", foreground: "d4d4d4" },
  { token: "comment", foreground: "555555", fontStyle: "italic" },
  { token: "keyword", foreground: "ffffff", fontStyle: "bold" },
  { token: "string", foreground: "848484" },
  { token: "number", foreground: "a3a3a3" },
  { token: "type", foreground: "a3a3a3" },
  { token: "type.identifier", foreground: "a3a3a3" },
  { token: "identifier", foreground: "d4d4d4" },
  { token: "delimiter", foreground: "848484" },
  { token: "operator", foreground: "a3a3a3" },
] as const;

/**
 * Chrome colours. Values are literals rather than `var(--color-ide-code)`
 * because Monaco parses these itself and never puts them through CSS — a
 * `var()` here resolves to nothing and the surface renders transparent.
 *
 * They are kept in step with the tokens by hand. The mapping is:
 *   editor.background        → --color-ide-code    #050506
 *   editor.lineHighlight     → --color-ide-bar     #141416
 *   selection / indent guide → --color-line-strong #262626
 */
const BASE_COLORS: Record<string, string> = {
  "editor.background": "#050506",
  "editor.foreground": "#d4d4d4",
  "editorLineNumber.foreground": "#555555",
  "editorLineNumber.activeForeground": "#a3a3a3",
  "editor.selectionBackground": "#333333",
  "editor.lineHighlightBackground": "#141416",
  "editor.lineHighlightBorder": "#00000000",
  "editorCursor.foreground": "#ffffff",
  "editorIndentGuide.background1": "#262626",
  "editorIndentGuide.activeBackground1": "#3a3a3a",
  "editorWidget.background": "#0d0d0f",
  "editorWidget.border": "#262626",
  "editorSuggestWidget.background": "#0d0d0f",
  "editorSuggestWidget.border": "#262626",
  "editorSuggestWidget.selectedBackground": "#262626",
  "scrollbarSlider.background": "#33333366",
  "scrollbarSlider.hoverBackground": "#3a3a3a99",
  "scrollbarSlider.activeBackground": "#555555aa",
};

/**
 * Register the theme. Pass to `<Editor beforeMount={...} />`.
 *
 * `colorOverrides` exists for one real difference: the marketing demo sits in a
 * `#1e1e1e` panel and the workspace editor sits on the near-black `ide-code`
 * surface. Same tokens, different chrome — see `DemoEditor.tsx`.
 */
export function defineVoidTheme(
  monaco: MonacoThemeApi,
  colorOverrides?: Record<string, string>
) {
  monaco.editor.defineTheme(VOID_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [...RULES],
    colors: colorOverrides
      ? { ...BASE_COLORS, ...colorOverrides }
      : BASE_COLORS,
  });
}
