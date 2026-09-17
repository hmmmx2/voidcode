/**
 * Provider selection, and the streaming bridge to the renderer.
 *
 * Two jobs kept together because they share the same rule: the renderer names *what* it
 * wants, never *where* it comes from. A Study window cannot ask for the cloud provider,
 * and a caller needing structured output cannot be silently handed a backend that will
 * return prose instead.
 */
import { MessageChannelMain, app, type WebContents } from "electron";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { secretValue } from "./vault.js";
import {
  UnsupportedCapabilityError,
  type ChatRequest,
  type InferenceProvider,
  type ProviderCapabilities,
  type ProviderId,
} from "./types.js";

/**
 * Every provider, with a scripted one substituted for the real backend of the same id.
 *
 * The substitution happens **here** rather than only in `providerById`, and that was a real bug:
 * `availableProviders` builds from this list, so `firstUsableModel` was probing the developer's
 * actual Ollama over HTTP even in a test that had scripted the provider. The chat was scripted and
 * the model *discovery* was not.
 *
 * That made the unit suite depend on machine state — three assessor tests took 500ms to 1.3s
 * against a live daemon and began timing out once it was busy. CI never noticed, because with no
 * Ollama installed `available()` fails immediately and the tests take the no-model path.
 *
 * Ordering is preserved by mapping over the real list rather than concatenating, so the
 * local-before-remote sort still means what it says.
 */
function providers(): InferenceProvider[] {
  return realProviders().map((p) => scripted.get(p.id) ?? p);
}


/**
 * The session the hosted backend is shown, or `undefined` when there is none.
 *
 * A per-user, per-device session token minted by `/v1/auth/desktop/session` and kept in the OS
 * keychain beside the OpenRouter key. Read at the moment of use, never held, so signing out stops
 * working on the next request rather than the next launch.
 *
 * IT IS A BEARER TOKEN AND NOT THE WEB APP'S IDENTITY HEADER, and the difference is the whole
 * design. The web app's mechanism is an HMAC over the user id with a secret shared between the
 * Next.js proxy and the API; shipping that inside an installable application would hand every user
 * the key to assert any identity. A token is per-person, revocable on its own, and worth exactly
 * one account if it leaks.
 *
 * WHY A TOKEN GETTER AND NOT EXTRA HEADERS. This used to be passed as `extraHeaders`. That looked
 * equivalent and was not: `OpenAICompatibleProvider.available()` only short-circuits on a missing
 * `authToken`, so with headers the provider probed `GET {api}/models` on every availability check
 * — signed out, with nothing to send. Harmless against loopback; against a production URL it meant
 * every signed-out launch of a local-first app reached our server, which is the promise the app
 * spec makes it not break. With a getter, no session means not available, and no request at all.
 *
 * DEVELOPMENT ONLY: `VOIDCODE_DEV_SESSION_TOKEN`. Replaces the old `VOIDCODE_USER_ID`, which sent
 * a bare, unsigned user id and only worked against an API with identity enforcement off. A dev
 * token is a real session (mint one with `apps/api/scripts/mint_desktop_session.py`), so dev and
 * production exercise the same path. It is read only in an unpackaged build and only when nothing
 * is stored, so a real session always wins and a shipped app can never be told to use one.
 */
async function hostedToken(): Promise<string | undefined> {
  const stored = secretValue("voidcode");
  if (stored !== undefined) return stored;

  // `app` is undefined under the unit-test Electron stub. Unknown is treated as packaged: the
  // override is the thing that must never apply by accident, so it fails closed.
  const unpackaged = app !== undefined && app.isPackaged === false;
  const dev = process.env.VOIDCODE_DEV_SESSION_TOKEN;
  return unpackaged && dev !== undefined && dev !== "" ? dev : undefined;
}

function realProviders(): InferenceProvider[] {
  return [
    new OllamaProvider(),
    new OpenAICompatibleProvider({
      id: "llamacpp",
      label: "llama.cpp",
      // Also where a vLLM endpoint is pointed: same protocol, and deliberately
      // connect-only — never installed or managed by us (spec §2.7).
      baseUrl: "http://127.0.0.1:8080/v1",
      capabilities: { tools: false, grammar: true, remote: false },
    }),
    new OpenAICompatibleProvider({
      id: "hosted",
      label: "VoidCode",
      // The platform API, not a model server. Overridable so a developer can point at a local
      // instance without a rebuild; the default is what a packaged app ships with.
      baseUrl: process.env.VOIDCODE_API_URL ?? "http://127.0.0.1:8020/v1",
      // `remote: true` IS THE CONSENT DECISION, not a description.
      //
      // It drives the cloud-active indicator and the upload-consent prompt. Text sent here
      // leaves the machine and reaches our server, which is exactly the thing a learner who
      // chose a local-first app would want to be asked about — and the fact that the server is
      // ours rather than a third party's does not make the question go away.
      //
      // `tools` and `grammar` are false because the tutor endpoint offers neither: it serves one
      // chat completion with a curriculum system prompt, and claiming otherwise would let the
      // paper pipeline pick this provider and get prose where it required JSON.
      capabilities: { tools: false, grammar: false, remote: true },
      authToken: hostedToken,
    }),
    new OpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      capabilities: { tools: true, grammar: true, remote: true },
      // Read at the moment of use, from `vault.ts`, so nothing here holds a credential and a key
      // cleared mid-session stops working on the next request rather than the next launch.
      authToken: async () => secretValue("openrouter"),
    }),
  ];
}

