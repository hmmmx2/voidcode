/**
 * Markdown to a node tree. No React, no DOM, no HTML.
 *
 * Split from the renderer so the parser can be tested exhaustively against strings, and — more
 * importantly — so that **nothing in this file can produce markup**. It returns data. The
 * renderer turns data into React elements. That separation is what makes escaping structural
 * rather than a function somebody has to remember to call.
 *
 * That is the actual fix here. `ChatMessage.tsx` built HTML strings from model output with
 * `applyInlineFormatting` and injected them with `dangerouslySetInnerHTML`, without escaping
 * `<` — so `<img src=x onerror=…>` from a model reached a renderer holding the `host` bridge,
 * under a CSP that allows `unsafe-inline` on the stated grounds that model output is "rendered
 * as text, never as HTML". A tree of plain objects cannot do that however carelessly it is
 * consumed.
 *
 * **Streaming is a first-class case.** The assistant renders while tokens arrive, so this sees
 * half a fence and a bold run with one asterisk constantly. Every construct closes implicitly
 * at end of input; nothing is dropped for being incomplete. Text that vanishes mid-sentence and
 * reappears is worse than text that is briefly unstyled.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  /** Nested lists, which is the one nesting a chat answer actually uses. */
  sublist: Block | null;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "para"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "math"; text: string }
  | { kind: "quote"; children: Inline[] }
  | { kind: "rule" }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A table row's cells, with the outer pipes dropped. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const lang = (fence[1] ?? "").trim();
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (FENCE.test(lines[i] ?? "")) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i] ?? "");
        i += 1;
      }
      const text = body.join("\n");
      // `math` is the one fence that is not code. It routes to KaTeX, and it is deliberately
      // an explicit opt-in construct rather than inline `$…$` scanning — see `Markdown.tsx`.
      blocks.push(
        lang === "math" ? { kind: "math", text } : { kind: "code", lang, text, closed }
      );
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    // A table needs its divider row to be a table at all — otherwise a line containing a pipe
    // is just a line containing a pipe, which in a coding assistant it very often is.
    if (line.includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        rows.push(cells(lines[i] ?? "").map(parseInline));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const match = QUOTE.exec(lines[i] ?? "");
        if (match === null) break;
        quoted.push(match[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(quoted.join(" ")) });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // A paragraph runs to a blank line or the start of another construct, so authored line
    // wrapping does not become rendered line breaks.
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current) ||
        QUOTE.test(current) ||
        RULE.test(current)
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    blocks.push({ kind: "para", children: parseInline(para.join(" ")) });
  }

  return blocks;
}

/**
 * One list, and any list nested inside it.
 *
 * Indentation decides nesting. Two spaces is the common minimum and four is the other common
 * choice, so anything deeper than the opening indent counts rather than a fixed step — a model
 * that indents by three would otherwise produce a flat list with stray spaces.
 */
function parseList(lines: readonly string[], start: number): [Block, number] {
  const first = BULLET.exec(lines[start] ?? "") ?? NUMBERED.exec(lines[start] ?? "");
  const baseIndent = (first?.[1] ?? "").length;
  const ordered = BULLET.exec(lines[start] ?? "") === null;

  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (match === null) break;

    const indent = (match[1] ?? "").length;
    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      const [nested, next] = parseList(lines, i);
      const last = items[items.length - 1];
      // A nested list with no parent item is malformed markdown; keeping it as its own item
      // shows the content rather than discarding it.
      if (last === undefined) items.push({ children: [], sublist: nested });
      else last.sublist = nested;
      i = next;
      continue;
    }

    // Ordered and unordered do not mix in one list — a switch starts a new one.
    const isBullet = BULLET.exec(line) !== null;
    if (isBullet === ordered) break;

    items.push({ children: parseInline(match[2] ?? ""), sublist: null });
    i += 1;
  }

  return [{ kind: "list", ordered, items }, i];
}

/**
 * Inline spans.
 *
 * Code first and unconditionally: everything inside a backtick run is literal, so `**not
 * bold**` inside code stays as written. Getting that order wrong is how a renderer mangles the
 * one thing a coding assistant emits most.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";

  const flush = (): void => {
    if (text !== "") out.push({ kind: "text", text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    // `` `code` ``, and ``` ``code with a backtick`` ``` too.
    const code = /^(`+)([\s\S]*?)\1/.exec(rest);
    if (code !== null) {
      flush();
      out.push({ kind: "code", text: code[2] ?? "" });
      i += code[0].length;
      continue;
    }

    // [label](href). The href is validated at render time, not here — the parser's job is to
    // say what was written, and deciding which schemes may be clicked is a policy question.
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      out.push({ kind: "link", href: link[2] ?? "", children: parseInline(link[1] ?? "") });
      i += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(rest);
    if (strong !== null) {
      flush();
      out.push({ kind: "strong", children: parseInline(strong[2] ?? "") });
      i += strong[0].length;
      continue;
    }

    // Single `*`, but not one that is part of `**`.
    const em = /^(\*)(?!\*)([\s\S]+?)\1(?!\*)/.exec(rest);
    if (em !== null) {
      flush();
      out.push({ kind: "em", children: parseInline(em[2] ?? "") });
      i += em[0].length;
      continue;
    }

    /**
     * `_emphasis_`, but never inside a word — `snake_case_names` must survive.
     *
     * The preceding character is read from `source`, not matched with a lookbehind: the regex
     * runs against `rest`, which is a slice starting at `i`, so a lookbehind there sees the
     * start of the slice and not the character actually before it. That is the sort of thing
     * that works on the first test string and fails on every one after it.
     */
    const previous = i === 0 ? "" : (source[i - 1] ?? "");
    if (previous === "" || !/[A-Za-z0-9_]/.test(previous)) {
      const emUnderscore = /^_(?!_)([\s\S]+?)_(?![A-Za-z0-9_])/.exec(rest);
      if (emUnderscore !== null) {
        flush();
        out.push({ kind: "em", children: parseInline(emUnderscore[1] ?? "") });
        i += emUnderscore[0].length;
        continue;
      }
    }

    text += source[i];
    i += 1;
  }

  flush();
  return out;
}
