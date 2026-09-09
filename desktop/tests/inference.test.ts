/**
 * The inference layer, against a stub server that speaks the real wire protocols.
 *
 * No Ollama is installed on this machine, so a stub is the honest way to test rather
 * than a shortcut: it lets the cases that actually matter be provoked on demand —
 * a chunk boundary landing mid-JSON, a daemon killed mid-stream, an abort — none of
 * which a real daemon would reproduce reliably.
 *
 * What this cannot prove is that Ollama's protocol is as documented. That gap is real
 * and is closed by running against a live daemon; these tests pin our half of it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaProvider, hostFromEnv, FALLBACK_HOST } from "../src/main/inference/ollama.js";
import { OpenAICompatibleProvider } from "../src/main/inference/openai.js";
import type { ChatChunk, PullProgress } from "../src/main/inference/types.js";

/** How the next request should behave. Set per test. */
let behaviour: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => behaviour(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ndjsonResponse(res: http.ServerResponse, frames: unknown[], opts: { truncate?: boolean } = {}) {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const frame of frames) res.write(`${JSON.stringify(frame)}\n`);
  if (opts.truncate === true) {
    // Close without a terminating frame: what a killed daemon looks like on the wire.
    // Destroying in this tick would discard the buffered writes, so the client would see
    // a connection failure instead of a stream that started and stopped — which is a
    // different bug from the one under test.
    setTimeout(() => res.destroy(), 25);
  } else {
    res.end();
  }
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const text = (chunks: ChatChunk[]) =>
  chunks.filter((c): c is { kind: "token"; text: string } => c.kind === "token")
    .map((c) => c.text)
    .join("");

const reasoning = (chunks: ChatChunk[]) =>
  chunks.filter((c): c is { kind: "reasoning"; text: string } => c.kind === "reasoning")
    .map((c) => c.text)
    .join("");

/** Read a request body, so a test can assert what we put on the wire rather than only what we read. */
function bodyOf(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => resolve(JSON.parse(raw || "{}") as Record<string, unknown>));
  });
}

