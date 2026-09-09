/**
 * Line-delimited JSON and SSE parsing over a fetch body.
 *
 * Both Ollama (NDJSON) and the OpenAI-compatible backends (SSE) stream framed text, and
 * both are read the same way: decode incrementally, split on newlines, and *keep the
 * trailing partial line*. That last part is the whole reason this is a shared module —
 * a chunk boundary lands mid-object often enough that parsing each chunk independently
 * works in testing and drops tokens under load.
 */

/** Yield each complete line from a byte stream, buffering partial lines across chunks. */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` so a multi-byte character split across chunks is not mangled.
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield line;
      }
    }

    // A final line with no trailing newline is still a line.
    const tail = buffer.trim();
    if (tail.length > 0) yield tail;
  } finally {
    // Releasing matters on the abort path: without it the underlying socket can be held
    // open after the consumer has walked away.
    reader.releaseLock();
  }
}

/** NDJSON: one JSON object per line. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of lines(body)) {
    try {
      yield JSON.parse(line) as T;
    } catch {
      // A malformed line is skipped rather than fatal. Ollama occasionally emits a bare
      // status line, and killing an otherwise healthy stream over it would be worse.
      continue;
    }
  }
}

/**
 * Server-sent events, reduced to the `data:` payloads.
 *
 * Ignores comments and event names because no OpenAI-compatible backend uses them for
 * chat. `[DONE]` is the OpenAI sentinel and terminates the stream.
 */
export async function* sse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of lines(body)) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;

    try {
      yield JSON.parse(payload) as T;
    } catch {
      continue;
    }
  }
}
