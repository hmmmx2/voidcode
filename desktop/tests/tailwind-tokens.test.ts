/**
 * Every colour utility names a token that exists.
 *
 * ── WHY THIS IS A WHOLE TEST FILE FOR WHAT LOOKS LIKE A TYPO ──────────────────────────────────
 *
 * Under Tailwind v4's `@theme inline`, a utility naming a token that does not exist compiles to
 * **nothing at all**. Not a fallback, not `unset`, not a warning — no rule is emitted. So
 * `focus-visible:ring-primary` beside `focus-visible:outline-none` removes the native focus ring and
 * replaces it with nothing, and the only way to notice is to press Tab and look.
 *
 * Two live instances when this was written, and the second was not the one anybody was looking for:
 *
 *   - `(prep)/projects/page.tsx` — `ring-primary` with `outline-none`, so **keyboard focus on every
 *     project card was invisible**. `ProjectDetail.tsx` had it right with `ring-ink`.
 *   - `markdown/Markdown.tsx` — `text-accent` and `decoration-accent` on links, so **every link in
 *     rendered markdown had no colour**, in the surface the tutor's answers come through.
 *
 * `--color-primary`, `--color-accent` and `--color-ring` were all deleted from `globals.css` in a
 * palette cleanup, and its comment claims each had "zero consumers … verified by grep". They had
 * three between them. A grep for a token *name* does not find a utility that spells it differently,
 * which is exactly why this reads the utilities instead.
 *
 * `design-spec.test.ts`'s `unknownTokens` is the same idea one level in — it checks a design document
 * against the token list. This checks the code. Composing rather than duplicating: both answer "does
 * this name resolve", for different inputs.
 *
 * ── WHY AN ALLOWLIST RATHER THAN A CLEVERER REGEX ─────────────────────────────────────────────
 *
 * Most Tailwind prefixes are overloaded: `text-` is colour *and* font size *and* alignment, `border-`
 * is colour *and* width *and* side *and* style. There is no pattern that separates them, so the
 * non-colour values are listed explicitly below. That list is short, and being explicit is the point
 * — a loose regex here would either fail on `text-sm` or quietly stop checking anything.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCssTokens } from "../src/main/design/tokens.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Utility prefixes whose value is a colour.
 *
 * Order matters: the longest form has to come first or the alternation matches the short one and
 * leaves the rest in the value. `ring-offset-void-0` read as `ring` + `offset-void-0` reports a
 * missing token called "offset-void-0", and `border-t-line-strong` as `border` + `t-line-strong`
 * does the same — both were false positives on the first run.
 */
const COLOUR_PREFIXES = [
  "ring-offset",
  // Side-qualified borders take a colour: `border-t-line-strong` is real.
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "border-x",
  "border-y",
  "bg",
  "text",
  "border",
  "ring",
  "outline",
  "fill",
  "stroke",
  "divide",
  "from",
  "via",
  "to",
  "placeholder",
  "accent",
  "caret",
  "decoration",
  "shadow",
] as const;

/**
 * Values these prefixes take that are not colours.
 *
 * Derived from what the tree actually contains rather than from the Tailwind reference, so it stays
 * small. A new one appearing is a one-line addition with a reader who can see why.
 */
const NOT_A_COLOUR = new Set([
  // CSS-wide and Tailwind keywords that are colours but never tokens.
  "transparent",
  "current",
  "currentColor",
  "inherit",
  "white",
  "black",
  "none",
  "auto",
  // Font sizes.
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  // Text alignment.
  "left",
  "center",
  "right",
  "justify",
  // Border sides, widths and styles; `divide-x|y`.
  "t",
  "b",
  "l",
  "r",
  "x",
  "y",
  "solid",
  "dashed",
  "dotted",
  "inset",
  // `border-collapse` / `border-separate` are table properties, not colours.
  "collapse",
  "separate",
  // SVG presentation attributes that look like utilities in JSX.
  "dasharray",
  "dashoffset",
  "width",
  "linecap",
  "linejoin",
]);

