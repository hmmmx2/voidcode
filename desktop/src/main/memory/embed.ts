/**
 * Turning text into vectors, via Ollama.
 *
 * Its own client rather than a method on `InferenceProvider`. Embedding is not chat: no
 * streaming, no persona, no tools, a different endpoint, and it is meaningful only for the one
 * provider that serves an embedding model locally. Widening the provider interface for it
 * would put an `embed?()` on OpenRouter and llama.cpp that neither implements.
 *
 * Local only, and that is a decision rather than a limitation. Indexing sends *every file in
 * the project* to whatever answers — which is exactly the thing this app exists not to do.
 * There is deliberately no remote path here, and no option to add one at the call site.
 */

/** Small, fast, and Apache-2.0. 768 dimensions, which `store.ts` records in the manifest. */
export const EMBED_MODEL = "nomic-embed-text";

/** Ollama's default. Same constant the chat provider uses; kept literal for the same reason. */
const OLLAMA_HOST = "http://127.0.0.1:11434";

/**
 * Chunks per request.
 *
 * Batching matters: a project of 6,000 files is ~30,000 chunks, and one HTTP round trip each
 * would spend more time on request overhead than on inference. Large enough to amortise it,
 * small enough that a failure loses seconds rather than minutes of work.
 */
const BATCH = 32;

export class EmbeddingsUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EmbeddingsUnavailableError";
  }
}

interface EmbedResponse {
  embeddings?: number[][];
  /** The older single-input endpoint's shape. */
  embedding?: number[];
  error?: string;
}

/**
 * One batch.
 *
 * Tries `/api/embed` and falls back to `/api/embeddings` on a 404. The plural endpoint is the
 * current one and takes an array; the singular is what older daemons have, takes one string,
 * and is the difference between working and not on an install nobody has updated. Falling back
 * costs one wasted request, once.
 */
async function embedBatch(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const plural = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
    ...(signal !== undefined ? { signal } : {}),
  }).catch((err: unknown) => {
    throw new EmbeddingsUnavailableError(
      err instanceof Error && err.name === "AbortError"
        ? "Indexing was cancelled"
        : "Ollama is not reachable — start it and try again."
    );
  });

  if (plural.ok) {
    const body = (await plural.json()) as EmbedResponse;
    if (body.error !== undefined) throw new EmbeddingsUnavailableError(body.error);
    if (body.embeddings !== undefined) return body.embeddings;
  }

  if (plural.status === 404) {
    const singles: number[][] = [];
    for (const input of inputs) {
      const response = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: input }),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!response.ok) {
        throw new EmbeddingsUnavailableError(`Ollama returned ${response.status} while embedding`);
      }
      const body = (await response.json()) as EmbedResponse;
      if (body.embedding === undefined) {
        throw new EmbeddingsUnavailableError("Ollama returned no embedding");
      }
      singles.push(body.embedding);
    }
    return singles;
  }

  // 404 on the *model* rather than the route is the most likely thing to go wrong on a fresh
  // install, and deserves an actionable message rather than a status code.
  throw new EmbeddingsUnavailableError(
    plural.status === 400
      ? `The embedding model "${model}" is not installed. Pull it first.`
      : `Ollama returned ${plural.status} while embedding`
  );
}

export interface EmbedProgress {
  done: number;
  total: number;
}

/**
 * Embed every text, in order.
 *
 * Sequential batches rather than parallel ones: Ollama serialises per loaded model anyway, so
 * concurrency here buys nothing and makes progress reporting a lie.
 */
export async function embedAll(
  texts: readonly string[],
  onProgress?: (progress: EmbedProgress) => void,
  signal?: AbortSignal,
  model: string = EMBED_MODEL
): Promise<number[][]> {
  const all: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    if (signal?.aborted === true) throw new EmbeddingsUnavailableError("Indexing was cancelled");
    const batch = texts.slice(i, i + BATCH);
    all.push(...(await embedBatch(model, batch, signal)));
    onProgress?.({ done: Math.min(i + BATCH, texts.length), total: texts.length });
  }

  return all;
}

/** Whether the embedding model is installed, so the UI can say what to pull rather than fail. */
export async function embeddingsAvailable(model: string = EMBED_MODEL): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    // Prefix match: Ollama reports `nomic-embed-text:latest` for a plain `nomic-embed-text`.
    return (body.models ?? []).some((m) => (m.name ?? "").startsWith(model));
  } catch {
    return false;
  }
}
