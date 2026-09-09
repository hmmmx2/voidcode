/**
 * The project's own design tokens, read from its own CSS.
 *
 * **The point is that generated UI matches the codebase rather than inventing a parallel
 * system.** A model asked to design a panel will otherwise reach for `#3b82f6` and `1rem`,
 * because those are the values in its training data — and the result looks like a different
 * product bolted on. Handing it the names the project actually uses is the whole difference
 * between a design that lands and one that has to be translated by hand afterwards.
 *
 * **Custom properties only. A JavaScript Tailwind config is deliberately not read.**
 * `tailwind.config.js` is a program: reading it properly means executing it, and executing a
 * file from the user's project is precisely what the preview puts behind a button that names the
 * command. Doing it silently, to populate a panel, would be the same act with none of the
 * consent. Parsing it statically instead is worse than not doing it — a config that spreads a
 * shared preset or computes a ramp in a loop would come back partially read, and a token list
 * that is quietly incomplete is more dangerous than an empty one, because nothing about it looks
 * wrong. Tailwind v4 moved tokens into CSS precisely so they are data; this reads the data.
 *
 * Pure: it takes CSS text and returns tokens, so every shape below is testable without a project.
 */
// Declared in `src/shared` because the renderer draws these — see that file for why.
import type { DesignToken, TokenKind } from "../../shared/design-tokens.js";
export type { DesignToken, TokenKind } from "../../shared/design-tokens.js";

/**
 * Comments, stripped before anything else looks at the text.
 *
 * Not fastidiousness — the file this was written against carries a 30-line header explaining the
 * token layers, and it *names tokens in prose*: "--color-* generates bg-/text-/border-/ring-".
 * A matcher run over the raw text invents `color-*` as a token with a value of "generates". Every
 * well-documented tokens file has this problem, and the better documented it is the worse.
 */
const COMMENTS = /\/\*[\s\S]*?\*\//g;

/**
 * One custom-property declaration.
 *
 * The value runs to the first semicolon, which is correct for every token shape in practice —
 * colours, lengths, font stacks and shadow lists — and wrong only for a value containing a
 * semicolon inside a string, which is not a thing anyone writes in a token.
 */
const DECLARATION = /(?:^|[;{])\s*--([A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g;

/** How deep a `var()` chain may go before it is called a cycle. */
const MAX_RESOLUTION_DEPTH = 10;

export function parseCssTokens(css: string): DesignToken[] {
  const source = css.replace(COMMENTS, "");

  /**
   * Later declarations win, which is what CSS does.
   *
   * A tokens file commonly declares a property in `:root` and then again inside `@theme inline`
   * or a `.dark` block. Keeping the first would report the light value while the app renders the
   * dark one; keeping the last matches the cascade for the common case of one file read top to
   * bottom, and is at least a rule rather than an accident of ordering.
   */
  const byName = new Map<string, string>();
  for (const match of source.matchAll(DECLARATION)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    byName.set(name, trimmed);
  }

  return [...byName.entries()].map(([name, value]) => {
    const resolved = resolve(value, byName, 0);
    return {
      name,
      value,
      resolved,
      // Classified on the resolved value where there is one: `--ink` is a colour if it points at
      // one, and the name alone would never say so.
      kind: classify(name, resolved ?? value),
    };
  });
}

/**
 * Chase `var(--a)` until something concrete comes out.
 *
 * **Depth-limited, because token files contain cycles.** Not usually deliberate ones — a rename
 * that leaves `--x: var(--y)` while `--y: var(--x)` survives elsewhere is enough, and the result
 * without a limit is a hang at startup with no output to explain it. Ten is far past any real
 * chain; three is typical.
 *
 * A `var()` with a fallback — `var(--a, #fff)` — resolves through the fallback when the
 * reference is missing, which is what a browser does with it.
 */
function resolve(value: string, byName: Map<string, string>, depth: number): string | null {
  if (depth > MAX_RESOLUTION_DEPTH) return null;
  if (!value.includes("var(")) return value;

  let unresolved = false;
  const substituted = value.replace(
    /var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g,
    (_whole, reference: string, fallback: string | undefined) => {
      const target = byName.get(reference);
      if (target !== undefined) return target;
      if (fallback !== undefined && fallback.trim() !== "") return fallback.trim();
      unresolved = true;
      return "";
    }
  );

  if (unresolved) return null;
  // Substituting may have introduced another `var()`, which is the whole reason this recurses.
  return resolve(substituted.trim(), byName, depth + 1);
}

/**
 * What sort of token this is, for grouping in a panel and for a model reading the list.
 *
 * Name first, because Tailwind v4 makes the prefix an API — `--color-*` is what generates
 * `bg-`/`text-`/`border-`, so a property under that namespace is a colour by declaration even if
 * its value is currently something odd. Only then the value, which is what catches the Layer 1
 * primitives (`--gray-950: #0a0a0a`) that carry no namespace at all.
 */
function classify(name: string, value: string): TokenKind {
  if (/^color-/.test(name)) return "color";
  if (/^font-/.test(name)) return "font";
  if (/^radius-/.test(name)) return "radius";
  if (/^(spacing|space)-/.test(name)) return "spacing";
  if (/^shadow-/.test(name)) return "shadow";

  if (looksLikeColour(value)) return "color";
  if (/^-?[\d.]+(px|rem|em)$/.test(value)) return "spacing";
  if (/\b\d+px\s+\d+px\b/.test(value)) return "shadow";
  return "other";
}

function looksLikeColour(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  // `#abc`, `#aabbcc`, `#aabbccdd` — and not `#12` or a bare hash.
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(trimmed)) return true;
  // The function forms, including the ones Tailwind v4 emits: oklch and oklab.
  return /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\s*\(/.test(trimmed);
}
