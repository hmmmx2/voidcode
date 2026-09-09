/**
 * The provider-agnostic inference surface (spec §2.7).
 *
 * One interface, four implementations, capability-flagged. Capabilities are declared
 * rather than assumed because the paper pipeline depends on structured output and the
 * copilot depends on fill-in-the-middle — and silently degrading either produces
 * garbage that looks like an answer. A caller that needs `grammar` and gets a provider
 * without it should be told, not handed prose where JSON was required.
 */

export type ProviderId = "ollama" | "llamacpp" | "openrouter";

export interface ProviderCapabilities {
  /** Tool/function calling. */
  tools: boolean;
  /** Constrained decoding — GBNF, `format: json`, or a JSON schema. */
  grammar: boolean;
  /** Text leaves the machine. Drives the "cloud active" indicator (§1.0 point 5). */
  remote: boolean;
}

/** What a vision model will accept. A closed set, because it is validated at the boundary. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/**
 * One piece of a message.
 *
 * `data` is bare base64 with no `data:` prefix — Ollama wants it that way and the OpenAI form
 * is built by prepending, so storing the shorter one means one conversion rather than two.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: ImageMediaType };

/**
 * A bare string stays legal, and that is the migration lever.
 *
 * Every existing caller passes a string and none of them change. `tests/inference.test.ts`
 * passing unmodified is the proof that the text path is untouched — if it needed edits, this
 * union would have become a breaking change wearing a compatible-looking type.
 */
export type MessageContent = string | ContentBlock[];

/**
 * A model asking for a tool to be run.
 *
 * `argumentsJson` is the raw text as emitted, not a parsed object. Models produce malformed
 * JSON routinely, and parsing here would make that a transport error — losing the chance to
 * hand the model its own mistake and let it correct itself. `agent/dispatch.ts` parses, and
 * turns a failure into a tool *result*.
 */
export interface ToolCall {
  /** Provider-supplied where there is one; minted otherwise (Ollama omits it). */
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * A tool the model may call.
 *
 * `parameters` is JSON Schema. It is derived in main from the same zod schema the dispatcher
 * validates against, so the shape the model is told about and the shape that is enforced
 * cannot drift.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A conversation turn.
 *
 * Split by role rather than one shape with optional fields, so a `tool` turn cannot be built
 * without the id it is answering — which is the field OpenAI-compatible servers reject the
 * whole request over if it is missing.
 */
export type ChatMessage =
  | { role: "system"; content: MessageContent }
  | { role: "user"; content: MessageContent }
  | { role: "assistant"; content: MessageContent; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: MessageContent };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for JSON. Providers without `grammar` must reject rather than ignore it. */
  json?: boolean;
  /**
   * Whether the model should reason before answering. Omitted means "the model's default".
   *
   * `false` is for calls where deliberation is not merely unnecessary but harmful, and there is
   * one: grading. `interview-assess.ts` asks for a short fixed-format verdict and bounds the
   * budget to 700 tokens on the stated grounds that "grading is not generation" — but a reasoning
   * model spends that same budget thinking, and measured against `qwen3:8b` it ran out before
   * answering on **two of three identical calls**. The result was an empty assessment stored as a
   * benign `unknown`.
   *
   * A budget number cannot fix that, because the right number differs per model. Turning off a
   * mode the task never wanted can.
   *
   * Ignored by providers that have no equivalent, which is why it is a request hint rather than a
   * capability in `assertCapable`: a model that cannot reason satisfies `reasoning: false`
   * already, so there is nothing to reject.
   */
  reasoning?: boolean;
  /**
   * Tools the model may call.
   *
   * NEVER SUPPLIED BY THE RENDERER. Chosen in main from the surface, exactly as the persona
   * is — see `personas.ts`. Letting a page name its own tools would be the same class of
   * hole as letting it supply a system prompt.
   */
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
}

/**
 * One streamed chunk.
 *
 * `done` arrives exactly once per successful stream. `error` is terminal and mutually
 * exclusive with it — a consumer that sees neither knows the stream was abandoned,
 * which is what a killed daemon looks like.
 */
export type ChatChunk =
  | { kind: "token"; text: string }
  /**
   * The model's reasoning, kept apart from its answer.
   *
   * Ollama streams a reasoning model's chain of thought in `message.thinking` and its answer in
   * `message.content`. Nothing here read `thinking`, so a model that reasons first produced no
   * chunks at all until it reached content — and if it never reached content, the turn looked
   * silent. That is why the interview assessor returned empty feedback and a stored `unknown`
   * verdict, which `verdict.ts` documents as the common, benign case: a transport gap was wearing
   * the costume of normal behaviour.
   *
   * A separate kind rather than more `token`s, because reasoning must never reach the learner as
   * an answer. It is a model talking to itself, it frequently contains the solution the tutor is
   * meant to withhold, and `redactReference` in `interview-assess.ts` is a best-effort filter
   * over the *answer* that was never meant to police it.
   */
  | { kind: "reasoning"; text: string }
  /** Emitted once per call, complete. Fragments are reassembled inside the provider. */
  | { kind: "tool_call"; call: ToolCall }
  | {
      kind: "done";
      /**
       * Why the turn ended.
       *
       * Load-bearing, and new: without it nothing downstream can tell "the model finished"
       * from "the model wants tools run and is waiting". An agent loop keyed on anything
       * else either stops early or spins.
       *
       * Optional so every existing consumer keeps compiling; absent reads as "stop".
       */
      finishReason?: "stop" | "tool_calls" | "length";
      promptTokens?: number;
      completionTokens?: number;
    }
  | { kind: "error"; message: string; retryable: boolean };


export interface ModelInfo {
  id: string;
  /** Bytes on disk, when the provider reports it. */
  sizeBytes?: number;
}

/** Progress while downloading a model. */
export interface PullProgress {
  status: string;
  /** 0..1, or undefined while the total is still unknown. */
  fraction?: number;
  completedBytes?: number;
  totalBytes?: number;
}

export interface InferenceProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /** Is the backend reachable right now? Never throws. */
  available(): Promise<boolean>;

  /** Models this backend can serve without a download. */
  listModels(): Promise<ModelInfo[]>;

  chat(request: ChatRequest): AsyncIterable<ChatChunk>;

  /**
   * Download a model. Only Ollama implements this.
   *
   * llama.cpp takes a GGUF path rather than managing a registry, and OpenRouter is
   * remote — there is nothing to pull. Both throw, because a no-op would leave a
   * progress bar that never moves.
   */
  pull?(modelId: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;

  /**
   * Delete a model's weights from this machine. Only Ollama implements this.
   *
   * Present exactly where `pull` is, and for the same reason: a registry you can add to is
   * one you can remove from, and a provider that serves a path or a remote endpoint has
   * nothing to delete. Absent rather than throwing lets the caller tell the difference
   * between "this provider cannot" and "this attempt failed".
   */
  remove?(modelId: string): Promise<void>;

}

/** Thrown when a caller asks for a capability the chosen provider lacks. */
export class UnsupportedCapabilityError extends Error {
  constructor(provider: ProviderId, capability: keyof ProviderCapabilities) {
    super(`${provider} does not support ${capability}`);
    this.name = "UnsupportedCapabilityError";
  }
}