describe("Ollama chat", () => {
  it("streams tokens and reports usage on completion", async () => {
    behaviour = (_req, res) =>
      ndjsonResponse(res, [
        { message: { content: "Hello" } },
        { message: { content: ", " } },
        { message: { content: "world" } },
        { done: true, prompt_eval_count: 11, eval_count: 3 },
      ]);

    const chunks = await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );

    expect(text(chunks)).toBe("Hello, world");
    const last = chunks.at(-1);
    expect(last).toMatchObject({ kind: "done", promptTokens: 11, completionTokens: 3 });
  });

  it("reassembles a JSON object split across chunk boundaries", async () => {
    // The bug this guards: parsing each network chunk independently works in testing and
    // silently drops tokens under load, because a chunk boundary lands mid-object.
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const payload =
        `${JSON.stringify({ message: { content: "split" } })}\n` +
        `${JSON.stringify({ message: { content: "-token" } })}\n` +
        `${JSON.stringify({ done: true })}\n`;
      // Deliberately awkward split points, one of them inside a JSON object.
      res.write(payload.slice(0, 20));
      res.write(payload.slice(20, 55));
      res.write(payload.slice(55));
      res.end();
    };

    const chunks = await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [] })
    );
    expect(text(chunks)).toBe("split-token");
  });

  it("preserves a multi-byte character split across chunks", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const payload = `${JSON.stringify({ message: { content: "café ☕" } })}\n${JSON.stringify({ done: true })}\n`;
      const bytes = Buffer.from(payload, "utf8");
      // Split inside the ☕ sequence. Decoding without `stream: true` mangles it.
      const cut = bytes.indexOf(Buffer.from("☕", "utf8")) + 1;
      res.write(bytes.subarray(0, cut));
      res.write(bytes.subarray(cut));
      res.end();
    };

    const chunks = await collect(new OllamaProvider(baseUrl).chat({ model: "m", messages: [] }));
    expect(text(chunks)).toBe("café ☕");
  });

  it("degrades cleanly when the daemon dies mid-stream", async () => {
    // Phase 4's exit criterion. The failure to avoid is a consumer waiting forever for a
    // `done` frame that is never coming.
    behaviour = (_req, res) =>
      ndjsonResponse(res, [{ message: { content: "partial" } }], { truncate: true });

    const chunks = await collect(new OllamaProvider(baseUrl).chat({ model: "m", messages: [] }));

    expect(text(chunks)).toBe("partial");
    const last = chunks.at(-1);
    expect(last?.kind).toBe("error");
    expect(last).toMatchObject({ retryable: true });
    // Terminal: exactly one of done/error, never both.
    expect(chunks.filter((c) => c.kind === "done")).toHaveLength(0);
  });

  it("reports a refused connection as retryable, in plain language", async () => {
    // A port that was bound and then released: guaranteed free, and — unlike port 1 —
    // not on undici's blocked-port list, which fails with "bad port" before ever
    // attempting a connection. The original version of this test never provoked a
    // refusal at all.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const chunks = await collect(
      new OllamaProvider(`http://127.0.0.1:${deadPort}`).chat({ model: "m", messages: [] })
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "error", retryable: true });
    expect((chunks[0] as { message: string }).message).toContain("not running");
  });

  it("treats an in-band error frame as terminal and not retryable", async () => {
    behaviour = (_req, res) => ndjsonResponse(res, [{ error: "model 'nope' not found" }]);

    const chunks = await collect(new OllamaProvider(baseUrl).chat({ model: "nope", messages: [] }));
    expect(chunks).toEqual([
      { kind: "error", message: "model 'nope' not found", retryable: false },
    ]);
  });

  it("emits nothing after the caller aborts", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ message: { content: "one" } })}\n`);
      // Then hang, so only the abort can end this.
    };

    const controller = new AbortController();
    const provider = new OllamaProvider(baseUrl);
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.chat({
      model: "m",
      messages: [],
      signal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.kind === "token") controller.abort();
    }

    // An abort is the caller's own doing, so it must not be reported back as an error.
    expect(chunks).toEqual([{ kind: "token", text: "one" }]);
  });

  it("skips a malformed line rather than failing the stream", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ message: { content: "a" } })}\n`);
      res.write("not json at all\n");
      res.write(`${JSON.stringify({ message: { content: "b" } })}\n`);
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
    };

    const chunks = await collect(new OllamaProvider(baseUrl).chat({ model: "m", messages: [] }));
    expect(text(chunks)).toBe("ab");
    expect(chunks.at(-1)?.kind).toBe("done");
  });
});

describe("Ollama pull", () => {
  it("reports progress and requires an explicit success", async () => {
    behaviour = (_req, res) =>
      ndjsonResponse(res, [
        { status: "pulling manifest" },
        { status: "downloading", completed: 250, total: 1000 },
        { status: "downloading", completed: 1000, total: 1000 },
        { status: "verifying sha256 digest" },
        { status: "success" },
      ]);

    const seen: PullProgress[] = [];
    await new OllamaProvider(baseUrl).pull("qwen2.5-coder:7b", (p) => seen.push(p));

    expect(seen[0]).toMatchObject({ status: "pulling manifest" });
    // No fraction before a total is known: a bar sitting at 0% beats one that jumps.
    expect(seen[0]?.fraction).toBeUndefined();
    expect(seen[1]).toMatchObject({ fraction: 0.25 });
    expect(seen.at(-1)).toMatchObject({ status: "success" });
  });

  it("rejects a download that ends without success", async () => {
    // Otherwise the app reports a finished download and then tries to load a partial
    // model, which fails much later and much more confusingly.
    behaviour = (_req, res) =>
      ndjsonResponse(res, [{ status: "downloading", completed: 10, total: 1000 }], {
        truncate: true,
      });

    await expect(
      new OllamaProvider(baseUrl).pull("m", () => undefined)
    ).rejects.toThrow(/ended before/i);
  });

  it("surfaces an in-band pull error", async () => {
    behaviour = (_req, res) => ndjsonResponse(res, [{ error: "file does not exist" }]);
    await expect(new OllamaProvider(baseUrl).pull("m", () => undefined)).rejects.toThrow(
      /file does not exist/
    );
  });
});

