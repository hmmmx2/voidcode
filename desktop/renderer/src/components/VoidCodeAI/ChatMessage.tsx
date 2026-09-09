import type { ChatMessage as ChatMessageType } from "@/lib/mock-data";
import Markdown from "@/components/markdown/Markdown";
import ThinkingBlock from "./ThinkingBlock";

/**
 * One turn in the tutor transcript.
 *
 * The 160 lines of hand-rolled markdown that used to live here are gone, and their removal is
 * a security fix rather than a tidy-up. `applyInlineFormatting` built HTML strings from **model
 * output** and injected them with `dangerouslySetInnerHTML` without ever escaping `<`, so
 * `<img src=x onerror=…>` from a model became a live element in a renderer holding the `host`
 * bridge — under a CSP that permits `script-src 'unsafe-inline'` on the written grounds that
 * model output is "rendered as text, never as HTML".
 *
 * The comment claiming the output was "safe HTML" was the tell: nothing in that function made
 * it safe. `components/markdown/` returns data and renders React elements, so the sink is gone
 * rather than guarded.
 */

interface ChatMessageProps {
  message: ChatMessageType;
  /** True while this is the last message and tokens are still streaming */
  isStreaming?: boolean;
}

export default function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`space-y-2 ${isUser ? "flex justify-end" : ""}`}>
      {isUser ? (
        <div className="bg-void-3 rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[85%]">
          <p className="text-sm text-ink">{message.content}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Thinking block — shown while streaming (animated dots) OR when thinking content exists */}
          {(isStreaming || message.thinking) && (
            <ThinkingBlock
              content={message.thinking ?? ""}
              tokenCount={message.tokenCount ?? 0}
              thinkingMeta={message.thinkingMeta}
              usage={message.usage}
              isStreaming={isStreaming}
            />
          )}

          {/* Message content — text #FFFFFF */}
          <Markdown source={message.content} className="text-sm text-ink" />
        </div>
      )}
    </div>
  );
}
