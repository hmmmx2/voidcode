/**
 * Reassembling streamed tool calls, and declaring tools to each provider.
 *
 * THE ACCUMULATOR IS THE FIDDLIEST CODE IN THIS PHASE, and it is fiddly for a reason worth
 * stating: an OpenAI-compatible server does not send a tool call, it sends *fragments* of one.
 * Across many SSE frames you get
 *
 *   {index: 0, id: "call_abc", function: {name: "read_file", arguments: ""}}
 *   {index: 0,                 function: {                  arguments: "{\\"pa"}}
 *   {index: 0,                 function: {                  arguments: "th\\": \\"a.py\\"}"}}
 *
 * — the `id` and `name` only on the first fragment, and `arguments` as partial JSON that is
 * invalid at every intermediate step. Parallel calls interleave, distinguished only by
 * `index`. Get this wrong and the failure mode is "the agent occasionally does nothing",
 * which is the hardest bug shape there is to chase: no error, no log, just a turn that
 * accomplished nothing.
 *
 * Ollama is the easy case and still needs converting: it sends the whole call in one frame,
 * with `arguments` as an **object** rather than a string, and historically with no `id`.
 */
import { randomUUID } from "node:crypto";
import type { ToolCall, ToolDefinition } from "./types.js";

/**
 * One in-flight call, keyed by the `index` the server assigns it.
 *
 * `| undefined` rather than `?`, because `exactOptionalPropertyTypes` is on for this project
 * and these fields are genuinely absent-then-present as fragments arrive — assigning
 * `undefined` to them has to be legal.
 */
interface PartialCall {
  id: string | undefined;
  name: string | undefined;
  argumentsJson: string;
}

/** The fragment shape an OpenAI-compatible server streams. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Collects fragments until the turn ends.
 *
 * Deliberately stateful and deliberately not an async generator: a call is only complete when
 * `finish_reason` arrives, so nothing can be emitted as it streams without emitting something
 * unparseable.
 */
export class ToolCallAccumulator {
  private readonly partials = new Map<number, PartialCall>();

  push(delta: ToolCallDelta): void {
    // Absent index means a single call, which some servers do send. Defaulting to 0 rather
    // than dropping it is the difference between working and silently doing nothing.
    const index = delta.index ?? 0;
    const existing = this.partials.get(index) ?? {
      id: undefined,
      name: undefined,
      argumentsJson: "",
    };

    this.partials.set(index, {
      // First fragment wins for id and name; later ones omit them entirely, and `??` would
      // be wrong here only if a server re-sent a *different* id, which none do.
      id: existing.id ?? delta.id,
      name: existing.name ?? delta.function?.name,
      // Concatenated as text, never parsed mid-stream: every intermediate state is invalid
      // JSON by construction.
      argumentsJson: existing.argumentsJson + (delta.function?.arguments ?? ""),
    });
  }

  /** True when there is anything to flush, so a turn with no tools stays a plain answer. */
  get pending(): boolean {
    return this.partials.size > 0;
  }

  /**
   * The completed calls, in index order.
   *
   * A fragment set with no name is dropped: it cannot be dispatched, and inventing a name
   * would turn a provider glitch into a wrong tool being run. Arguments that never arrived
   * become `{}` rather than an empty string, so the dispatcher's parse succeeds and the
   * *schema* rejects it — which produces a message the model can act on.
   */
  flush(): ToolCall[] {
    const calls = [...this.partials.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, partial]) =>
        partial.name === undefined
          ? []
          : [
              {
                id: partial.id ?? randomUUID(),
                name: partial.name,
                argumentsJson: partial.argumentsJson === "" ? "{}" : partial.argumentsJson,
              },
            ]
      );

    this.partials.clear();
    return calls;
  }
}

/** Ollama's shape: whole call, one frame, `arguments` as an object, usually no id. */
export interface OllamaToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

export function fromOllamaToolCalls(raw: readonly OllamaToolCall[]): ToolCall[] {
  return raw.flatMap((call) => {
    const name = call.function?.name;
    if (name === undefined) return [];
    const args = call.function?.arguments;
    return [
      {
        // Minted, because Ollama does not supply one and the id is what a `tool` turn has to
        // quote back for an OpenAI-compatible server to accept the follow-up.
        id: call.id ?? randomUUID(),
        name,
        // Re-serialised so both providers hand the dispatcher the same thing: raw text it
        // parses itself.
        argumentsJson: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    ];
  });
}

/** Tool definitions in the shape both providers accept — they agree on this one. */
export function toWireTools(
  tools: readonly ToolDefinition[]
): Array<{ type: "function"; function: ToolDefinition }> {
  return tools.map((tool) => ({ type: "function" as const, function: tool }));
}
