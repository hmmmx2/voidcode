/**
 * Turning our message shape into each provider's.
 *
 * One file, two functions, tested together — rather than the conversion living inline in
 * `ollama.ts` and `openai.ts`. The shapes differ in ways that are easy to get right once and
 * then fix in only one of the two places six months later:
 *
 *   **Ollama** takes images at the *message* level, in an `images: []` array of bare base64,
 *   with `content` staying a plain string. It has no notion of content parts.
 *
 *   **OpenAI-compatible** takes an array of content parts, and images as a `data:` URL inside
 *   an `image_url` object. Crucially, `system` and `tool` turns must still be plain strings —
 *   several servers that accept parts on a user turn reject them anywhere else, and the
 *   failure is a 400 on the whole request rather than a degraded reply.
 *
 * Both paths pass a plain string straight through. That is what keeps every existing caller
 * working and is why `tests/inference.test.ts` needed no edits.
 */
import type { ChatMessage, ContentBlock, ImageMediaType, MessageContent } from "./types.js";

/** The text of a message, with any images dropped. */
export function flattenText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function imagesOf(content: MessageContent): Array<{ data: string; mediaType: ImageMediaType }> {
  if (typeof content === "string") return [];
  return content.filter(
    (block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image"
  );
}

export interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

/**
 * Our messages, as Ollama wants them.
 *
 * A `tool` turn becomes `role: "tool"`, which Ollama accepts; the id is dropped because it has
 * no field for one and correlates by position instead.
 */
export function toOllamaMessages(messages: readonly ChatMessage[]): OllamaMessage[] {
  return messages.map((message) => {
    const images = imagesOf(message.content).map((image) => image.data);
    const base: OllamaMessage = {
      role: message.role,
      content: flattenText(message.content),
      ...(images.length > 0 ? { images } : {}),
    };

    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        ...base,
        // Back to an object, because that is the shape Ollama emits and expects. `ToolCall`
        // keeps the raw text so a malformed argument survives to the dispatcher; here it has
        // to be re-parsed, and an unparseable one is sent as an empty object rather than
        // failing the whole request over a turn the model itself produced.
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: safeParse(call.argumentsJson) },
        })),
      };
    }

    return base;
  });
}

export interface OpenAIMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export function toOpenAIMessages(messages: readonly ChatMessage[]): OpenAIMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        // Always a plain string. A parts array on a tool turn is rejected outright by
        // several servers that accept one on a user turn.
        content: flattenText(message.content),
        tool_call_id: message.toolCallId,
        name: message.name,
      };
    }

    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: flattenText(message.content),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      };
    }

    // System turns flatten too, for the same server-compatibility reason.
    if (message.role === "system" || typeof message.content === "string") {
      return { role: message.role, content: flattenText(message.content) };
    }

    return {
      role: message.role,
      content: message.content.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : {
              type: "image_url",
              // The `data:` prefix is added here rather than stored, so the base64 is held
              // once in the shorter form and each provider builds what it needs.
              image_url: { url: `data:${block.mediaType};base64,${block.data}` },
            }
      ),
    };
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