/** `2xl`, `3xl`… and bare widths like `border-2`, `ring-1`, `border-b-0`. */
const NUMERIC = /^\d/;
/** Arbitrary values: `bg-[#fff]`, `text-[13px]`, `ring-[color:var(--x)]`. */
const ARBITRARY = /^\[/;

function definedColours(): Set<string> {
  const css = fs.readFileSync(path.join(root, "renderer/src/app/globals.css"), "utf8");
  return new Set(
    parseCssTokens(css)
      .map((token) => token.name)
      .filter((name) => name.startsWith("color-"))
      .map((name) => name.slice("color-".length))
  );
}

function rendererSources(dir = path.join(root, "renderer/src"), found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rendererSources(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

interface Usage {
  file: string;
  utility: string;
  value: string;
}

/** Every colour-utility usage in the renderer, with variants (`hover:`, `focus-visible:`) stripped. */
function colourUsages(): Usage[] {
  /**
   * A utility sits at a class-list boundary: start of string, whitespace, quote, backtick, the colon
   * after a variant, or `{` from a template expression. Anchoring on that avoids matching inside a
   * longer identifier.
   *
   * The backtick comes from `String.fromCharCode` rather than an escape: this pattern lives in a
   * character class inside a string, and every way of writing a literal backtick there is either a
   * parse error or unreadable.
   */
  const BACKTICK = String.fromCharCode(96);
  const boundary = "(?:^|[\\s\"'" + BACKTICK + ":{])";
  const prefixes = "(" + COLOUR_PREFIXES.join("|") + ")";
  const value = "([A-Za-z0-9[][A-Za-z0-9[\\]._/#()-]*)";
  const pattern = new RegExp(boundary + prefixes + "-" + value, "g");

  const usages: Usage[] = [];
  for (const file of rendererSources()) {
    const source = fs.readFileSync(file, "utf8");
    // Comments stripped: `Pill.tsx` explains in prose that `ring-ring` was removed, and a comment
    // naming a dead token is documentation rather than a usage.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const match of code.matchAll(pattern)) {
      const prefix = match[1] as string;
      // Opacity is not part of the token name: `bg-white/5` is the `white` colour at 5%.
      const value = (match[2] as string).split("/")[0] as string;
      usages.push({ file: path.relative(root, file).replace(/\\/g, "/"), utility: `${prefix}-${value}`, value });
    }
  }
  return usages;
}

describe("colour utilities resolve to tokens that exist", () => {
  const colours = definedColours();
  const usages = colourUsages();

  it("finds the tokens and the usages", () => {
    /**
     * Both halves, because either being empty makes the assertion below vacuous — and a silently
     * vacuous test is the exact failure mode of the defect it guards.
     */
    expect(colours.size, "no --color-* tokens parsed from globals.css").toBeGreaterThan(20);
    expect(usages.length, "no colour utilities found in the renderer").toBeGreaterThan(200);
    // A token that is definitely there, so a parser change cannot pass by returning junk.
    expect(colours).toContain("ink");
  });

  it("names no colour that globals.css does not define", () => {
    const unresolved = usages
      .filter(({ value }) => !ARBITRARY.test(value))
      .filter(({ value }) => !NUMERIC.test(value))
      .filter(({ value }) => !NOT_A_COLOUR.has(value))
      .filter(({ value }) => !colours.has(value));

    /**
     * The message names the file, because the point of failing is that someone opens it — under
     * `@theme inline` there is nothing in the compiled CSS to find, and no browser warning either.
     */
    const report = [...new Set(unresolved.map((u) => `${u.utility} (${u.file})`))].sort();
    expect(report, "utilities naming a token that does not exist — these compile to nothing").toEqual(
      []
    );
  });

  it("resolves every var(--color-*) inside globals.css itself", () => {
    /**
     * The other half of "does this name resolve", and it was missing.
     *
     * Utilities are not the only consumers. The custom scrollbar rules at the bottom of `globals.css`
     * read `var(--color-muted)` and `var(--color-muted-foreground)` directly, and deleting either
     * token survived the assertion above untouched — mutation testing caught it. A `var()` pointing
     * at a deleted property is an invalid value: the declaration is dropped and the scrollbar quietly
     * reverts to the platform default.
     *
     * This is also what makes the token pruning in this commit safe to repeat. Zero utilities is not
     * zero consumers.
     */
    const css = fs.readFileSync(path.join(root, "renderer/src/app/globals.css"), "utf8");
    // Comments carry token names as prose — this file explains at length which ones were deleted.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

    const referenced = [...rules.matchAll(/var\(--(color-[a-z0-9-]+)\)/g)].map((m) => m[1] as string);
    expect(referenced.length, "no var(--color-*) references found — the regex stopped matching")
      .toBeGreaterThan(2);

    const defined = new Set(parseCssTokens(css).map((token) => token.name));
    const dangling = [...new Set(referenced.filter((name) => !defined.has(name)))].sort();

    expect(dangling, "var() references to tokens that no longer exist").toEqual([]);
  });
});
