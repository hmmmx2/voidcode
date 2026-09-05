import type { ChatMessage as ChatMessageType } from "@/lib/mock-data";
import ThinkingBlock from "./ThinkingBlock";

interface ChatMessageProps {
  message: ChatMessageType;
  /** True while this is the last message and tokens are still streaming */
  isStreaming?: boolean;
}

/** Apply inline markdown formatting to a plain text string and return safe HTML. */
function applyInlineFormatting(text: string): string {
  return text
    // Inline code — must run before bold/italic to avoid double-processing
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-ide-code px-1 py-0.5 rounded text-xs font-mono text-ink-2">$1</code>'
    )
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Italic (single asterisk or underscore, not adjacent to word chars on both sides of **)
    .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, "<em>$1</em>");
}

function renderContent(content: string) {
  const parts: React.ReactNode[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let key = 0;

  /** Flush any accumulated list items into a <ul> or <ol> element. */
  function flushList() {
    if (listItems.length === 0) return;
    if (listType === "ol") {
      parts.push(
        <ol key={key++} className="list-decimal list-outside pl-5 space-y-0.5 my-1 text-sm leading-relaxed">
          {listItems.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: applyInlineFormatting(item) }} />
          ))}
        </ol>
      );
    } else {
      parts.push(
        <ul key={key++} className="list-disc list-outside pl-5 space-y-0.5 my-1 text-sm leading-relaxed">
          {listItems.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: applyInlineFormatting(item) }} />
          ))}
        </ul>
      );
    }
    listItems = [];
    listType = null;
  }

  for (const line of lines) {
    // ── Code fence ────────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        parts.push(
          <pre
            key={key++}
            className="bg-ide-code rounded-lg p-3 text-sm font-mono text-ink-2 overflow-x-auto my-2"
          >
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        codeLines = [];
        codeLang = "";
        inCodeBlock = false;
      } else {
        flushList();
        codeLang = line.slice(3).trim(); // e.g. "python"
        void codeLang; // used for future syntax highlighting
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // ── Horizontal rule  (---, ***, ___)  ─────────────────────────────────────
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushList();
      parts.push(<hr key={key++} className="border-line my-3" />);
      continue;
    }

    // ── ATX Headings  (# ## ### #### )  ──────────────────────────────────────
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const text = applyInlineFormatting(headingMatch[2]);
      const headingClass: Record<number, string> = {
        1: "text-lg font-bold text-ink mt-4 mb-1",
        2: "text-base font-bold text-ink mt-3 mb-1",
        3: "text-sm font-bold text-ink mt-3 mb-0.5",
        4: "text-sm font-semibold text-ink-2 mt-2 mb-0.5",
      };
      parts.push(
        <p
          key={key++}
          className={headingClass[level] ?? headingClass[4]}
          dangerouslySetInnerHTML={{ __html: text }}
        />
      );
      continue;
    }

    // ── Unordered list items  (* text  or  - text)  ───────────────────────────
    const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (listType === "ol") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    // ── Ordered list items  (1. text)  ────────────────────────────────────────
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType === "ul") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }

    // ── Not a list item — flush pending list  ─────────────────────────────────
    flushList();

    // ── Blank line  ───────────────────────────────────────────────────────────
    if (line.trim() === "") {
      parts.push(<br key={key++} />);
      continue;
    }

    // ── Normal paragraph  ─────────────────────────────────────────────────────
    parts.push(
      <p
        key={key++}
        className="text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: applyInlineFormatting(line) }}
      />
    );
  }

  // Flush any trailing list or unclosed code block
  flushList();
  if (inCodeBlock && codeLines.length > 0) {
    parts.push(
      <pre
        key={key++}
        className="bg-ide-code rounded-lg p-3 text-sm font-mono text-ink-2 overflow-x-auto my-2"
      >
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
  }

  return parts;
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
          <div className="text-ink space-y-1">
            {renderContent(message.content)}
          </div>
        </div>
      )}
    </div>
  );
}
