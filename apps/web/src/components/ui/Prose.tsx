import { cn } from "@/lib/utils";

/**
 * Renders the markdown subset the paper breakdowns are authored in.
 *
 * WHY NOT `react-markdown`. That pulls remark, rehype, a sanitiser and their
 * plugin graph — several hundred KB — to render six constructs from content
 * this repo authors itself. There is no untrusted input here: every byte comes
 * from `paper_content.py`, which is code-reviewed like any other source file.
 * The usual argument for a real parser is safety against arbitrary user
 * markdown, and that argument does not apply.
 *
 * Supported, deliberately and exhaustively:
 *   `## heading`      section heading
 *   `- item`          bullet list
 *   ```` ```lang ```` fenced code
 *   ```` ```math ```` an equation — see the note below
 *   `**bold**`        emphasis
 *   `` `code` ``      inline code
 *
 * Anything else renders as literal text, which is the honest failure: a table
 * that appears as pipes is obviously wrong and gets fixed, whereas a table
 * silently dropped is not.
 *
 * MATH IS MONOSPACE, NOT TYPESET. KaTeX would need the parser plus its CSS and
 * font files, and the equations here read acceptably as monospace — the
 * `math` fence exists so that when KaTeX does land, only this component
 * changes and no content is rewritten.
 */

type Block =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; lang: string; text: string };

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ kind: "heading", text: line.slice(3).trim() });
      i += 1;
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2).trim());
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // A paragraph runs until a blank line or the start of another construct,
    // so authored line wrapping does not become rendered line breaks.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("## ") &&
      !lines[i].startsWith("- ")
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "para", text: para.join(" ") });
  }

  return blocks;
}

/** `**bold**` and `` `code` ``, nothing else. */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((token, i) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return (
        <strong key={i} className="font-medium text-ink">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-void-3 px-1 py-0.5 font-mono text-[0.85em] text-ink"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    return token;
  });
}

export function Prose({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const blocks = parse(markdown);

  return (
    <div className={cn("space-y-4", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          return (
            <h3
              key={i}
              className="pt-3 text-[15px] font-medium tracking-tight text-ink first:pt-0"
            >
              {block.text}
            </h3>
          );
        }

        if (block.kind === "list") {
          return (
            <ul key={i} className="space-y-2">
              {block.items.map((item, j) => (
                <li
                  key={j}
                  className="flex gap-2.5 text-sm leading-relaxed text-ink-2"
                >
                  <span
                    aria-hidden
                    className="mt-[8px] h-1 w-1 flex-shrink-0 rounded-full bg-ink-3"
                  />
                  <span>{inline(item)}</span>
                </li>
              ))}
            </ul>
          );
        }

        if (block.kind === "code") {
          const isMath = block.lang === "math";
          return (
            <pre
              key={i}
              className={cn(
                "overflow-x-auto rounded-lg border border-line p-3",
                "font-mono text-[12px] leading-relaxed text-ink-2",
                // An equation is a statement, not a program. Centring it and
                // giving it a different ground keeps the two readable as
                // different kinds of thing in a section that has both.
                isMath
                  ? "bg-void-2 text-center text-[13px] text-ink"
                  : "bg-ide-code"
              )}
            >
              <code>{block.text}</code>
            </pre>
          );
        }

        return (
          <p key={i} className="text-sm leading-relaxed text-ink-2">
            {inline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
