"use client";

import { useState } from "react";
import type { ThinkingMeta, TokenUsage } from "@/lib/mock-data";

interface ThinkingBlockProps {
  content: string;
  tokenCount: number;
  thinkingMeta?: ThinkingMeta;
  usage?: TokenUsage;
  /** Pass true while the model is still generating thinking tokens */
  isStreaming?: boolean;
  defaultOpen?: boolean;
}

// ── Inline markdown formatter ────────────────────────────────────────────────
function applyInlineFormatting(text: string): string {
  return text
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-ide-code px-1 py-0.5 rounded text-[11px] font-mono text-ink-2">$1</code>'
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong class='text-ink-2'>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, "<em>$1</em>");
}

// ── Lightweight renderer for thinking text ───────────────────────────────────
// Supports headings, ordered/unordered lists, code fences, horizontal rules,
// blank lines, and inline bold/italic/code.
function renderThinkingContent(content: string) {
  const parts: React.ReactNode[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let listItems: { text: string; type: "ul" | "ol" }[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length === 0) return;
    const type = listItems[0].type;
    const items = listItems.splice(0);
    if (type === "ol") {
      parts.push(
        <ol key={key++} className="list-decimal list-outside pl-5 space-y-0.5 my-1">
          {items.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: applyInlineFormatting(item.text) }} />
          ))}
        </ol>
      );
    } else {
      parts.push(
        <ul key={key++} className="list-disc list-outside pl-5 space-y-0.5 my-1">
          {items.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: applyInlineFormatting(item.text) }} />
          ))}
        </ul>
      );
    }
  }

  for (const line of lines) {
    // Code fence
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        parts.push(
          <pre key={key++} className="bg-ide-code rounded p-2 text-[11px] font-mono text-ink-2 overflow-x-auto my-1.5">
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushList();
      parts.push(<hr key={key++} className="border-line/60 my-2" />);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const cls = level <= 2
        ? "font-semibold text-ink-2 mt-2 mb-0.5"
        : "font-medium text-ink-2 mt-1.5 mb-0.5";
      parts.push(
        <p key={key++} className={cls}
          dangerouslySetInnerHTML={{ __html: applyInlineFormatting(headingMatch[2]) }} />
      );
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (listItems.length > 0 && listItems[0].type === "ol") flushList();
      listItems.push({ text: ulMatch[1], type: "ul" });
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listItems.length > 0 && listItems[0].type === "ul") flushList();
      listItems.push({ text: olMatch[1], type: "ol" });
      continue;
    }

    flushList();

    // Blank line
    if (line.trim() === "") {
      parts.push(<div key={key++} className="h-1.5" />);
      continue;
    }

    // Normal paragraph
    parts.push(
      <p key={key++} className="leading-relaxed"
        dangerouslySetInnerHTML={{ __html: applyInlineFormatting(line) }} />
    );
  }

  flushList();
  if (inCodeBlock && codeLines.length > 0) {
    parts.push(
      <pre key={key++} className="bg-ide-code rounded p-2 text-[11px] font-mono text-ink-2 overflow-x-auto my-1.5">
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
  }

  return parts;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function ThinkingBlock({
  content,
  tokenCount,
  thinkingMeta,
  usage,
  isStreaming = false,
  defaultOpen = false,
}: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const thinkingTokens = thinkingMeta?.tokenCount ?? tokenCount;
  const hasContent = content.length > 0;

  return (
    <div className="my-1">
      {/* ── Toggle button ─────────────────────────────────────────────────── */}
      <button
        onClick={() => { if (!isStreaming) setIsOpen((o) => !o); }}
        className="flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink-2 transition-colors select-none cursor-pointer"
        aria-expanded={isOpen}
      >
        {/* Brain icon */}
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"
          className="shrink-0 text-ink-3"
        >
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-3.16Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-3.16Z" />
        </svg>

        {isStreaming ? (
          /* Animated dots while thinking is in progress */
          <span className="flex items-center gap-1 italic text-ink-2">
            Thinking
            <span className="flex gap-0.5 items-end h-3 ml-0.5">
              <span className="w-0.5 h-1 bg-ink-3 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-0.5 h-1.5 bg-ink-3 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-0.5 h-1 bg-ink-3 rounded-full animate-bounce [animation-delay:300ms]" />
            </span>
          </span>
        ) : (
          <span className="italic">
            Thought for{" "}
            <span className="text-ink-2 not-italic">
              {thinkingTokens.toLocaleString()} tokens
            </span>
          </span>
        )}

        {/* Chevron — only when done */}
        {!isStreaming && (
          <svg
            width="9" height="6" viewBox="0 0 10 7" fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={`transition-transform duration-200 ml-0.5 ${isOpen ? "rotate-180" : ""}`}
          >
            <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </button>

      {/* ── Expanded content ──────────────────────────────────────────────── */}
      {isOpen && !isStreaming && (
        <div className="mt-2 pl-3 border-l-2 border-line-strong/30 text-[12px] text-ink-2 leading-relaxed max-h-72 overflow-y-auto space-y-0.5 pr-1">
          {hasContent ? (
            renderThinkingContent(content)
          ) : (
            <span className="italic text-ink-3">No thinking content captured.</span>
          )}

          {/* Token usage footer */}
          {usage && (
            <div className="pt-2 mt-2 border-t border-line flex items-center gap-4 text-[11px] text-ink-3">
              <span>Prompt: {usage.promptTokens.toLocaleString()}</span>
              <span>Completion: {usage.completionTokens.toLocaleString()}</span>
              <span>Total: {usage.totalTokens.toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
