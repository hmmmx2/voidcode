"use client";

import ChatMessage from "@/components/VoidCodeAI/ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/lib/mock-data";
import type { TutorMode } from "./demo-script";
import { cn } from "@/lib/utils";

/**
 * Right column — the tutor.
 *
 * `ChatMessage` and, through it, `ThinkingBlock` are imported unforked from the
 * real product. That is the whole point of having a demo: what a visitor sees
 * here is what they get after signing in, down to the token count in the
 * thinking block and the markdown renderer's code-fence styling.
 *
 * The mode badge keeps the real bracketed-monospace form from
 * `ReviewTemplateBlock.tsx` (`[TEACHING]`, `[DEBUG]`) because that shape is the
 * recognisable part. It does not keep that component's blue/purple/amber
 * palette, which would put four hues on a monochrome page. DEBUG stays red, and
 * only because it agrees with the failing-test dots directly to its left —
 * one semantic colour, used consistently, rather than a decorative set.
 */
export function DemoTutorPanel({
  mode,
  messages,
  streamingId,
  chips,
  onChip,
  disabled = false,
  footer,
}: {
  mode: TutorMode | null;
  messages: ChatMessageType[];
  streamingId?: string | null;
  chips: string[];
  onChip?: (chip: string) => void;
  disabled?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <section
      aria-label="AI tutor"
      className="flex min-w-0 flex-col border-t border-line bg-void-1 lg:border-l lg:border-t-0"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-strong bg-[#262626] px-3">
        <span className="text-xs font-medium text-ink">VoidCode AI</span>
        {mode && (
          <span
            className={cn(
              "ml-auto font-mono text-[11px]",
              mode === "DEBUG" ? "text-red-400" : "text-ink-3"
            )}
          >
            [{mode}]
          </span>
        )}
      </div>

      <div
        aria-live="polite"
        className="min-h-[19rem] flex-1 space-y-4 overflow-y-auto px-3.5 py-4 lg:min-h-0"
      >
        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-ink-3">
            Ask for the answer. See what happens.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            isStreaming={message.id === streamingId}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-3.5 py-3">
        {chips.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                disabled={disabled}
                onClick={() => onChip?.(chip)}
                className="rounded-full border border-line-strong px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink disabled:opacity-40"
              >
                {chip}
              </button>
            ))}
          </div>
        )}
        {footer}
      </div>
    </section>
  );
}
