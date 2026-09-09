/**
 * Ollama provider. The default (spec §2.7): runs its own daemon on every platform and
 * manages downloads, so it is the one backend that needs no setup from us.
 */
import { ndjson } from "./ndjson.js";
import { toOllamaMessages } from "./normalise.js";
import { fromOllamaToolCalls, toWireTools, type OllamaToolCall } from "./tools.js";
import type {
  ChatChunk,
  ChatRequest,
  InferenceProvider,
  ModelInfo,
  PullProgress,
} from "./types.js";

/**
 * Where Ollama is, honouring Ollama's own variable.
 *
 * `available()` below explains that this provider probes the HTTP endpoint rather than looking
 * for a binary, "so a remote or containerised Ollama is found too". That was only half true: the
 * probe was right and nothing could change the address, so the only Ollama findable was the one on
 * this machine's default port.
 *
 * `OLLAMA_HOST` is the name Ollama itself uses, so a user who has already set it for the CLI gets
 * the same daemon here without learning a second variable. A bare `host:port` is accepted because
 * that is the form Ollama documents.
 */
export const FALLBACK_HOST = "http://127.0.0.1:11434";

export function hostFromEnv(): string {
  const configured = process.env.OLLAMA_HOST?.trim();
  if (configured === undefined || configured === "") return FALLBACK_HOST;
  return /^https?:\/\//.test(configured) ? configured : `http://${configured}`;
}

interface OllamaChatFrame {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaPullFrame {
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export class OllamaProvider implements InferenceProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama";
  readonly capabilities = {
    tools: true,
    // `format: "json"` — constrained enough for the pipeline's structured extraction.
    grammar: true,
    remote: false,
  };

  constructor(private readonly host: string = hostFromEnv()) {}

