/**
 * The editor's palette: desaturated, legible, and still carrying the luminance ramp it replaced.
 *
 * WHY THESE ARE PROPERTIES RATHER THAN A LIST OF HEXES. A snapshot of twenty colour values fails
 * on every deliberate change and says nothing about whether the change was good, so it gets
 * updated without being read. What actually has to hold is a handful of relationships, and each
 * of them is something a plausible edit breaks:
 *
 *   - Monaco wants bare hex in `rules` and `#`-prefixed in `colors`. Getting that wrong fails
 *     SILENTLY: the rule is dropped and the inherited `vs-dark` colour shows, which reads as "the
 *     theme didn't apply" rather than as one malformed line.
 *   - Colour has to stay muted. This palette exists because `vs-dark` was louder than the rest of
 *     the product; pasting in any off-the-shelf theme would undo the decision without discussion.
 *   - Comments have to stay the most recessive rule. They were #555555, which is 2.73:1 against
 *     this background and below any legibility threshold; they got *brighter*, and the thing worth
 *     asserting is the relationship, not the number.
 *   - Markers have to be named. `inherit: true` means anything unlisted comes from vs-dark, and
 *     the squiggle and bracket colours are the loudest things it would contribute.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VOID_THEME_NAME, colourForToken, defineVoidTheme, styleForToken } from "@/lib/monaco-theme";

interface Registered {
  base: string;
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
}

/** Register the theme against a stub and keep what it passed. */
function theme(): Registered {
  let captured: Registered | undefined;
  defineVoidTheme({
    editor: {
      defineTheme(name, value) {
        expect(name).toBe(VOID_THEME_NAME);
        captured = value as Registered;
      },
    },
  });
  expect(captured, "defineVoidTheme registered nothing").toBeDefined();
  return captured as Registered;
}

const BACKGROUND = "050506";

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (
    0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0)
  );
}

function contrast(hex: string, against = BACKGROUND): number {
  const a = luminance(hex);
  const b = luminance(against);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** How far from grey a colour is. 0 is grey; 255 is fully saturated. */
function chroma(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0);
}

/**
 * `invalid` is excluded from the ramp and chroma assertions below.
 *
 * It is a status colour — the same `--red-500` the Problems pane and the diff view use — not a
 * syntax tone. It marks the rare place something is wrong rather than colouring every character,
 * which is the same reason the marker colours may be saturated while the tokens may not.
 */
const STATUS_TOKENS = new Set(["invalid"]);

const syntaxRules = () =>
  theme()
    .rules.filter((rule) => rule.foreground !== undefined)
    .filter((rule) => !STATUS_TOKENS.has(rule.token));

