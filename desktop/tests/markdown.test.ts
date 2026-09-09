/**
 * The markdown parser, and the property that made it worth writing.
 *
 * Two things are being tested and they are not the same thing:
 *
 *   1. **Parsing.** Ordinary correctness, plus the streaming cases — this parser sees half a
 *      fence on every token that arrives.
 *   2. **That markup cannot be produced at all.** The old renderer built HTML strings from model
 *      output and injected them. The replacement's safety is not "we escape `<`" — it is that
 *      the parser returns data with no field that can hold markup, and the renderer emits React
 *      elements. The last two tests are what stop that being quietly undone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown, parseInline, type Inline } from "../renderer/src/components/markdown/parse.js";

/** All text in a node tree, which is what a reader would see. */
function textOf(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        default:
          return textOf(node.children);
      }
    })
    .join("");
}

describe("script injection", () => {
  it("keeps an HTML tag as literal text", () => {
    /**
     * The payload from the bug. Under `applyInlineFormatting` + `dangerouslySetInnerHTML` this
     * became a real `<img>` whose `onerror` ran in a renderer holding the `host` bridge, under
     * a CSP permitting inline script.
     *
     * The assertion is deliberately about the *node kind*, not about escaped entities: there is
     * no HTML here to escape. `<` is an ordinary character in a text node, and React writes it
     * as text. A test looking for `&lt;` would be testing an implementation that does not exist.
     */
    const nodes = parseInline('<img src=x onerror=alert(1)>');
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
    expect(textOf(nodes)).toBe('<img src=x onerror=alert(1)>');
  });

  it("keeps a script tag as literal text, across a block parse too", () => {
    const blocks = parseMarkdown("Here is <script>alert(1)</script> for you.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("para");
    if (blocks[0]?.kind !== "para") throw new Error("unreachable");
    expect(textOf(blocks[0].children)).toBe("Here is <script>alert(1)</script> for you.");
  });

  it("does not treat an HTML block as markup", () => {
    // Real markdown allows raw HTML blocks. This parser deliberately does not, and that is the
    // security property rather than an omission — so it is pinned.
    const blocks = parseMarkdown("<div onclick=\"steal()\">\n\ntext\n");
    expect(blocks.some((b) => b.kind === "para")).toBe(true);
    for (const block of blocks) {
      expect(block.kind).not.toBe("html");
    }
  });

  it("refuses a javascript: link, keeping the label readable", () => {
    /**
     * The parser records the href as written — deciding which schemes may be clicked is the
     * renderer's job, and `Markdown.tsx` accepts `https://` only, matching `windows.ts` exactly.
     * What is asserted here is that the two conditions agree, which is the thing that can drift.
     */
    const nodes = parseInline("[click me](javascript:alert(1))");
    const link = nodes.find((n) => n.kind === "link");
    expect(link?.kind).toBe("link");
    if (link?.kind !== "link") throw new Error("unreachable");
    expect(link.href.startsWith("https://")).toBe(false);

    const source = readFileSync(
      join(__dirname, "../renderer/src/components/markdown/Markdown.tsx"),
      "utf8"
    );
    expect(source).toContain('href.startsWith("https://")');
  });
});

describe("no HTML sink exists", () => {
  /**
   * The structural claim, asserted against the files rather than against behaviour.
   *
   * A behavioural test proves today's inputs are handled. This proves the *capability* is
   * absent — someone adding `dangerouslySetInnerHTML` back to reach for a quick feature has to
   * delete this test to do it, which is a deliberate act rather than an oversight.
   */
  const directory = join(__dirname, "../renderer/src/components/markdown");

  it("has no dangerouslySetInnerHTML anywhere in components/markdown", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(directory)) {
      const body = readFileSync(join(directory, name), "utf8");
      // Skip the prose above that names the API in order to explain why it is not used.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (code.includes("dangerouslySetInnerHTML")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("does not use monaco's colorize, which returns an HTML string", () => {
    // `editor.colorize` and `editor.tokenize` do the same job; only one of them returns tokens.
    // Swapping to `colorize` would need an HTML sink, so it is worth catching at the call site.
    const source = readFileSync(join(directory, "CodeBlock.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("editor.tokenize");
    expect(code).not.toContain("editor.colorize");
  });
});

describe("inline", () => {
  it("parses code spans before emphasis, so code stays literal", () => {
    // The single most common thing a coding assistant emits, and the easiest to mangle.
    const nodes = parseInline("use `a ** b` here");
    const code = nodes.find((n) => n.kind === "code");
    expect(code?.kind).toBe("code");
    if (code?.kind !== "code") throw new Error("unreachable");
    expect(code.text).toBe("a ** b");
    expect(nodes.some((n) => n.kind === "strong")).toBe(false);
  });

  it("handles a code span containing backticks", () => {
    const nodes = parseInline("``a ` b``");
    expect(nodes[0]?.kind).toBe("code");
    if (nodes[0]?.kind !== "code") throw new Error("unreachable");
    expect(nodes[0].text).toBe("a ` b");
  });

  it("reads ** as strong and a lone * as emphasis", () => {
    expect(parseInline("**bold**")[0]?.kind).toBe("strong");
    expect(parseInline("*italic*")[0]?.kind).toBe("em");
  });

  it("leaves snake_case names alone", () => {
    /**
     * The regression that makes a markdown renderer unusable in a coding tool: `_` inside a
     * word is an identifier, not emphasis.
     *
     * The last case is the one with teeth, and it was added after mutation testing showed the
     * first three had none. In `read_file_sync` the closing `_` is followed by `s`, so the
     * *trailing* lookahead already rejects the match and the leading word-boundary check never
     * runs — deleting that check left all three passing. `count_ and size_` is different: the
     * closing underscore ends a word, so only the check on the preceding character stops
     * "and" from being italicised. Trailing-underscore members are ordinary C++ and Python.
     *
     * The fifth is its mirror, and covers the other half of the guard: `_private_helper` starts
     * after a space, so the leading check passes and only the trailing lookahead stops `_private_`
     * matching. Leading-underscore names are ordinary Python. Each case fails a different
     * mutation; between them neither half of the condition can be deleted unnoticed.
     */
    for (const source of [
      "call read_file_sync now",
      "read_file_sync",
      "the arg is max_tool_calls.",
      "fields count_ and size_ are private",
      "call _private_helper first",
    ]) {
      const nodes = parseInline(source);
      expect(nodes.every((n) => n.kind === "text")).toBe(true);
      expect(textOf(nodes)).toBe(source);
    }
  });

  it("still reads _emphasis_ when it stands alone", () => {
    const mid = parseInline("a _word_ b");
    expect(mid.some((n) => n.kind === "em")).toBe(true);
    const start = parseInline("_word_ b");
    expect(start.some((n) => n.kind === "em")).toBe(true);
  });

  it("keeps an unmatched marker as text rather than swallowing the rest", () => {
    // Constant during streaming: the closing marker has not arrived yet.
    expect(textOf(parseInline("**half a bold"))).toBe("**half a bold");
    expect(textOf(parseInline("a `half a code"))).toBe("a `half a code");
  });
});

describe("blocks", () => {
  it("parses headings by level", () => {
    const blocks = parseMarkdown("# One\n\n### Three\n");
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : null))).toEqual([1, 3]);
  });

  it("joins wrapped lines into one paragraph", () => {
    const blocks = parseMarkdown("one line\nand its continuation\n\nsecond para");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind === "para" && textOf(blocks[0].children)).toBe(
      "one line and its continuation"
    );
  });

  it("parses a fenced block with its language", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1;\n```\n");
    expect(blocks[0]).toMatchObject({ kind: "code", lang: "ts", text: "const a = 1;", closed: true });
  });

  it("does not read ** inside a fence as emphasis", () => {
    const blocks = parseMarkdown("```py\na = b ** 2\n```");
    expect(blocks[0]?.kind === "code" && blocks[0].text).toBe("a = b ** 2");
  });

  it("routes a math fence away from code", () => {
    const blocks = parseMarkdown("```math\n\\frac{a}{b}\n```");
    expect(blocks[0]).toMatchObject({ kind: "math", text: "\\frac{a}{b}" });
  });

  it("parses nested lists", () => {
    const blocks = parseMarkdown("- one\n  - nested\n- two\n");
    expect(blocks[0]?.kind).toBe("list");
    if (blocks[0]?.kind !== "list") throw new Error("unreachable");
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[0].items[0]?.sublist?.kind).toBe("list");
    expect(blocks[0].items[1]?.sublist).toBeNull();
  });

  it("does not merge an ordered list into an unordered one", () => {
    const blocks = parseMarkdown("- a\n1. b\n");
    expect(blocks.filter((b) => b.kind === "list")).toHaveLength(2);
  });

  it("needs a divider row before it calls something a table", () => {
    // Pipes turn up in prose and in code output constantly; a table without its divider is not
    // a table, and treating it as one shreds ordinary text.
    const real = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(real[0]?.kind).toBe("table");

    const prose = parseMarkdown("run `a | b` to pipe them\n");
    expect(prose[0]?.kind).toBe("para");
  });

  it("parses quotes and rules", () => {
    expect(parseMarkdown("> quoted\n")[0]?.kind).toBe("quote");
    expect(parseMarkdown("---\n")[0]?.kind).toBe("rule");
  });
});

describe("streaming", () => {
  /**
   * Every prefix of a real answer must parse without throwing and without losing text.
   *
   * The failure this prevents is not a crash — it is text that renders, then disappears when
   * the next token arrives because a construct started matching. That reads as a broken app.
   */
  const answer = [
    "Here is the fix.",
    "",
    "## Steps",
    "",
    "1. Open `main.ts`",
    "2. Replace the call",
    "",
    "```ts",
    "export function go(): void {",
    "  return;",
    "}",
    "```",
    "",
    "| flag | meaning |",
    "| --- | --- |",
    "| `-v` | verbose |",
    "",
    "> Note the **bold** bit and the [docs](https://example.com/x).",
  ].join("\n");

  it("parses every prefix without throwing", () => {
    for (let i = 0; i <= answer.length; i += 1) {
      expect(() => parseMarkdown(answer.slice(0, i))).not.toThrow();
    }
  });

  /** Every character a reader would see, across all blocks. */
  const visible = (source: string): number => {
    let total = 0;
    for (const block of parseMarkdown(source)) {
      switch (block.kind) {
        case "code":
        case "math":
          total += block.text.length;
          break;
        case "heading":
        case "para":
        case "quote":
          total += textOf(block.children).length;
          break;
        case "list":
          for (const item of block.items) total += textOf(item.children).length;
          break;
        case "table":
          for (const cell of block.head) total += textOf(cell).length;
          for (const row of block.rows) for (const cell of row) total += textOf(cell).length;
          break;
        case "rule":
          break;
      }
    }
    return total;
  };

  it("never loses prose as a prefix grows", () => {
    /**
     * Visible-length monotonicity, over the constructs where it is *exactly* true.
     *
     * The bound is the markers a single new character can newly hide: a ``` fence line is the
     * widest at 6. Prose, headings, lists and fences all obey that. Tables and links do not,
     * and deliberately — see the next test, which asserts the drop rather than tolerating it
     * with a fudge factor big enough to hide a real regression.
     */
    const prose = [
      "Here is the fix.",
      "",
      "## Steps",
      "",
      "1. Open `main.ts`",
      "2. Replace the call with the **corrected** one",
      "",
      "```ts",
      "export function go(): void {",
      "  return;",
      "}",
      "```",
      "",
      "> That is the whole change.",
    ].join("\n");

    let previous = 0;
    for (let i = 0; i <= prose.length; i += 1) {
      const now = visible(prose.slice(0, i));
      expect(now).toBeGreaterThanOrEqual(previous - 6);
      previous = now;
    }
  });

  it("hides a divider row and a URL once they are recognised, and only then", () => {
    /**
     * The two legitimate drops, pinned so they stay legitimate.
     *
     * Mid-stream `| --` is prose and renders. One character later it completes a table divider,
     * the line above becomes a header, and the divider stops being text — because it is markup,
     * and a rendered table showing its own `---` row is the bug. Same for `[docs](https://…`:
     * the URL is visible until the `)` arrives, then only the label is.
     *
     * Both are correct. Both look identical to "text vanished" from a character count alone,
     * which is why they are asserted by name here instead of being absorbed into a tolerance.
     */
    expect(visible("| a | b |\n| -")).toBe(13);
    // The divider is recognised: only the two header cells remain.
    expect(visible("| a | b |\n| --")).toBe(2);
    expect(parseMarkdown("| a | b |\n| --")[0]?.kind).toBe("table");

    const open = "see [docs](https://example.com/page";
    expect(visible(open)).toBe(open.length);
    const closed = `${open})`;
    // "see " plus the label. The href is markup and is not shown.
    expect(visible(closed)).toBe("see docs".length);
  });

  it("keeps every piece of content once the answer is complete", () => {
    // The end state, which is what a reader actually reads. Nothing above should be able to
    // pass while content is missing from the finished document.
    const blocks = parseMarkdown(answer);
    const table = blocks.find((b) => b.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") throw new Error("unreachable");
    expect(table.head.map(textOf)).toEqual(["flag", "meaning"]);
    expect(table.rows.map((row) => row.map(textOf))).toEqual([["-v", "verbose"]]);

    const code = blocks.find((b) => b.kind === "code");
    expect(code?.kind === "code" && code.text).toContain("export function go");

    const quote = blocks.find((b) => b.kind === "quote");
    expect(quote?.kind === "quote" && textOf(quote.children)).toBe(
      "Note the bold bit and the docs."
    );
  });

  it("reports an unterminated fence as still open, and keeps its text", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1;\nconst b =");
    expect(blocks[0]).toMatchObject({ kind: "code", closed: false });
    expect(blocks[0]?.kind === "code" && blocks[0].text).toBe("const a = 1;\nconst b =");
  });
});
