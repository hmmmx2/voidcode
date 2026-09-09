"use client";

import { useState } from "react";
import type { ThinkingMeta, TokenUsage } from "@/lib/mock-data";
import Markdown from "@/components/markdown/Markdown";

interface ThinkingBlockProps {
  content: string;
  tokenCount: number;
  thinkingMeta?: ThinkingMeta;
  usage?: TokenUsage;
  /** Pass true while the model is still generating thinking tokens */
  isStreaming?: boolean;
  defaultOpen?: boolean;
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
            <Markdown source={content} className="text-[12px] text-ink-2" />
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