describe("the shape Monaco needs", () => {
  it("gives every rule six bare hex digits, with no leading hash", () => {
    // The silent failure the theme file's own comment names.
    for (const rule of theme().rules) {
      if (rule.foreground === undefined) continue;
      expect(rule.foreground, `${rule.token} is not bare six-digit hex`).toMatch(
        /^[0-9a-f]{6}$/
      );
    }
  });

  it("gives every chrome colour a leading hash", () => {
    // The same mistake in the other direction: `colors` is CSS-shaped and `rules` is not.
    for (const [key, value] of Object.entries(theme().colors)) {
      expect(value, `${key} is not a #-prefixed colour`).toMatch(/^#[0-9a-f]{6,8}$/);
    }
  });

  it("inherits from vs-dark, which is why the chrome below has to be named", () => {
    expect(theme().base).toBe("vs-dark");
    expect(theme().inherit).toBe(true);
  });
});

describe("legibility", () => {
  it("clears 4.5:1 on every syntax rule", () => {
    for (const rule of syntaxRules()) {
      expect(
        contrast(rule.foreground as string),
        `${rule.token} is ${contrast(rule.foreground as string).toFixed(2)}:1 against the editor`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps comments the most recessive rule, and no longer illegible", () => {
    /**
     * A RELATIONSHIP, NOT A NUMBER. Comments were #555555 — 2.73:1, below anything readable — and
     * the point of the change was that they got brighter while staying the quietest thing in the
     * file. Asserting a specific value would pass on a palette where comments had become the
     * loudest rule as long as nobody touched that one line.
     */
    const comments = syntaxRules().filter((r) => r.token.startsWith("comment"));
    const rest = syntaxRules().filter((r) => !r.token.startsWith("comment"));
    expect(comments.length).toBeGreaterThan(0);

    const loudestComment = Math.max(...comments.map((r) => contrast(r.foreground as string)));
    const quietestOther = Math.min(...rest.map((r) => contrast(r.foreground as string)));

    expect(loudestComment, "comments are back below the legibility threshold").toBeGreaterThan(3.5);
    expect(
      loudestComment < quietestOther,
      `a comment at ${loudestComment.toFixed(2)}:1 is louder than another rule at ` +
        `${quietestOther.toFixed(2)}:1`
    ).toBe(true);
  });

  it("keeps keywords the loudest token", () => {
    /**
     * The mistake a naive hue swap makes. Colouring keywords at a typical mid-tone drops them
     * *below* the identifiers around them, and the eye stops finding them — the one thing the
     * greyscale ramp was unambiguously good at.
     */
    const keyword = syntaxRules().find((r) => r.token === "keyword");
    expect(keyword).toBeDefined();
    const loudest = Math.max(...syntaxRules().map((r) => contrast(r.foreground as string)));
    expect(contrast(keyword?.foreground as string)).toBe(loudest);
    expect(keyword?.fontStyle).toContain("bold");
  });
});

describe("desaturated, as a property rather than an adjective", () => {
  it("has hue at all", () => {
    // The floor. Reverting to greyscale fails here, which is what makes "desaturated" checkable
    // rather than a word in a comment.
    const coloured = syntaxRules().filter((r) => chroma(r.foreground as string) >= 8);
    expect(coloured.length, "the palette is grey again").toBeGreaterThanOrEqual(6);
  });

  it("keeps it muted", () => {
    // The ceiling. Pasting in an off-the-shelf theme fails here. Measured against the palette
    // this replaced the decision it embodies, not against a taste.
    for (const rule of syntaxRules()) {
      expect(
        chroma(rule.foreground as string),
        `${rule.token} at chroma ${String(chroma(rule.foreground as string))} is not muted`
      ).toBeLessThanOrEqual(56);
    }
  });

  it("allows a status colour to be saturated, and only a status colour", () => {
    // `invalid` is `--red-500`, the same value the Problems pane and the diff use.
    const invalid = theme().rules.find((r) => r.token === "invalid");
    expect(invalid?.foreground).toBe("ef4444");
    expect(STATUS_TOKENS.size, "the status exemption has grown").toBe(1);
  });
});

describe("the chrome vs-dark would otherwise supply", () => {
  it("names the marker colours", () => {
    /**
     * Without these, squiggles come from vs-dark: a saturated blue-red set that appears in
     * ordinary code and would be the loudest thing on a surface whose tokens were carefully
     * desaturated.
     */
    const colors = theme().colors;
    for (const key of [
      "editorError.foreground",
      "editorWarning.foreground",
      "editorInfo.foreground",
      "editorOverviewRuler.errorForeground",
      "editorOverviewRuler.warningForeground",
    ]) {
      expect(colors[key], `${key} is inherited from vs-dark`).toBeDefined();
    }
  });

  it("agrees with the Problems pane about what an error and a warning look like", () => {
    /**
     * A squiggle and its row in the list are the same finding. If they disagree, the list reads
     * as being about something else. `globals.css` is the other half of this pair.
     */
    const css = readFileSync(
      path.resolve(__dirname, "..", "renderer", "src", "app", "globals.css"),
      "utf8"
    );
    const token = (name: string): string | undefined =>
      new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1];

    expect(theme().colors["editorError.foreground"]).toBe(token("--red-500"));
    expect(theme().colors["editorWarning.foreground"]).toBe(token("--amber-400"));
  });

  it("names the bracket colours, from the token palette", () => {
    // vs-dark's bracket-pair palette is four saturated hues in ordinary punctuation.
    const colors = theme().colors;
    const brackets = [
      "editorBracketHighlight.foreground1",
      "editorBracketHighlight.foreground2",
      "editorBracketHighlight.foreground3",
    ].map((key) => colors[key]?.slice(1));

    for (const colour of brackets) {
      expect(colour, "a bracket colour is inherited").toBeDefined();
      expect(
        syntaxRules().some((r) => r.foreground === colour),
        `bracket colour ${String(colour)} is not one of the token colours`
      ).toBe(true);
    }
  });

  it("names the hover widget, which carries a diagnostic's message", () => {
    const colors = theme().colors;
    expect(colors["editorHoverWidget.background"]).toBeDefined();
    expect(colors["editorHoverWidget.border"]).toBeDefined();
  });
});

describe("resolving a scope to a colour", () => {
  it("takes the longest matching prefix", () => {
    /**
     * Monaco's own rule, and the reason `type.identifier` and `string.key` can differ from `type`
     * and `string`. Reordering `RULES` or flipping the comparison to `>=` breaks it silently: the
     * first match wins instead, and JSON keys turn back into strings.
     */
    expect(colourForToken("type.identifier.ts")).toBe(colourForToken("type.identifier"));
    expect(colourForToken("string.key.json")).not.toBe(colourForToken("string.python"));
    expect(colourForToken("keyword.python")).toBe(colourForToken("keyword"));
  });

  it("falls back to the default for a scope with no rule", () => {
    expect(colourForToken("something.monaco.has.never.emitted")).toBe(colourForToken(""));
    expect(colourForToken("")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns a CSS colour, because this one is used outside the editor", () => {
    // `markdown/CodeBlock.tsx` paints chat fences from this table, and CSS wants the hash that
    // Monaco refuses.
    expect(colourForToken("keyword")).toMatch(/^#/);
  });

  it("reports bold and italic for the two rules that have them, and nothing else", () => {
    expect(styleForToken("keyword.ts")).toEqual({ bold: true, italic: false });
    expect(styleForToken("comment.python")).toEqual({ bold: false, italic: true });
    expect(styleForToken("identifier")).toEqual({ bold: false, italic: false });
  });
});

describe("the marketing copy, which deliberately did not change", () => {
  it("keeps its own greyscale table and no longer claims this file mirrors it", () => {
    /**
     * `apps/web`'s demo is a static placeholder that must not flash when Monaco swaps in, and its
     * page is monochrome by identity. This file used to claim it mirrored
     * `marketing/demo/CodeStatic.tsx` "exactly"; it does not any more, and a stale claim of
     * agreement is worse than an acknowledged divergence — it invites someone to "fix" one side.
     */
    const here = readFileSync(
      path.resolve(__dirname, "..", "renderer", "src", "lib", "monaco-theme.ts"),
      "utf8"
    );
    expect(here).not.toContain("mirror `marketing/demo/CodeStatic.tsx`'s hand tokenizer\n * exactly");
    expect(here, "the divergence is not explained").toContain("apps/web");
  });
});
