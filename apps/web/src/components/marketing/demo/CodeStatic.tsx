import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * Static syntax-highlighted code.
 *
 * This is not a stopgap — it is the permanent renderer for two cases. Below
 * `md` Monaco never loads at all (it is a poor experience on touch, and skipping
 * it removes ~2 MB of third-party CDN traffic from the majority of mobile
 * visits), and it is what the server sends before Monaco hydrates anywhere.
 *
 * Highlighting is monochrome by value rather than by hue, which is both on-brand
 * and, at this size, more legible than colour would be: keywords clip to white,
 * comments drop to #555, everything else sits between.
 */

const PATTERN = new RegExp(
  [
    /("""[\s\S]*?"""|"[^"\n]*"|'[^'\n]*')/.source, // 1 string
    /(#[^\n]*)/.source, // 2 comment
    /\b(import|from|def|return|if|elif|else|for|while|class|not|is|in|and|or|None|True|False|lambda)\b/
      .source, // 3 keyword
    /\b(torch|math|self)\b/.source, // 4 module
    /\b(\d+(?:\.\d+)?)\b/.source, // 5 number
  ].join("|"),
  "g"
);

const CLASS_BY_GROUP: Record<number, string> = {
  1: "text-[#848484]",
  2: "text-[#555555] italic",
  3: "text-[#ffffff] font-medium",
  4: "text-[#a3a3a3]",
  5: "text-[#a3a3a3]",
};

function tokenize(code: string) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of code.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(code.slice(last, index));

    const group = match.findIndex((value, i) => i > 0 && value !== undefined);
    nodes.push(
      <span key={key++} className={CLASS_BY_GROUP[group]}>
        {match[0]}
      </span>
    );
    last = index + match[0].length;
  }

  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

export function CodeStatic({
  code,
  className,
  showCaret = false,
}: {
  code: string;
  className?: string;
  showCaret?: boolean;
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  let cursor = 0;

  return (
    <pre
      className={cn(
        "overflow-x-auto bg-editor-bg px-0 py-4 font-mono text-[13px] leading-6 text-[#d4d4d4]",
        className
      )}
    >
      <code>
        {lines.map((line, i) => {
          const start = cursor;
          cursor += line.length + 1;
          return (
            <Fragment key={i}>
              <span className="inline-block w-10 shrink-0 select-none pr-4 text-right text-[#555555]">
                {i + 1}
              </span>
              <span className="pr-6">{tokenize(code.slice(start, start + line.length))}</span>
              {showCaret && i === lines.length - 1 && (
                <span className="ml-px inline-block h-[1.1em] w-[1px] translate-y-[0.2em] animate-pulse bg-ink" />
              )}
              {"\n"}
            </Fragment>
          );
        })}
      </code>
    </pre>
  );
}
