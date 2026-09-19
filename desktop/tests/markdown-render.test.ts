/**
 * What the renderer actually emits.
 *
 * `markdown.test.ts` proves the parse tree cannot hold markup. That is half the claim. The
 * other half — that React writes those strings as escaped text rather than as elements — is
 * asserted here, against real rendered output, because "React escapes text nodes" is exactly
 * the kind of thing that is true until a component reaches for an HTML sink and nobody notices.
 *
 * `renderToStaticMarkup` rather than a DOM: it needs no jsdom, and the escaped-vs-live question
 * is answered by the string. If `<img` appears unescaped in the output, the browser would have
 * built an element from it — that is the whole test.
 *
 * JSX is avoided so this stays a `.ts` file matching the runner's existing `include` pattern.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "@/components/markdown/Markdown";
import { paintTokens, type Token } from "@/components/markdown/CodeBlock";
import { colourForToken, styleForToken } from "@/lib/monaco-theme";

const render = (source: string): string =>
  renderToStaticMarkup(createElement(Markdown, { source }));

describe("the payload from the bug", () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';

  it("escapes it instead of emitting an element", () => {
    const html = render(`Look: ${PAYLOAD}`);

    /**
     * The whole payload, entity-escaped — the characters a reader sees, in a text node.
     *
     * Note what is *not* asserted: that the string "onerror=alert" is absent. It is present,
     * and must be, because the user asked to be shown that text. What makes it inert is that
     * its `<` and `>` are `&lt;`/`&gt;`, so the parser never opens a tag and there is no
     * element for an attribute to attach to. An assertion on the attribute name alone would
     * fail on correct output, which is how a real fix gets reverted to satisfy a test.
     */
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    // Rendered as prose inside the paragraph, not as a child element of it.
    expect(html).toMatch(/<span>Look: &lt;img[^<]*&gt;<\/span>/);
  });

  it("escapes it inside every construct, not just paragraphs", () => {
    // A guard that holds for prose and leaks through a list item is not a guard. Each of these
    // is a different code path in `renderInline`/`renderBlock`.
    const sources = [
      `# ${PAYLOAD}`,
      `- ${PAYLOAD}`,
      `1. ${PAYLOAD}`,
      `> ${PAYLOAD}`,
      `**${PAYLOAD}**`,
      `*${PAYLOAD}*`,
      `\`${PAYLOAD}\``,
      `[${PAYLOAD}](https://example.com)`,
      `| a |\n| --- |\n| ${PAYLOAD} |`,
      "```html\n" + PAYLOAD + "\n```",
    ];

    for (const source of sources) {
      const html = render(source);
      expect(html, `leaked from: ${source}`).not.toContain("<img");
      expect(html, `dropped from: ${source}`).toContain("&lt;img");
    }
  });

  it("escapes a script tag and its contents", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("links", () => {
  it("emits an anchor only for https, matching the main-process guard", () => {
    const html = render("[docs](https://example.com/x)");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('target="_blank"');
    // The renderer is privileged; a new window must not get an opener handle to it.
    expect(html).toContain("noopener");
  });

  it("renders javascript: and data: as text, with no anchor at all", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "http://example.com",
    ]) {
      const html = render(`[click](${href})`);
      expect(html, `anchor emitted for ${href}`).not.toContain("<a ");
      expect(html, `label lost for ${href}`).toContain("click");
    }
  });
});

describe("ordinary rendering", () => {
  it("produces the elements the markdown asked for", () => {
    const html = render(
      ["# Title", "", "Some **bold** and `code`.", "", "- one", "- two"].join("\n")
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("renders a fenced block as text when monaco has not loaded", () => {
    // Server-side there is no Monaco, which is the same state the panel is in on first paint.
    // The code must still be readable — degrading to plain text, never to nothing.
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;");
  });

  it("keeps a table's cells", () => {
    const html = render("| flag | meaning |\n| --- | --- |\n| -v | verbose |");
    expect(html).toContain("<table");
    expect(html).toContain("verbose");
  });
});

describe("the other half: what a fence looks like once monaco HAS loaded", () => {
  /**
   * THE ASSERTION ABOVE PASSES HARDEST WHEN SOMETHING IS WRONG, which is why this exists.
   *
   * "renders a fenced block as text when monaco has not loaded" is a real and necessary
   * property — but plain text is also exactly what a silently broken Monaco produces, and that
   * is not hypothetical: the loader was pointed at a CDN the CSP blocks on every route without
   * a mounted editor, so every code block in the Build assistant's transcript rendered as plain
   * text and this file was green throughout. See `tests/monaco-loader.test.ts`.
   *
   * ASSERTED AGAINST THE MAPPING, NOT A RENDER, because the painting happens in a
   * `useEffect` and `renderToStaticMarkup` does not run effects — there is no DOM in this
   * suite, and adding one to cover this would be a larger change than the property is worth.
   * `paintTokens` is exported from `CodeBlock` for exactly this, and it is where both of the
   * available off-by-ones live.
   */
  const python = (): Token[][] => [
    // `def softmax(x):` — offsets as Monaco reports them: a scope starts at each offset and
    // runs until the next one.
    [
      { offset: 0, type: "keyword.python" },
      { offset: 3, type: "" },
      { offset: 4, type: "identifier.python" },
      { offset: 11, type: "delimiter.parenthesis.python" },
    ],
    [{ offset: 0, type: "comment.python" }],
  ];

  it("slices each token to the start of the next one, and the last to end of line", () => {
    const lines = paintTokens("def softmax(x):\n# shift-invariant", python());

    expect(lines[0]?.map((s) => s.text)).toEqual(["def", " ", "softmax", "(x):"]);
    /**
     * The last token is the one with an off-by-one available: its end is the line's length, not
     * its own offset. Getting that wrong drops the tail of every line, which reads as a
     * truncated file rather than as a highlighting bug.
     */
    expect(lines[0]?.at(-1)?.text).toBe("(x):");
    expect(lines[1]?.map((s) => s.text)).toEqual(["# shift-invariant"]);
  });

  it("colours and styles them from the editor's own theme table", () => {
    const lines = paintTokens("def softmax(x):\n# shift-invariant", python());

    // Not hard-coded hexes: the point is that chat and the editor read one table, so a theme
    // change moves both. A literal here would pass while they diverged.
    expect(lines[0]?.[0]).toMatchObject({
      colour: colourForToken("keyword.python"),
      ...styleForToken("keyword.python"),
    });
    expect(lines[1]?.[0]).toMatchObject({
      colour: colourForToken("comment.python"),
      ...styleForToken("comment.python"),
    });
    // And the colours actually differ, or the table is not being consulted at all.
    expect(lines[0]?.[0]?.colour).not.toBe(lines[1]?.[0]?.colour);
  });

  it("emits a line monaco tokenized as nothing, rather than dropping it", () => {
    // A blank line, and a line past the end of what the tokenizer returned. Both must survive:
    // losing them silently renumbers every line below, and line numbers are how a diagnostic
    // points at code.
    const lines = paintTokens("a\n\nb", [[{ offset: 0, type: "identifier" }]]);

    expect(lines).toHaveLength(3);
    expect(lines[1]?.[0]?.text).toBe("");
    expect(lines[2]?.[0]?.text).toBe("b");
    expect(lines[2]?.[0]?.colour).toBe(colourForToken(""));
  });
});