describe("OpenAI-compatible providers", () => {
  const provider = () =>
    new OpenAICompatibleProvider({
      id: "llamacpp",
      label: "llama.cpp",
      baseUrl: `${baseUrl}/v1`,
      capabilities: { tools: false, grammar: true, remote: false },
    });

  function sseResponse(res: http.ServerResponse, frames: unknown[], opts: { done?: boolean; truncate?: boolean } = {}) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (opts.done === true) res.write("data: [DONE]\n\n");
    // Same reason as the NDJSON helper: let the write flush before killing the socket,
    // or the client sees a connection failure rather than a stream that stopped.
    if (opts.truncate === true) setTimeout(() => res.destroy(), 25);
    else res.end();
  }

  it("streams SSE deltas and finishes on finish_reason", async () => {
    behaviour = (_req, res) =>
      sseResponse(
        res,
        [
          { choices: [{ delta: { content: "Hi" } }] },
          { choices: [{ delta: { content: " there" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ],
        { done: true }
      );

    const chunks = await collect(provider().chat({ model: "m", messages: [] }));
    expect(text(chunks)).toBe("Hi there");
    expect(chunks.at(-1)).toMatchObject({ kind: "done", promptTokens: 5, completionTokens: 2 });
  });

  it("degrades cleanly when the server dies mid-stream", async () => {
    behaviour = (_req, res) =>
      sseResponse(res, [{ choices: [{ delta: { content: "half" } }] }], { truncate: true });

    const chunks = await collect(provider().chat({ model: "m", messages: [] }));
    expect(text(chunks)).toBe("half");
    expect(chunks.at(-1)?.kind).toBe("error");
    expect(chunks.filter((c) => c.kind === "done")).toHaveLength(0);
  });

  it("calls a rejected key unretryable, because retrying will not fix it", async () => {
    behaviour = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no" } }));
    };

    const chunks = await collect(provider().chat({ model: "m", messages: [] }));
    expect(chunks[0]).toMatchObject({ kind: "error", retryable: false });
    expect((chunks[0] as { message: string }).message).toContain("API key");
  });

  it("attaches a bearer token only when one is supplied", async () => {
    const seen: Array<string | undefined> = [];
    behaviour = (req, res) => {
      seen.push(req.headers.authorization);
      sseResponse(res, [{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }], {
        done: true,
      });
    };

    await collect(provider().chat({ model: "m", messages: [] }));
    expect(seen.at(-1)).toBeUndefined();

    const remote = new OpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: `${baseUrl}/v1`,
      capabilities: { tools: true, grammar: true, remote: true },
      // Read at request time, so the key never lives in the provider object.
      authToken: async () => "secret-key",
    });
    await collect(remote.chat({ model: "m", messages: [] }));
    expect(seen.at(-1)).toBe("Bearer secret-key");
  });

  it("is not available without the key it needs", async () => {
    /**
     * The check that was missing, and it misrepresented exactly the fresh install.
     *
     * `available()` returned `response.ok` from `GET {baseUrl}/models`, and on OpenRouter that
     * endpoint is public — the catalogue comes back with no authorization. So with internet and no
     * key, OpenRouter reported available, `availableProviders()` included it, and with Ollama absent
     * it became `providers[0]`: the status bar named one of its models as active, `useRuntimeStatus`
     * reported ready, and every request failed for want of a key. A new user with neither Ollama nor
     * a key was told there was a model, and the surfaces that exist to tell them otherwise stayed
     * hidden because the app believed it.
     *
     * POINTED AT THE **WORKING** TEST SERVER, and that detail is the test.
     *
     * The first version used an unroutable address, reasoning that reaching it would fail. It could
     * not fail: a refused connection lands in the `catch` and returns `false` too, so the assertion
     * passed whether or not the key was checked — mutation testing killed the test rather than the
     * code. A base URL that *would* answer `ok` is what makes this discriminate: without the key
     * check the probe succeeds and `available()` is true, with it the method never gets that far.
     */
    const keyless = new OpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: `${baseUrl}/v1`,
      capabilities: { tools: true, grammar: true, remote: true },
      authToken: async () => undefined,
    });
    expect(await keyless.available()).toBe(false);

    // An empty string is the same absence, and the likelier shape of a bug: a vault miss returning
    // "" rather than undefined would otherwise sail through as a token.
    const blank = new OpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: `${baseUrl}/v1`,
      capabilities: { tools: true, grammar: true, remote: true },
      authToken: async () => "",
    });
    expect(await blank.available()).toBe(false);
  });

  it("still probes a provider that needs no key", async () => {
    // The rule is a property of the configuration, not a special case for OpenRouter. llama.cpp
    // passes no `authToken`, so it must still be judged by whether it answers — a keyless-means-
    // unavailable rule that caught local backends would disable them entirely.
    const local = new OpenAICompatibleProvider({
      id: "llamacpp",
      label: "llama.cpp",
      baseUrl: `${baseUrl}/v1`,
      capabilities: { tools: false, grammar: true, remote: false },
    });
    expect(await local.available()).toBe(true);
  });

  it("marks OpenRouter as remote so the UI can say text left the machine", () => {
    const remote = new OpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      capabilities: { tools: true, grammar: true, remote: true },
    });
    expect(remote.capabilities.remote).toBe(true);
    expect(provider().capabilities.remote).toBe(false);
  });
});