/**
 * Test seam: stand a scripted provider in for a real backend.
 *
 * The agent loop is the one piece here that cannot be tested against a real model. Its shape —
 * does it stop when the model says stop, does it run the tools it was asked to, does it refuse
 * to write — is decided by the *sequence* of chunks a provider yields, and reproducing a
 * specific sequence from a live model is not something a test can do. Scripting it is the only
 * way those questions get asked every run rather than on the days someone has Ollama up.
 *
 * Keyed by id and consulted first, so a scripted `ollama` replaces the real one and everything
 * else still resolves normally.
 */
const scripted = new Map<ProviderId, InferenceProvider>();

export function __scriptProvider(id: ProviderId, provider: InferenceProvider | undefined): void {
  if (provider === undefined) scripted.delete(id);
  else scripted.set(id, provider);
}

export function providerById(id: ProviderId): InferenceProvider | undefined {
  // No `scripted.get` here any more: `providers()` already substitutes, so this is the one place
  // the override is applied and the two cannot disagree about which provider is in play.
  return providers().find((p) => p.id === id);
}

/**
 * Where a provider's traffic actually goes, as a host.
 *
 * For the upload-consent prompt, which has to name a *place*: "a remote provider" is not
 * something a person can make an informed decision about. Kept beside the URLs above so the
 * two cannot drift — a provider whose endpoint moved and whose prompt still named the old
 * host would be worse than no prompt.
 */
export function destinationFor(id: ProviderId): string {
  switch (id) {
    case "ollama":
      return "127.0.0.1:11434";
    case "llamacpp":
      return "127.0.0.1:8080";
    case "hosted":
      return new URL(process.env.VOIDCODE_API_URL ?? "http://127.0.0.1:8020/v1").host;
    case "openrouter":
      return "openrouter.ai";
  }
}

/**
 * Which backends are usable right now, local ones first.
 *
 * Ordering is a policy statement, not a convenience: a local-first app should reach for
 * the machine in front of it before sending anything to a third party, and the user
 * should have to choose the cloud rather than land on it.
 */
export async function availableProviders(): Promise<
  Array<{
    id: ProviderId;
    label: string;
    capabilities: ProviderCapabilities;
    /** Model ids this backend can serve right now, without a download. */
    models: string[];
  }>
> {
  const all = providers();
  const checks = await Promise.all(all.map((p) => p.available()));
  const reachable = all.filter((_, i) => checks[i] === true);

  /**
   * Installed models, not the catalogue.
   *
   * `models:list` returns `CATALOGUE` — everything downloadable — which is the right answer
   * for "what could I install" and the wrong one for "what is ready". The status bar needs
   * the second, and this is the natural place for it: the question is really "which backends
   * are up, and what can each of them serve".
   */
  const models = await Promise.all(
    reachable.map((p) =>
      // A backend can answer `available()` and still fail to list — it was starting up, or it
      // died between the two calls. An empty list reads as "reachable, nothing installed",
      // which is the honest rendering and not worth failing the whole call for.
      p.listModels().then(
        (list) => list.map((m) => m.id),
        () => []
      )
    )
  );

  return reachable
    .map((p, i) => ({
      id: p.id,
      label: p.label,
      capabilities: p.capabilities,
      models: models[i] ?? [],
    }))
    .sort((a, b) => Number(a.capabilities.remote) - Number(b.capabilities.remote));
}

/** Reject rather than degrade when a required capability is missing. */
function assertCapable(provider: InferenceProvider, request: ChatRequest): void {
  if (request.json === true && !provider.capabilities.grammar) {
    // Silently returning prose where JSON was required is the failure this prevents: the
    // paper pipeline would then store a candidate built from a parse that never happened.
    throw new UnsupportedCapabilityError(provider.id, "grammar");
  }

  /**
   * `capabilities.tools` becomes real here.
   *
   * It has existed as a flag since the interface was written and was read only to display it.
   * A provider that ignores a `tools` array does not fail — it answers in prose about what it
   * would do, which reads like a model that decided not to use a tool rather than a server
   * that could not. An agent loop then waits for a call that is never coming.
   */
  if (request.tools !== undefined && request.tools.length > 0 && !provider.capabilities.tools) {
    throw new UnsupportedCapabilityError(provider.id, "tools");
  }
}

