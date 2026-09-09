"use client";

import type { JSX } from "react";
import { Math } from "@/components/app/Math";
import { cn } from "@/lib/utils";
import CodeBlock from "./CodeBlock";
import { parseMarkdown, type Block, type Inline } from "./parse";

/**
 * The one markdown renderer.
 *
 * It replaces four hand-rolled ones, and it exists to close a real hole rather than to remove
 * duplication. `Prose.tsx` argued against a parser dependency on the grounds that *"there is no
 * untrusted input here: every byte comes from `paper_content.py`, which is code-reviewed"*. That
 * is true of `Prose`. The argument was then copied to `ChatMessage.tsx`, where the input is
 * **model output**, and `applyInlineFormatting` there built HTML from it without escaping `<`
 * before injecting it with `dangerouslySetInnerHTML`. The CSP allows `script-src 'unsafe-inline'`
 * on the stated grounds that model output is "rendered as text, never as HTML". Both could not
 * be true, and `<img src=x onerror=…>` from a model reached a renderer holding the `host` bridge.
 *
 * The fix is structural, not a call to an escaping function that a future edit can forget:
 *
 *   - `parse.ts` returns **data**. It has no way to express markup.
 *   - This file renders **React elements**. `dangerouslySetInnerHTML` does not appear in it, and
 *     a test asserts that it never appears anywhere in this directory.
 *
 * React escapes every string it puts in a text position, so `<img src=x onerror=alert(1)>` from a
 * model lands as those 28 characters on screen. Getting that wrong now requires deleting a test
 * and adding an API whose name says what it does.
 *
 * Still no markdown dependency — that part of `Prose`'s reasoning was about weight, and it holds.
 */

/** Only what `windows.ts` will actually open. See `renderInline`. */
function isExternal(href: string): boolean {
  return href.startsWith("https://");
}

function renderInline(nodes: readonly Inline[], keyPrefix: string): JSX.Element[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;

    switch (node.kind) {
      case "text":
        return <span key={key}>{node.text}</span>;

      case "code":
        return (
          <code
            key={key}
            className="rounded bg-ide-code px-1 py-px font-mono text-[0.9em] text-ink"
          >
            {node.text}
          </code>
        );

      case "strong":
        return (
          <strong key={key} className="font-semibold text-ink">
            {renderInline(node.children, key)}
          </strong>
        );

      case "em":
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key)}
          </em>
        );

      case "link": {
        /**
         * `https:` only, and as plain text otherwise.
         *
         * This needs no new IPC channel, which is the point. `windows.ts:326-350` already
         * installs `setWindowOpenHandler` and a `will-navigate` guard that hand `https://` to
         * the OS browser and refuse everything else — including `javascript:`, `file:` and
         * `data:`. Matching that exact condition here means the two cannot drift; an
         * `open-external` channel would be a second policy to keep in step with the first.
         *
         * `target="_blank"` routes the click through `setWindowOpenHandler` rather than
         * `will-navigate`. Both refuse, so this is belt and braces; `rel` is there because the
         * renderer is privileged and a new window must not get an opener handle to it.
         */
        if (!isExternal(node.href)) {
          return <span key={key}>{renderInline(node.children, key)}</span>;
        }
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink underline decoration-ink-3 underline-offset-2 transition-colors hover:decoration-ink"
          >
            {renderInline(node.children, key)}
          </a>
        );
      }
    }
  });
}

function renderBlock(block: Block, key: string): JSX.Element {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      const size =
        block.level <= 2 ? "text-[15px]" : block.level === 3 ? "text-[14px]" : "text-[13px]";
      return (
        <Tag key={key} className={cn("mt-3 mb-1 font-semibold text-ink first:mt-0", size)}>
          {renderInline(block.children, key)}
        </Tag>
      );
    }

    case "para":
      return (
        <p key={key} className="my-1.5 leading-relaxed first:mt-0 last:mb-0">
          {renderInline(block.children, key)}
        </p>
      );

    case "code":
      // `closed` is false while the fence is still streaming; the block says so rather than
      // waiting for the terminator, so text never appears and then vanishes.
      return <CodeBlock key={key} code={block.text} lang={block.lang} streaming={!block.closed} />;

    case "math":
      return <Math key={key} latex={block.text} display />;

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={cn(
            "my-1.5 space-y-1 pl-5",
            block.ordered ? "list-decimal" : "list-disc",
            "marker:text-ink-3"
          )}
        >
          {block.items.map((item, index) => (
            <li key={`${key}.${index}`} className="leading-relaxed">
              {renderInline(item.children, `${key}.${index}`)}
              {item.sublist !== null && renderBlock(item.sublist, `${key}.${index}.sub`)}
            </li>
          ))}
        </Tag>
      );
    }

    case "quote":
      return (
        <blockquote
          key={key}
          className="my-2 border-l-2 border-line pl-3 italic text-ink-2"
        >
          {renderInline(block.children, key)}
        </blockquote>
      );

    case "rule":
      return <hr key={key} className="my-3 border-line" />;

    case "table":
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th
                    key={`${key}.h${index}`}
                    className="border-b border-line px-2 py-1 font-semibold text-ink"
                  >
                    {renderInline(cell, `${key}.h${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}.r${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}.r${rowIndex}.c${cellIndex}`}
                      className="border-b border-line/50 px-2 py-1 align-top text-ink"
                    >
                      {renderInline(cell, `${key}.r${rowIndex}.c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cn("text-[13px] text-ink", className)}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  );
}