describe("a reasoning model", () => {
  /**
   * Nothing read Ollama's `thinking` field, so a model that reasons before answering emitted no
   * chunks at all until it reached content — and if its budget ran out first, the turn looked
   * silent. Measured against `qwen3:8b`, the interview assessor returned an empty assessment on
   * two of three identical calls, stored as the `unknown` verdict that `verdict.ts` documents as
   * the common, benign case. A transport gap wearing the costume of normal behaviour.
   */
  it("streams reasoning as its own kind, never as tokens", async () => {
    behaviour = (_req, res) =>
      ndjsonResponse(res, [
        { message: { thinking: "Let me check the " } },
        { message: { thinking: "gradient." } },
        { message: { content: "VERDICT: correct" } },
        { done: true },
      ]);

    const chunks = await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );

    expect(reasoning(chunks)).toBe("Let me check the gradient.");
    // The property that matters: reasoning frequently states the answer the tutor is meant to
    // withhold, so it must not arrive as part of the reply.
    expect(text(chunks)).toBe("VERDICT: correct");
  });

  it("reports reasoning even when the answer never comes", async () => {
    // The exhausted-budget case. Before, this stream produced nothing but a `done`.
    behaviour = (_req, res) =>
      ndjsonResponse(res, [{ message: { thinking: "Hmm..." } }, { done: true }]);

    const chunks = await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );

    expect(reasoning(chunks)).toBe("Hmm...");
    expect(text(chunks)).toBe("");
    expect(chunks.some((c) => c.kind === "reasoning")).toBe(true);
  });

  it("ignores an empty thinking delta", async () => {
    // Same treatment as an empty content delta: a frame carrying "" is not an event.
    behaviour = (_req, res) =>
      ndjsonResponse(res, [{ message: { thinking: "" } }, { message: { content: "ok" } }, { done: true }]);

    const chunks = await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );
    expect(chunks.some((c) => c.kind === "reasoning")).toBe(false);
  });
});