export class NoModelAvailableError extends Error {
  constructor() {
    super("No local model is available");
    this.name = "NoModelAvailableError";
  }
}

/**
 * One completion, collected rather than streamed.
 *
 * Every other chat path in the app hands a `MessagePort` to the renderer, because the
 * renderer is what renders tokens. This one exists for work that must finish *inside main* —
 * grading an interview answer against a reference the renderer may not see. Streaming it
 * would mean streaming it somewhere, and the only somewhere is the renderer.
 *
 * `error` is terminal and mutually exclusive with `done`, so it is rethrown rather than
 * returned as empty text: a caller that got `""` could not tell "the model said nothing"
 * from "the daemon died".
 */
export async function completeChat(
  providerId: ProviderId,
  request: Omit<ChatRequest, "signal">,
  signal?: AbortSignal
): Promise<{
  text: string;
  /** True if the model emitted reasoning. See the note beside the accumulator. */
  reasoned: boolean;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}> {
  const provider = providerById(providerId);
  if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
  assertCapable(provider, request);

  const parts: string[] = [];
  /**
   * Whether the model reasoned, not what it reasoned.
   *
   * A boolean rather than the text, deliberately. The one caller is the interview assessor, whose
   * whole job is withholding the model answer — handing it a transcript of a model reasoning
   * aloud about the solution would put the answer one field access from the feedback it stores.
   * What it needs is only the distinction: a model that produced nothing because it spent its
   * budget thinking is a different event from a model that said nothing at all, and before this
   * the two were the same empty string.
   */
  let reasoned = false;
  let usage: { promptTokens?: number; completionTokens?: number } = {};

  const iterable = provider.chat(signal === undefined ? request : { ...request, signal });
  for await (const chunk of iterable) {
    if (chunk.kind === "token") parts.push(chunk.text);
    else if (chunk.kind === "reasoning") reasoned = true;
    else if (chunk.kind === "done") {
      usage = {
        ...(chunk.promptTokens !== undefined ? { promptTokens: chunk.promptTokens } : {}),
        ...(chunk.completionTokens !== undefined
          ? { completionTokens: chunk.completionTokens }
          : {}),
      };
    } else if (chunk.kind === "error") throw new Error(chunk.message);
    // A `tool_call` is ignored here on purpose. This helper collects a whole completion as
    // text for callers that want an answer, not a conversation — the interview assessor and
    // a one-shot caller. An agent loop uses the streaming path, which sees every chunk.
  }

  return { text: parts.join(""), reasoned, model: request.model, ...usage };
}

/**
 * Whatever is actually installed, rather than a hardcoded tag.
 *
 * Hardcoding a default is how inline completion shipped pointing at a 1.5b nobody had,
 * failing silently on every keystroke. The seam does the same search for the tutor stream;
 * this is main's copy, needed because a caller inside main cannot ask the renderer.
 */
export async function firstUsableModel(): Promise<{ provider: ProviderId; model: string }> {
  // `availableProviders` already orders local backends first, which is a policy statement
  // rather than a convenience — taking `[0]` inherits it rather than restating it.
  const reachable = await availableProviders();
  const usable = reachable.find((p) => p.models.length > 0);
  if (usable === undefined || usable.models[0] === undefined) throw new NoModelAvailableError();
  return { provider: usable.id, model: usable.models[0] };
}

export interface StreamHandle {
  /** Handed to the renderer; the far end receives `ChatChunk` messages. */
  port: Electron.MessagePortMain;
  cancel(): void;
}

/**
 * Stream a chat over a `MessagePort` (spec §2.3).
 *
 * Not repeated `ipcRenderer.send`: every token would serialise through the broker and
 * stall main under load. The port is transferred once and the tokens flow directly.
 *
 * The port also becomes the lifetime. If the window closes, the port closes, and the
 * generation is aborted — a stream that outlives the thing that asked for it is just a
 * GPU heater.
 */
export function openChatStream(
  sender: WebContents,
  providerId: ProviderId,
  request: Omit<ChatRequest, "signal">
): StreamHandle {
  const provider = providerById(providerId);
  if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
  assertCapable(provider, request);

  const { port1, port2 } = new MessageChannelMain();
  const controller = new AbortController();

  port1.on("close", () => controller.abort());
  port1.start();

  void (async () => {
    try {
      for await (const chunk of provider.chat({ ...request, signal: controller.signal })) {
        port1.postMessage(chunk);
      }
    } catch (err) {
      port1.postMessage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    } finally {
      port1.close();
    }
  })();

  // Also abort if the window goes away without the port being closed first.
  sender.once("destroyed", () => controller.abort());

  return { port: port2, cancel: () => controller.abort() };
}