  /**
   * Probe the HTTP endpoint rather than looking for a binary, so a remote or
   * containerised Ollama is found too (spec §2.4).
   */
  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/version`, {
        signal: AbortSignal.timeout(1_500),
        });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.host}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];

    const body = (await response.json()) as { models?: Array<{ name: string; size?: number }> };
    return (body.models ?? []).map((m) => ({
      id: m.name,
      ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
    }));
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: toOllamaMessages(request.messages),
          stream: true,
          ...(request.tools !== undefined && request.tools.length > 0
            ? { tools: toWireTools(request.tools) }
            : {}),
          ...(request.json === true ? { format: "json" } : {}),
          // Ollama's own name for it. Sent only when the caller has an opinion, and verified
          // harmless on a model that cannot think — `llama3.1:8b` accepts `think: false` and
          // answers normally rather than erroring on an unsupported field.
          ...(request.reasoning !== undefined ? { think: request.reasoning } : {}),
          options: {
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
          },
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
    } catch (err) {
      // Daemon not running, or it died before responding. Retryable: the user can start
      // it and try again, which is a different situation from a bad request.
      yield { kind: "error", message: describe(err), retryable: true };
      return;
    }

    if (!response.ok || response.body === null) {
      // A 404 here means the model is not pulled, which is the single most likely thing
      // to go wrong on a fresh install and deserves an actionable message rather than a
      // status code. Verified against a live daemon with no models installed.
      const message =
        response.status === 404
          ? `Model "${request.model}" is not installed. Download it first.`
          : `Ollama returned ${response.status}`;
      // 4xx is a missing model or our bug; 5xx may pass on a retry.
      yield { kind: "error", message, retryable: response.status >= 500 };
      return;
    }

    let sawToolCall = false;

    try {
      for await (const frame of ndjson<OllamaChatFrame>(response.body)) {
        if (frame.error !== undefined) {
          yield { kind: "error", message: frame.error, retryable: false };
          return;
        }

        // Reasoning first, because that is the order it arrives in: a thinking model streams
        // `thinking` deltas and only then `content`. Emitted as its own kind so it can never be
        // mistaken for the answer — see the note on `reasoning` in `types.ts`.
        const reasoning = frame.message?.thinking;
        if (reasoning !== undefined && reasoning !== "") yield { kind: "reasoning", text: reasoning };

        const text = frame.message?.content;
        if (text !== undefined && text !== "") yield { kind: "token", text };

        // Whole calls, one frame, unlike the OpenAI path — so they are emitted as they
        // arrive rather than accumulated. Tracked so `finishReason` can say what happened.
        const calls = fromOllamaToolCalls(frame.message?.tool_calls ?? []);
        for (const call of calls) {
          sawToolCall = true;
          yield { kind: "tool_call", call };
        }

        if (frame.done === true) {
          yield {
            kind: "done",
            // Ollama has no `finish_reason`. What it streamed is the only evidence there is,
            // and it is better evidence than a field it does not send.
            finishReason: sawToolCall ? "tool_calls" : "stop",
            ...(frame.prompt_eval_count !== undefined
              ? { promptTokens: frame.prompt_eval_count }
              : {}),
            ...(frame.eval_count !== undefined ? { completionTokens: frame.eval_count } : {}),
          };
          return;
        }
      }

      // The body ended without a `done` frame: the daemon was killed mid-stream. Report
      // it rather than letting the consumer wait forever for a completion that is not
      // coming — this is the case Phase 4's exit criterion names.
      yield {
        kind: "error",
        message: "Ollama closed the connection before finishing",
        retryable: true,
      };
    } catch (err) {
      // An abort is the caller's own doing, so it is not an error to report back.
      if (isAbort(err)) return;
      yield { kind: "error", message: describe(err), retryable: true };
    }
  }


  /**
   * `DELETE /api/delete`, which removes the manifest and any layers nothing else references.
   *
   * Ollama answers 404 for a model that is not installed. That is reported plainly rather
   * than swallowed: the button that called this was drawn from a list saying the model *was*
   * installed, so a 404 means the list is stale and the user should be told rather than shown
   * a success for a deletion that did not happen.
   */
  async remove(modelId: string): Promise<void> {
    const response = await fetch(`${this.host}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
    });

    if (response.status === 404) {
      throw new Error(`"${modelId}" is not installed, so there was nothing to remove.`);
    }
    if (!response.ok) {
      throw new Error(`Ollama refused to remove "${modelId}" (HTTP ${response.status}).`);
    }
  }

  async pull(
    modelId: string,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.host}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, stream: true }),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!response.ok || response.body === null) {
      throw new Error(`Ollama refused the pull: ${response.status}`);
    }

    let sawSuccess = false;

    try {
      for await (const frame of ndjson<OllamaPullFrame>(response.body)) {
        if (frame.error !== undefined) throw new PullRejected(frame.error);

        const status = frame.status ?? "working";
        // `total` is absent during the manifest and verify phases, so a fraction is only
        // reported once there is one — a bar that sits at 0% is better than one that
        // jumps to 100% and back.
        const fraction =
        frame.total !== undefined && frame.total > 0 && frame.completed !== undefined
          ? Math.min(1, frame.completed / frame.total)
          : undefined;

        // Byte counts are reported as a pair or not at all. Observed against a live
        // pull: for the small config layers Ollama sends `total` with no `completed`,
        // and a consumer formatting "completed/total" then renders "NaN/0.00 GB".
        // Emitting half a pair is not useful information, only a way to produce that.
        const bytesKnown = frame.completed !== undefined && frame.total !== undefined;

        onProgress({
          status,
          ...(fraction !== undefined ? { fraction } : {}),
          ...(bytesKnown
            ? { completedBytes: frame.completed, totalBytes: frame.total }
            : {}),
        });

        if (status === "success") sawSuccess = true;
      }
    } catch (err) {
      // An abort is the caller's own doing, and a rejection Ollama reported in-band has a
      // better message than anything we could substitute — both propagate. Only a dropped
      // socket falls through to the "ended before success" message below, because that is
      // what the user needs to know about it.
      if (isAbort(err) || err instanceof PullRejected) throw err;
    }

    // Ollama signals completion with a `success` status. Without it the stream ended
    // early — whether by a clean close or a dropped socket — and reporting a finished
    // download that did not finish would leave the app loading a partial model.
    if (!sawSuccess) {
      throw new Error("The download ended before Ollama reported success");
    }
  }
}

/** An error Ollama reported in its own stream, as opposed to a transport failure. */
class PullRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRejected";
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

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = errnoOf(err);
    if (code === "ECONNREFUSED" || code === "ECONNRESET") {
      return "Ollama is not running on this machine";
    }
    return err.message;
  }
  return String(err);
}