describe("asking a model not to reason", () => {
  /**
   * `reasoning: false` is what makes grading reliable. A budget number cannot: the right number
   * differs per model, and `interview-assess.ts` bounds itself to 700 tokens for reasons that are
   * about the *answer*. Turning off a mode the task never wanted is the fix — five identical calls
   * went from 503/200/503 to five verdicts.
   */
  it("sends Ollama's `think` flag when the caller has an opinion", async () => {
    let sent: Record<string, unknown> = {};
    behaviour = (req, res) => {
      void bodyOf(req).then((body) => {
        sent = body;
        ndjsonResponse(res, [{ message: { content: "ok" } }, { done: true }]);
      });
    };

    await collect(
      new OllamaProvider(baseUrl).chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        reasoning: false,
      })
    );

    expect(sent.think).toBe(false);
  });

  it("omits the flag entirely when the caller has none", async () => {
    /**
     * Absent, not `true`. `think` must not be sent by default: the field is Ollama's, the
     * default belongs to the model, and a request that always carried it would be asserting an
     * opinion on every call — including the agent's, where reasoning is wanted.
     */
    let sent: Record<string, unknown> = { think: "untouched" };
    behaviour = (req, res) => {
      void bodyOf(req).then((body) => {
        sent = body;
        ndjsonResponse(res, [{ message: { content: "ok" } }, { done: true }]);
      });
    };

    await collect(
      new OllamaProvider(baseUrl).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );

    expect("think" in sent).toBe(false);
  });
});

describe("where Ollama is", () => {
  /**
   * `available()` says this provider probes the HTTP endpoint rather than looking for a binary,
   * "so a remote or containerised Ollama is found too". Only half of that was true: the probe was
   * right, and nothing could change the address, so the only reachable Ollama was the one on this
   * machine's default port. A comment describing a capability the code did not have.
   *
   * `OLLAMA_HOST` is Ollama's own variable, so someone who already set it for the CLI does not
   * learn a second one — and it is what let the no-model CI path be verified locally by pointing
   * the app at a dead port, instead of stopping a daemon on the developer's machine.
   */
  const original = process.env.OLLAMA_HOST;
  afterEach(() => {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  });

  it("reaches a host given as bare host:port", async () => {
    // The form Ollama documents. Without normalising it, `fetch` gets a relative URL and throws.
    const { port } = server.address() as AddressInfo;
    process.env.OLLAMA_HOST = `127.0.0.1:${port}`;

    let reached = false;
    behaviour = (_req, res) => {
      reached = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0-test" }));
    };

    expect(await new OllamaProvider().available()).toBe(true);
    expect(reached).toBe(true);
  });

  it("reaches a host given with a scheme", async () => {
    process.env.OLLAMA_HOST = baseUrl;
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0-test" }));
    };
    expect(await new OllamaProvider().available()).toBe(true);
  });

  it("falls back to the local default when the variable is absent or blank", () => {
    /**
     * Asserted on the resolved address, not by watching the stub go unvisited.
     *
     * The first version of this test did the latter and was too weak to matter: a blank value read
     * literally resolves to the string "http://", which also fails to reach the stub, so the test
     * passed for both the correct behaviour and the broken one. Mutation testing caught it. The
     * default port cannot be stood up here either — the developer's real daemon is on it.
     *
     * The failure being prevented is worth naming: a stray blank `OLLAMA_HOST` would make a
     * perfectly good local Ollama unreachable, and the app reports that as "no local model is
     * available" — indistinguishable from having installed nothing.
     */
    for (const value of [undefined, "", "   ", "	"]) {
      if (value === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = value;
      expect(hostFromEnv(), JSON.stringify(value)).toBe(FALLBACK_HOST);
    }
  });

  it("normalises what it is given", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1:11434", "http://127.0.0.1:11434"],
      ["ollama.internal:11434", "http://ollama.internal:11434"],
      ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
      // Left alone: a TLS endpoint must not be downgraded to plaintext by a helper trying to be
      // helpful.
      ["https://ollama.example", "https://ollama.example"],
      ["  127.0.0.1:9999  ", "http://127.0.0.1:9999"],
    ];
    for (const [given, want] of cases) {
      process.env.OLLAMA_HOST = given;
      expect(hostFromEnv(), given).toBe(want);
    }
  });

  it("still takes an explicit host, which is how every other test here works", async () => {
    process.env.OLLAMA_HOST = "127.0.0.1:1";
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0-test" }));
    };
    // The constructor argument wins over the environment, so a caller that knows the address is
    // never overridden by a stray variable.
    expect(await new OllamaProvider(baseUrl).available()).toBe(true);
  });
});
