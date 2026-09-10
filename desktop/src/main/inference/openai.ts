/**
 * The OpenAI-compatible providers: llama.cpp's `llama-server`, and OpenRouter.
 *
 * One implementation because the wire format is identical; what differs is where the
 * traffic goes and whether a key is attached. That difference is not cosmetic —
 * `remote: true` is what drives the "text just left your machine" indicator (spec §1.0
 * point 5), so it is a constructor argument rather than something inferred from a URL.
 *
 * vLLM also speaks this protocol and can be pointed at through the llama.cpp path. What
 * it deliberately does not get is management: no install, no spawn, no model pull. It
 * has no official Windows wheels and it preallocates most of VRAM, which is wrong for a
 * desktop sharing a GPU with the compositor (spec §2.7).
 */
import { sse } from "./ndjson.js";
import { toOpenAIMessages } from "./normalise.js";
import { ToolCallAccumulator, toWireTools, type ToolCallDelta } from "./tools.js";
import type {
  ChatChunk,
  ChatRequest,
  InferenceProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderId,
} from "./types.js";

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
  /**
   * A VoidCode extension, and shaped so that it is invisible to anything that does not want it.
   *
   * The hosted API sends a queue update as a valid `chat.completion.chunk` with an EMPTY delta
   * plus these two fields. A provider that ignores them -- every other OpenAI-compatible server
   * this class talks to -- sees a chunk with no content and skips it, which is why this parsing
   * is safe to leave switched on for all of them rather than gated behind the provider id.
   */
  type?: string;
  queue?: { position?: number; ahead?: number; backendState?: string };
}

export interface OpenAICompatibleOptions {
  id: ProviderId;
  label: string;
  baseUrl: string;
  capabilities: ProviderCapabilities;
  /**
   * Supplies the bearer token at request time.
   *
   * A getter rather than a string so the key is read from `safeStorage` at the moment of
   * use and never held in this object — nothing that lives long enough to be serialised
   * into a log or a crash dump ends up holding a credential.
   */
  authToken?: () => Promise<string | undefined>;
  /**
   * Extra headers, read at request time for the same reason `authToken` is a getter.
   *
   * The hosted provider needs to say who is asking, and an identity read once at construction
   * would survive a sign-out. Nothing here holds the value.
   */
  extraHeaders?: () => Promise<Record<string, string>>;
}

