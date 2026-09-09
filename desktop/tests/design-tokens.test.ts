/**
 * Reading a project's own design tokens.
 *
 * The property worth having is that generated UI uses the names the project already uses. So the
 * failures that matter are the quiet ones: a token invented out of a comment, a `var()` chain
 * that hangs, and a colour reported for a property that does not resolve to one.
 */
import { describe, it, expect } from "vitest";
import { parseCssTokens } from "../src/main/design/tokens.js";

const find = (css: string, name: string) => parseCssTokens(css).find((t) => t.name === name);

describe("parseCssTokens", () => {
  it("reads properties from :root and from @theme alike", () => {
    // Both are just blocks of custom properties; Tailwind v4 puts semantic tokens in the second.
    const css = `
      :root { --gray-950: #0a0a0a; --gray-500: #848484; }
      @theme inline { --color-ink: var(--gray-950); --radius-md: 8px; }
    `;
    expect(parseCssTokens(css).map((t) => t.name).sort()).toEqual([
      "color-ink",
      "gray-500",
      "gray-950",
      "radius-md",
    ]);
  });

  it("resolves a var() chain to something concrete", () => {
    const css = `
      :root { --gray-950: #0a0a0a; --ink: var(--gray-950); }
      @theme inline { --color-ink: var(--ink); }
    `;
    expect(find(css, "color-ink")?.resolved).toBe("#0a0a0a");
    // The raw value is kept too — it is what the file says, and that is worth showing.
    expect(find(css, "color-ink")?.value).toBe("var(--ink)");
  });

  it("does not invent tokens out of comments", () => {
    /**
     * The failure a well-documented tokens file causes.
     *
     * The file this was written against explains its own layers in prose and names token
     * namespaces while doing it. Without stripping comments first, `--color-*` in a sentence
     * becomes a token whose value is the rest of the sentence.
     */
    const css = `
      /* LAYER 2 — semantic tokens. --color-* generates bg-/text-/border-; --font-* generates font-. */
      :root { --real: #fff; }
    `;
    expect(parseCssTokens(css).map((t) => t.name)).toEqual(["real"]);
  });

  it("does not read a commented-out declaration", () => {
    /**
     * The case that actually needs the comment stripping, and the common one.
     *
     * Naming a namespace in prose — `--color-*` — happens not to match, because there is no
     * colon after it. A token someone commented out while trying a different palette matches
     * perfectly, and comes back as a live token holding the value they rejected.
     */
    const css = `
      :root {
        /* --color-ink: #ff0000; */
        --color-ink: #0a0a0a;
        /* --color-old: #00ff00; */
      }
    `;
    const tokens = parseCssTokens(css);
    expect(tokens.map((t) => t.name)).toEqual(["color-ink"]);
    expect(tokens[0]?.value).toBe("#0a0a0a");
  });

  it("does not read a custom property out of a feature query", () => {
    /**
     * What anchors the matcher to the start of a declaration.
     *
     * `@supports (--x: y)` is real CSS — it is how a stylesheet asks whether custom properties
     * are supported at all. The text inside the parentheses looks exactly like a declaration,
     * and it is a question rather than a definition.
     */
    const css = `
      @supports (--css-variables: yes) {
        :root { --real: #fff; }
      }
    `;
    expect(parseCssTokens(css).map((t) => t.name)).toEqual(["real"]);
  });

  it("does not hang on a cycle", () => {
    // Not usually deliberate: a rename that leaves one half of a pair behind is enough, and
    // without a depth limit the result is a hang with no output to explain it.
    const css = `:root { --a: var(--b); --b: var(--a); }`;
    const tokens = parseCssTokens(css);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) expect(token.resolved).toBeNull();
  });

  it("reports an unresolvable reference as unresolved rather than guessing", () => {
    // A token pointing at a property defined in a file this did not read. Showing the raw
    // `var(--x)` is honest; showing a colour it invented is not.
    const css = `:root { --color-ink: var(--defined-somewhere-else); }`;
    expect(find(css, "color-ink")?.resolved).toBeNull();
    expect(find(css, "color-ink")?.value).toBe("var(--defined-somewhere-else)");
  });

  it("takes a var() fallback when the reference is missing", () => {
    // What a browser does with it, so it is what this does.
    const css = `:root { --color-ink: var(--missing, #ffffff); }`;
    expect(find(css, "color-ink")?.resolved).toBe("#ffffff");
  });

  it("lets a later declaration win, as the cascade does", () => {
    // A tokens file commonly declares a property in `:root` and again in a `.dark` block.
    const css = `
      :root { --color-bg: #ffffff; }
      .dark { --color-bg: #0a0a0a; }
    `;
    expect(find(css, "color-bg")?.resolved).toBe("#0a0a0a");
    expect(parseCssTokens(css)).toHaveLength(1);
  });

  describe("classification", () => {
    it("trusts the Tailwind v4 namespace, which is an API", () => {
      // `--color-*` is what generates bg-/text-/border-, so a property there is a colour by
      // declaration — even when its value is currently something this could not classify.
      const css = `
        @theme inline {
          --color-ink: light-dark(#000, #fff);
          --font-mono: ui-monospace, monospace;
          --radius-md: 8px;
          --spacing-4: 1rem;
          --shadow-card: 0 1px 2px rgb(0 0 0 / 0.1);
        }
      `;
      const kinds = Object.fromEntries(parseCssTokens(css).map((t) => [t.name, t.kind]));
      expect(kinds).toEqual({
        "color-ink": "color",
        "font-mono": "font",
        "radius-md": "radius",
        "spacing-4": "spacing",
        "shadow-card": "shadow",
      });
    });

    it("reads the value for primitives that carry no namespace", () => {
      // Layer 1 ramps — `--gray-950: #0a0a0a` — have no prefix to go on.
      const css = `
        :root {
          --gray-950: #0a0a0a;
          --brand: oklch(0.7 0.2 250);
          --accent: rgb(20 20 20);
          --short: #abc;
          --gap: 1.5rem;
          --label: "Inter";
        }
      `;
      const kinds = Object.fromEntries(parseCssTokens(css).map((t) => [t.name, t.kind]));
      expect(kinds).toEqual({
        "gray-950": "color",
        brand: "color",
        accent: "color",
        short: "color",
        gap: "spacing",
        label: "other",
      });
    });

    it("classifies a namespaced token by what it resolves to, not what it points at", () => {
      // `--ink: var(--gray-950)` is a colour, and its own name says nothing about that.
      const css = `:root { --gray-950: #0a0a0a; --ink: var(--gray-950); }`;
      expect(find(css, "ink")?.kind).toBe("color");
    });

    it("does not call a near-miss a colour", () => {
      const css = `:root { --a: #12; --b: #; --c: rgbish(1 2 3); --d: 12px; }`;
      const kinds = Object.fromEntries(parseCssTokens(css).map((t) => [t.name, t.kind]));
      expect(kinds.a).not.toBe("color");
      expect(kinds.b).not.toBe("color");
      expect(kinds.c).not.toBe("color");
      expect(kinds.d).toBe("spacing");
    });
  });

  it("ignores things that are not custom properties", () => {
    // Ordinary declarations share the file, and `background: red` is not a token.
    const css = `
      body { background: red; margin: 0; }
      @media (min-width: 40rem) { :root { --wide: 1; } }
    `;
    expect(parseCssTokens(css).map((t) => t.name)).toEqual(["wide"]);
  });

  it("is empty for CSS with no tokens, rather than throwing", () => {
    expect(parseCssTokens("")).toEqual([]);
    expect(parseCssTokens("body { color: red }")).toEqual([]);
    expect(parseCssTokens("/* just a comment */")).toEqual([]);
  });

  it("keeps a multi-part value whole", () => {
    // Font stacks and shadow lists contain commas and spaces, and truncating one to its first
    // segment would produce a token that renders differently from the project.
    const css = `:root { --font-sans: ui-sans-serif, system-ui, sans-serif; }`;
    expect(find(css, "font-sans")?.value).toBe("ui-sans-serif, system-ui, sans-serif");
  });
});
