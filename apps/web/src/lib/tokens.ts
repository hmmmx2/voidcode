/**
 * Layout constants for the resizable workspace shell.
 *
 * A `colors` export used to live here too — a third parallel colour system
 * alongside `globals.css` and ~417 inline hex literals. Nothing imported it, and
 * three sources of truth for one palette is two too many, so it was removed.
 * Colour now lives only in `src/app/globals.css` as Tailwind v4 `@theme` tokens.
 *
 * These numbers stay in TypeScript rather than CSS because `ResizableLayout`
 * does pointer-drag arithmetic with them — they are inputs to a calculation,
 * not styling values.
 */
export const layout = {
  columnCount: 3,
  columnMinWidth: 15,
  columnMaxWidth: 60,
  leftDefault: 24,
  middleDefault: 48,
  rightDefault: 28, // DEMO: AI panel wide (from the original 16) for a readable tutor; the solution is split into short lines so the fix "+ 1" still fits the editor. Revert to 25 after filming.
  middleSplitDefault: 60,
  topNavHeight: 48,
  gapSize: 4,
} as const;