export class OpenAICompatibleProvider implements InferenceProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.capabilities = options.capabilities;
  }

  /**
   * Reachable *and* usable.
   *
   * THE SECOND HALF WAS MISSING AND IT MISREPRESENTED A FRESH INSTALL. This returned `response.ok`
   * from `GET {baseUrl}/models`, and on OpenRouter that endpoint is **public** — it serves the
   * catalogue with no authorization at all. So on any machine with internet and no key, OpenRouter
   * reported itself available, `availableProviders()` included it, and with Ollama absent it became
   * `providers[0]`: the status bar named one of its models as the active model, `useRuntimeStatus`
   * said `ready`, and every actual request failed for want of a key.
   *
   * That is the precise fresh-install case — no Ollama, no key — so the app was at its least honest
   * exactly when a new user most needed the truth, and it suppressed the "no model" surfaces that
   * exist to help them.
   *
   * Found by driving the app with `OLLAMA_HOST` pointed at a closed port and a throwaway
   * `--user-data-dir`, which is the only way to see it: on a developer machine Ollama is running and
   * OpenRouter never reaches the front of the list.
   *
   * The check is a property of the configuration rather than a special case for OpenRouter: a
   * provider given an `authToken` getter needs that token to work, so no token means not available.
   * llama.cpp passes no getter and is unaffected.
   */
  async available(): Promise<boolean> {
    if (this.options.authToken !== undefined) {
      const token = await this.options.authToken();
      if (token === undefined || token === "") return false;
    }

    try {
      const response = await fetch(`${this.options.baseUrl}/models`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(this.capabilities.remote ? 4_000 : 1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.options.baseUrl}/models`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return [];

      const body = (await response.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => ({ id: m.id }));
    } catch {
      return [];
    }
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...(await this.headers()), "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: toOpenAIMessages(request.messages),
          stream: true,
          ...(request.tools !== undefined && request.tools.length > 0
            ? {
                tools: toWireTools(request.tools),
                ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
              }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.json === true ? { response_format: { type: "json_object" } } : {}),
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (err) {
      yield { kind: "error", message: describe(err, this.label), retryable: true };
      return;
    }

    if (!response.ok || response.body === null) {
      // 401 is worth distinguishing: retrying will not help, the key is wrong.
      const message =
        response.status === 401
          ? `${this.label} rejected the API key`
          : `${this.label} returned ${response.status}`;
      yield { kind: "error", message, retryable: response.status >= 500 };
      return;
    }

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let finished = false;
    let finishReason: "stop" | "tool_calls" | "length" = "stop";
    const toolCalls = new ToolCallAccumulator();

    try {
      for await (const frame of sse<ChatCompletionChunk>(response.body)) {
        if (frame.error !== undefined) {
          yield { kind: "error", message: frame.error.message ?? "unknown error", retryable: false };
          return;
        }

        if (frame.usage !== undefined) {
          promptTokens = frame.usage.prompt_tokens;
          completionTokens = frame.usage.completion_tokens;
        }

        // A queue update from the hosted backend. Handled before the delta below because the
        // frame deliberately carries an empty one -- falling through would be harmless but would
        // also mean the position never reached the surface that wants to show it.
        if (frame.type === "queue" && frame.queue !== undefined) {
          const position = frame.queue.position ?? 1;
          yield {
            kind: "queued",
            position,
            ahead: frame.queue.ahead ?? Math.max(position - 1, 0),
            backendState: frame.queue.backendState ?? "ready",
          };
          continue;
        }

        const choice = frame.choices?.[0];
        const text = choice?.delta?.content;
        if (text !== undefined && text !== "") yield { kind: "token", text };

        // Fragments, not calls. Collected until the turn ends — see `tools.ts` for why
        // nothing can be emitted mid-stream.
        for (const delta of choice?.delta?.tool_calls ?? []) toolCalls.push(delta);

        // A non-null finish_reason ends the turn. The `[DONE]` sentinel may or may not
        // follow depending on the server, so this is what completion is keyed on.
        if (choice?.finish_reason != null) {
          finished = true;
          if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
          else if (choice.finish_reason === "length") finishReason = "length";
        }
      }

      if (finished) {
        // Before `done`, so a consumer that stops at `done` has already seen every call.
        for (const call of toolCalls.flush()) yield { kind: "tool_call", call };

        yield {
          kind: "done",
          // Some servers report `stop` even while emitting tool calls. What was actually
          // streamed is better evidence than what was declared.
          finishReason: finishReason === "stop" && toolCalls.pending ? "tool_calls" : finishReason,
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
        };
        return;
      }

      // Stream ended with no finish_reason: the server went away mid-generation.
      yield {
        kind: "error",
        message: `${this.label} closed the connection before finishing`,
        retryable: true,
      };
    } catch (err) {
      if (isAbort(err)) return;
      yield { kind: "error", message: describe(err, this.label), retryable: true };
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.options.authToken?.();
    return {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(await this.options.extraHeaders?.() ?? {}),
    };
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}


/**
 * Pull a system errno out of a fetch failure.
 *
 * Node's fetch reports every connection problem as a bare `TypeError: fetch failed` and
 * puts the detail in `cause`. When more than one address was tried — which is the norm
 * for localhost, with both ::1 and 127.0.0.1 — `cause` is an AggregateError and the code
 * is one level further down. Without checking both, every refused connection surfaces to
 * the user as "fetch failed", which tells them nothing about what to do.
 */
function errnoOf(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown }).cause;
  const direct = (cause as { code?: string } | undefined)?.code;
  if (direct !== undefined) return direct;

  const nested = (cause as { errors?: Array<{ code?: string }> } | undefined)?.errors;
  const fromNested = nested?.find((e) => e.code !== undefined)?.code;
  if (fromNested !== undefined) return fromNested;

  // Last resort: undici does not always set `code`, but the errno is in the message —
  // "connect ECONNREFUSED 127.0.0.1:53219". Parsing it is unlovely but it is the
  // difference between a useful message and "fetch failed".
  const message = (cause as { message?: string } | undefined)?.message ?? "";
  return /(E[A-Z]{4,})/.exec(message)?.[1];
}

function describe(err: unknown, label: string): string {
  if (err instanceof Error) {
    const code = errnoOf(err);
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return `${label} is not reachable`;
    if (code === "ENOTFOUND") return `${label}: host not found — is this machine online?`;
    return err.message;
  }
  return String(err);
}
