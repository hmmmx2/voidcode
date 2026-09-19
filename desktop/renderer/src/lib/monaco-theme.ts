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
 * WHY NOT `vs-dark`. Its palette is louder than anything else on the page, so
 * the editor reads as a third-party widget embedded in the product rather than
 * as part of it. That judgement is unchanged.
 *
 * IT WAS MONOCHROME, AND IS NOT ANY MORE. Ten greyscale rules: keywords clipped
 * to white and bold, comments down at #555, everything else between, so the
 * luminance ramp carried the grouping hue would have. The note here said "if
 * this proves too flat in real use, the fix is a desaturated hue set in `RULES`
 * below and it is a one-file change", and that is what this is — asked for
 * directly, after the editor came back to Build Mode and became a surface people
 * read their own code in rather than a demo.
 *
 * THE RAMP IS PRESERVED, WHICH IS THE PART A NAIVE HUE SWAP BREAKS. Hue is added
 * *on top of* the existing luminance grouping rather than instead of it: `type`
 * lands at 8.07:1, which is what `#a3a3a3` measured; `string` and `delimiter`
 * stay in the 6:1 band where `#848484` sat; and `keyword` is still the loudest
 * token on screen, above plain text and bold. Colouring keywords at a typical
 * mid-tone is the usual mistake — it drops them *below* the identifiers around
 * them and the eye stops finding them.
 *
 * COMMENTS GOT BRIGHTER, NOT DIMMER. `#555555` is 2.73:1 against this
 * background, below any legibility threshold; the sage they became is 4.50:1 and
 * is still the most recessive rule in the table, which is the relationship that
 * matters and the one `monaco-theme.test.ts` asserts.
 *
 * THE MARKETING COPY IN `apps/web` STAYS GREYSCALE, deliberately. That page's
 * identity is monochrome and its demo is a static placeholder that must not
 * flash when Monaco swaps in, so its own theme and `CodeStatic.tsx` keep the old
 * table and keep mirroring each other. This file no longer mirrors them, and the
 * claim that it did has been removed rather than left to rot.
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
 * Token rules — a desaturated hue set, with the luminance ramp of the greyscale
 * table it replaces.
 *
 * Monaco wants hex WITHOUT the leading `#`, which is why these are bare and the
 * `colors` map below is not. Getting that wrong fails silently — the rule is
 * dropped and you get the inherited `vs-dark` colour, which looks like the theme
 * "didn't apply" rather than like one malformed line. `monaco-theme.test.ts`
 * asserts the shape for that reason.
 *
 * Contrasts are against `editor.background` (#050506), WCAG relative luminance:
 *
 *   keyword          e0d8ec  14.75  lavender, bold, the loudest token
 *   (default)/ident  d4d4d4  13.74  neutral, unchanged
 *   type / attr.name 8fa6b8   8.07  steel      — the rung #a3a3a3 held
 *   tag / annotation a79ec0   8.05  lavender, not bold
 *   operator         b39ba4   7.90  muted rose
 *   regexp           7fa39d   7.40  teal
 *   number / escape  a68f76   6.61  sand
 *   string / attr.v  7f9479   6.22  sage-green — the band #848484 held
 *   delimiter/metatag 868f97  6.20  cool grey
 *   comment.doc      748176   4.99  sage, italic
 *   comment          6b7a70   4.50  sage, italic, the most recessive rule
 *   invalid          ef4444   5.41  --red-500, and see below
 *
 * `invalid` is the one rule that is not part of that ramp. It is a status
 * colour, the same `--red-500` the Problems pane and the diff use, and it is
 * exempt from the chroma ceiling the test applies to everything else — for the
 * same reason marker colours are: it marks the rare place something is wrong
 * rather than colouring every character on screen.
 */
const RULES = [
  { token: "", foreground: "d4d4d4" },
  { token: "comment", foreground: "6b7a70", fontStyle: "italic" },
  { token: "comment.doc", foreground: "748176", fontStyle: "italic" },
  { token: "keyword", foreground: "e0d8ec", fontStyle: "bold" },
  { token: "string", foreground: "7f9479" },
  { token: "string.escape", foreground: "a68f76" },
  // JSON keys arrive as `string.key.json`, so longest-prefix wins over `string`
  // and a key reads as a name rather than as a value.
  { token: "string.key", foreground: "8fa6b8" },
  { token: "number", foreground: "a68f76" },
  { token: "regexp", foreground: "7fa39d" },
  { token: "type", foreground: "8fa6b8" },
  { token: "type.identifier", foreground: "8fa6b8" },
  { token: "identifier", foreground: "d4d4d4" },
  { token: "delimiter", foreground: "868f97" },
  { token: "operator", foreground: "b39ba4" },
  { token: "tag", foreground: "a79ec0" },
  { token: "attribute.name", foreground: "8fa6b8" },
  { token: "attribute.value", foreground: "7f9479" },
  // Python decorators and Java annotations.
  { token: "annotation", foreground: "a79ec0" },
  // Doctype, shebang, XML processing instructions.
  { token: "metatag", foreground: "868f97" },
  { token: "invalid", foreground: "ef4444" },
] as const;

/**
 * The colour a token scope paints, for code rendered outside the editor.
 *
 * Monaco's `editor.tokenize()` returns scopes like `keyword.ts` or `string.python`; the rules
 * above are keyed by prefix. Longest match wins, so `type.identifier` beats `type`, exactly as
 * Monaco's own theme resolution does.
 *
 * Exported so `markdown/CodeBlock.tsx` paints chat code blocks from the same table the editor
 * uses. The alternative — a second palette for chat — drifts the first time either is touched,
 * and a code block that is nearly the editor's colours reads as a rendering bug.
 *
 * Returns a `#`-prefixed CSS colour. `RULES` stores them bare because Monaco wants them that
 * way, and CSS does not.
 */
export function colourForToken(scope: string): string {
  // `string`, not the inferred literal: `RULES` is `as const`, so `RULES[0].foreground` types
  // as `"d4d4d4"` and nothing else can be assigned to it.
  let best: string = RULES[0].foreground;
  let bestLength = -1;

  for (const rule of RULES) {
    if (rule.token === "") continue;
    if (scope !== rule.token && !scope.startsWith(`${rule.token}.`)) continue;
    if (rule.token.length > bestLength) {
      best = rule.foreground;
      bestLength = rule.token.length;
    }
  }

  return `#${best}`;
}

/** Whether a scope is drawn bold or italic, so chat code matches the editor's weight too. */
export function styleForToken(scope: string): { bold: boolean; italic: boolean } {
  for (const rule of RULES) {
    if (rule.token === "") continue;
    if (scope !== rule.token && !scope.startsWith(`${rule.token}.`)) continue;
    const style = "fontStyle" in rule ? String(rule.fontStyle) : "";
    if (style !== "") return { bold: style.includes("bold"), italic: style.includes("italic") };
  }
  return { bold: false, italic: false };
}

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

  /*
    Diagnostics, brackets and the hover widget.

    NAMED BECAUSE `inherit: true` OTHERWISE TAKES vs-dark's, and those are the
    loudest thing that would then be on this surface: a saturated blue-red
    squiggle set and a four-colour bracket palette, both of which appear in
    ordinary code rather than in the rare place something is wrong. The token
    rules above would be carefully desaturated and the chrome would shout over
    them.

    THE MARKER COLOURS ARE THE SAME TWO THE PROBLEMS PANE USES, and they are
    saturated on purpose while the tokens are not — they are status, not syntax,
    so they mark a handful of positions rather than every character. A squiggle
    and its row in the list must agree, or the list reads as being about
    something else. `globals.css` holds them as `--color-problem-*`; they are
    literals here because Monaco parses these itself and a `var()` resolves to
    nothing.

    The bracket colours are the token palette's own three, so a matched pair
    reads as punctuation rather than as a fifth colour system.
  */
  "editorError.foreground": "#ef4444",
  "editorWarning.foreground": "#fbbf24",
  "editorInfo.foreground": "#8fa6b8",
  "editorOverviewRuler.errorForeground": "#ef444499",
  "editorOverviewRuler.warningForeground": "#fbbf2499",
  "editorOverviewRuler.infoForeground": "#8fa6b866",
  "editorOverviewRuler.border": "#00000000",
  "editorHoverWidget.background": "#0d0d0f",
  "editorHoverWidget.border": "#262626",
  "editorHoverWidget.foreground": "#d4d4d4",
  "editorHoverWidget.statusBarBackground": "#141416",
  "editorMarkerNavigation.background": "#0d0d0f",
  "editorGutter.background": "#050506",
  "editorBracketMatch.background": "#262626",
  "editorBracketMatch.border": "#3a3a3a",
  "editorBracketHighlight.foreground1": "#a79ec0",
  "editorBracketHighlight.foreground2": "#8fa6b8",
  "editorBracketHighlight.foreground3": "#7f9479",
  "editorBracketHighlight.unexpectedBracket.foreground": "#ef4444",
  "editorLink.activeForeground": "#8fa6b8",
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
