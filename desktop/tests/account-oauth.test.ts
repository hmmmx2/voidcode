/**
 * Google and Microsoft sign-in, from main's side, driven by a fake provider.
 *
 * WHAT THE FAKE PROVIDER IS. Not a mock of our own code: a real HTTP request to the real loopback
 * listener, built from the real authorize URL the flow just tried to open. `shell.openExternal` is
 * recorded rather than performed, the test reads the URL a browser would have been sent to, and then
 * plays the browser — including playing it badly, with the wrong `state`, the wrong `Host`, the wrong
 * path, or twice. Only our API is stubbed, because verifying an ID token is server-side work with its
 * own Postgres suite (`apps/api/tests/test_oauth_signin.py`).
 *
 * WHY THE DESKTOP HALF NEEDS ITS OWN TESTS AT ALL, given the API verifies everything. Because the
 * failures possible on this side are different ones, and none of them are visible to the API:
 *
 *   * A listener on 0.0.0.0 hands authorization codes to the local network.
 *   * A callback accepted without checking `state` lets any page that can guess the port feed a code
 *     into somebody's sign-in — and a `state` check that treats a mismatch as fatal lets that same
 *     page cancel it instead.
 *   * A `Host` header left unchecked is a DNS-rebinding target.
 *   * A port left bound after the flow ends is a listener nobody is watching.
 *   * A `url` field on the IPC channel would make this the one call in the application that opens an
 *     arbitrary address in the user's browser on the renderer's say-so.
 *
 * Each of those is asserted below, and each was applied as a mutation to check the assertion fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";

const { __useInMemory } = await import("../src/main/store/db.js");
const { __safeStorage, __shell } = await import("./stubs/electron.js");
const { secretValue, setSecret, __resetSessionSecrets } = await import("../src/main/inference/vault.js");
const { __setOverridesAllowed } = await import("../src/main/platform/config.js");
const session = await import("../src/main/account/session.js");
const oauth = await import("../src/main/account/oauth.js");
const providers = await import("../src/main/account/providers.js");
const { openLoopback, CALLBACK_PATH } = await import("../src/main/account/loopback.js");
const { CHANNELS } = await import("../src/main/ipc/contract.js");
const { TERMS_VERSION } = await import("../src/shared/legal.js");

/** The pattern `apps/api/src/routers/auth.py` accepts for `redirect_uri`, copied verbatim. */
const API_REDIRECT_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/oauth\/callback$/;
/** The API's `nonce` and `code_verifier` patterns, also verbatim. */
const API_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const GOOGLE_ID = "123456789-desktoptestclient.apps.googleusercontent.example";
const MICROSOFT_ID = "00000000-0000-0000-0000-00000000test";

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let events: string[] = [];

type Reply = { status: number; body?: unknown } | Error;

function stubFetch(respond: (url: string) => Reply): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        authorization: headers.authorization,
        body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });
      const reply = respond(String(input));
      if (reply instanceof Error) throw reply;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      });
    }),
  );
}

const USER = { id: "u-42", email: "learner@example.com", name: "Learner" };
const ME = { ...USER, has_password: false, email_verified: true, providers: ["google"] };

/** A session response, as `_session_response` in the API builds it. */
function sessionBody(extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: { token: "provider-token", expires_at: "2026-12-16T00:00:00Z", user: USER, ...extra },
  };
}

/** The flow answers `/auth/me` too, because linking refreshes the account afterwards. */
function apiThatSignsIn(oauthReply: Reply = sessionBody()): (url: string) => Reply {
  return (url) => (url.includes("/auth/desktop/oauth/") ? oauthReply : { status: 200, body: ME });
}

// ── The fake browser ─────────────────────────────────────────────────────────

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A single GET, with the `Host` header under the test's control. */
async function get(url: string, host?: string): Promise<Answer> {
  const target = new URL(url);
  return await new Promise<Answer>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: host === undefined ? {} : { host },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += String(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Whether anything is still listening there. The assertion behind "the port was released". */
async function isListening(url: string): Promise<boolean> {
  try {
    await get(url);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The authorize URL the flow tried to open, once it has tried. */
const browserUrl = async (): Promise<URL> => await until(() => __shell.lastUrl(), "a browser to open");

/**
 * Play the browser: take the authorize request, add whatever the provider would have sent back, and
 * GET the redirect. `state` comes from the authorize request unless the test overrides it.
 */
async function redirectBack(
  authorize: URL,
  params: Record<string, string>,
  options: { host?: string; path?: string } = {},
): Promise<Answer> {
  const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  if (options.path !== undefined) redirect.pathname = options.path;
  redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
  return await get(redirect.toString(), options.host);
}

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
  __shell.reset();
  calls = [];
  events = [];
  delete process.env.VOIDCODE_DEV_SESSION_TOKEN;
  __setOverridesAllowed(true);
  process.env.VOIDCODE_API_URL = "http://127.0.0.1:59998/v1";
  process.env.VOIDCODE_GOOGLE_CLIENT_ID = GOOGLE_ID;
  process.env.VOIDCODE_MICROSOFT_CLIENT_ID = MICROSOFT_ID;
  session.__resetSessionMemory();
  session.setAccountBroadcaster((event) => events.push(event.reason));
});

afterEach(() => {
  oauth.cancel();
  vi.unstubAllGlobals();
  __setOverridesAllowed(undefined);
  delete process.env.VOIDCODE_API_URL;
  delete process.env.VOIDCODE_GOOGLE_CLIENT_ID;
  delete process.env.VOIDCODE_MICROSOFT_CLIENT_ID;
  session.setAccountBroadcaster(() => {});
});

// ── The authorize request ────────────────────────────────────────────────────

describe("the request a browser is sent", () => {
  const request = {
    clientId: GOOGLE_ID,
    redirectUri: "http://127.0.0.1:41234/oauth/callback",
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    codeChallenge: "c".repeat(43),
  };

  it("carries PKCE, the loopback redirect, state and nonce", () => {
    const url = new URL(providers.authorizeUrl("google", request));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const query = url.searchParams;
    expect(query.get("client_id")).toBe(GOOGLE_ID);
    expect(query.get("response_type")).toBe("code");
    expect(query.get("redirect_uri")).toBe(request.redirectUri);
    expect(query.get("state")).toBe(request.state);
    expect(query.get("nonce")).toBe(request.nonce);
    expect(query.get("code_challenge")).toBe(request.codeChallenge);
    // `plain` would send the verifier itself, which is the thing PKCE exists to avoid sending.
    expect(query.get("code_challenge_method")).toBe("S256");
    // Both providers otherwise reuse whichever account the browser is already holding, with no
    // visible choice — which on a Connect button is exactly the question being asked.
    expect(query.get("prompt")).toBe("select_account");
  });

  it("asks for a name and an email address, and for no standing access", () => {
    for (const provider of providers.PROVIDERS) {
      const query = new URL(providers.authorizeUrl(provider, request)).searchParams;
      expect(query.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
      // A refresh token is permission to act as someone later. This flow signs a person in once.
      expect(query.get("scope")).not.toContain("offline_access");
      expect(query.get("access_type")).toBeNull();
    }
  });

  it("sends Microsoft to /common and asks for the code in the query string", () => {
    const url = new URL(providers.authorizeUrl("microsoft", request));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    // `form_post` would POST the code to the listener, which only reads a URL — the flow would
    // hang on a redirect that did arrive.
    expect(url.searchParams.get("response_mode")).toBe("query");
  });

  it("escapes every value exactly once", () => {
    // A hand-built query string turns the `+` a base64 challenge can contain into a space, and the
    // provider then answers `invalid_grant` — which reads like a server fault, not a typo here.
    const url = new URL(
      providers.authorizeUrl("google", { ...request, state: "a+b/c=d&e", codeChallenge: "x+y/z" }),
    );
    expect(url.searchParams.get("state")).toBe("a+b/c=d&e");
    expect(url.searchParams.get("code_challenge")).toBe("x+y/z");
  });
});

// ── The listener ─────────────────────────────────────────────────────────────

describe("the loopback listener", () => {
  it("binds loopback, on a redirect URI the API will accept", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    try {
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      // Not a restatement of the line above: this is the server's own pattern, so a redirect URI
      // this side is happy with and the API rejects fails here rather than at the last step of a
      // real sign-in.
      expect(listener.redirectUri).toMatch(API_REDIRECT_PATTERN);
      expect(CALLBACK_PATH).toBe("/oauth/callback");
    } finally {
      listener.cancel();
    }
  });

  it("delivers a code once, then answers 410 and lets the port go", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    const first = await get(`${listener.redirectUri}?code=abc&state=state-1`);
    expect(first.status).toBe(200);
    expect(await listener.result).toEqual({ outcome: "code", code: "abc" });

    // Whatever arrives after the answer — a reload of the return page, or a replay — gets nothing.
    // The port is normally gone by now, so either refusal is correct; what must not happen is a
    // second delivery.
    let replayed = 410;
    try {
      replayed = (await get(`${listener.redirectUri}?code=abc&state=state-1`)).status;
    } catch {
      replayed = 0; // connection refused: the listener has already closed
    }
    expect([0, 410]).toContain(replayed);
    expect(await isListening(listener.redirectUri)).toBe(false);
  });

  it("answers a wrong state and keeps waiting", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    try {
      const wrong = await get(`${listener.redirectUri}?code=abc&state=guessed`);
      expect(wrong.status).toBe(400);
      expect(listener.refusedCount()).toBe(1);

      // THE POINT OF THIS TEST. Treating a bad `state` as a failure would hand any page that can
      // guess the port a way to cancel somebody's sign-in.
      const settled = await Promise.race([
        listener.result,
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 120)),
      ]);
      expect(settled).toBe("still waiting");

      // And the real redirect, arriving afterwards, is still accepted.
      await get(`${listener.redirectUri}?code=real&state=state-1`);
      expect(await listener.result).toEqual({ outcome: "code", code: "real" });
    } finally {
      listener.cancel();
    }
  });

  it("refuses a request that is not for the address it published", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    try {
      // A page on `evil.example` that resolves its own name to 127.0.0.1 reaches this port, but the
      // browser sends its own host. That header is the only thing separating the two cases.
      const rebound = await get(
        `${listener.redirectUri}?code=abc&state=state-1`,
        "evil.example",
      );
      expect(rebound.status).toBe(400);
      expect(listener.refusedCount()).toBe(1);
      expect(
        await Promise.race([
          listener.result,
          new Promise((resolve) => setTimeout(() => resolve("still waiting"), 80)),
        ]),
      ).toBe("still waiting");
    } finally {
      listener.cancel();
    }
  });

  it("answers only /oauth/callback, and only GET", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    try {
      const elsewhere = await get(
        `${listener.redirectUri.replace(CALLBACK_PATH, "/")}?code=abc&state=state-1`,
      );
      expect(elsewhere.status).toBe(404);
      const noCode = await get(`${listener.redirectUri}?state=state-1`);
      expect(noCode.status).toBe(400);
      expect(listener.refusedCount()).toBe(2);
    } finally {
      listener.cancel();
    }
  });

  it("returns a page that cannot fetch anything, and says so in a header", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    const answer = await get(`${listener.redirectUri}?code=abc&state=state-1`);
    await listener.result;

    /**
     * The URL OF THIS PAGE CONTAINS THE AUTHORIZATION CODE. So it loads nothing: with
     * `default-src 'none'` there is no subresource to carry a `Referer`, and `no-referrer` covers
     * the case of the reader clicking onwards. A stylesheet for the sake of a tab about to be
     * closed would be the wrong trade.
     */
    expect(answer.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).not.toContain("<script");
    expect(answer.body).not.toMatch(/src=|href=/);
  });

  it("gives up on its own, and releases the port when it does", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 50 });
    expect(await listener.result).toEqual({ outcome: "timeout" });
    expect(await isListening(listener.redirectUri)).toBe(false);
  });

  it("can be cancelled, which also releases the port", async () => {
    const listener = await openLoopback({ state: "state-1", timeoutMs: 5_000 });
    listener.cancel();
    expect(await listener.result).toEqual({ outcome: "cancelled" });
    expect(await isListening(listener.redirectUri)).toBe(false);
    // Cancelling twice is what a window closing during a finished flow does.
    listener.cancel();
  });
});

// ── What the renderer may ask for ────────────────────────────────────────────

describe("the channel the renderer calls", () => {
  it("accepts two enums and nothing that could name an address", () => {
    const schema = CHANNELS["account:signInOAuth"].input;
    expect(schema.safeParse({ provider: "google", mode: "signIn" }).success).toBe(true);
    expect(schema.safeParse({ provider: "microsoft", mode: "link" }).success).toBe(true);
    expect(schema.safeParse({ provider: "evil", mode: "signIn" }).success).toBe(false);
    expect(schema.safeParse({ provider: "google", mode: "whatever" }).success).toBe(false);

    /**
     * THE ASSERTION THIS FILE EXISTS FOR, on the IPC side. `account:signInOAuth` is the only path
     * from a renderer to `shell.openExternal` in this application. A `url` — or a `redirectUri`, or
     * a `scope`, or an `authorizeUrl` — accepted here would make the set of addresses a renderer can
     * have opened in the person's browser unbounded. zod strips unknown keys rather than failing, so
     * the check is that the PARSED value carries nothing but the two enums.
     */
    const parsed = schema.parse({
      provider: "google",
      mode: "signIn",
      url: "https://evil.example/steal",
      redirectUri: "http://127.0.0.1:1/",
      scope: "https://mail.google.com/",
    });
    expect(Object.keys(parsed).sort()).toEqual(["mode", "provider"]);
  });

  it("declares the whole provider surface, in both window modes", () => {
    for (const channel of [
      "account:providers",
      "account:signInOAuth",
      "account:cancelOAuth",
      "account:reopenOAuth",
    ] as const) {
      expect(CHANNELS[channel], channel).toBeDefined();
      // A Study window is exactly where someone signs in to use the VoidCode tutor.
      expect(CHANNELS[channel].modes, channel).toEqual(["study", "build"]);
    }
  });
});

describe("a build with no provider registration", () => {
  beforeEach(() => {
    delete process.env.VOIDCODE_GOOGLE_CLIENT_ID;
    delete process.env.VOIDCODE_MICROSOFT_CLIENT_ID;
  });

  it("reports both providers as unavailable", () => {
    expect(providers.providerStatuses()).toEqual([
      { id: "google", label: "Google", configured: false },
      { id: "microsoft", label: "Microsoft", configured: false },
    ]);
  });

  it("refuses without opening a browser or contacting anything", async () => {
    stubFetch(() => ({ status: 200, body: ME }));
    const result = await oauth.signIn("google", "signIn");

    expect(result).toEqual({
      ok: false,
      code: "not_configured",
      message: "Google sign-in isn't set up in this build.",
    });
    // A fork's pull request builds this configuration, and it must not send anyone to a consent
    // screen for our application registration — nor to our API.
    expect(__shell.opened).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── A whole sign-in ──────────────────────────────────────────────────────────

describe("a completed sign-in", () => {
  it("relays what the API needs, and keeps the session it is given", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    const authorize = await browserUrl();
    const answer = await redirectBack(authorize, { code: "provider-code" });
    expect(answer.status).toBe(200);

    const result = await flow;
    expect(result).toEqual({
      ok: true,
      user: USER,
      created: false,
      passwordCleared: false,
    });

    const relay = calls.find((call) => call.url.includes("/auth/desktop/oauth/google"));
    expect(relay?.method).toBe("POST");
    // No Bearer: this is a sign-in, not a connect, and the API reads link mode from the credential.
    expect(relay?.authorization).toBeUndefined();
    expect(relay?.body).toMatchObject({
      client_id: GOOGLE_ID,
      code: "provider-code",
      redirect_uri: authorize.searchParams.get("redirect_uri"),
      nonce: authorize.searchParams.get("nonce"),
      // A first provider sign-in may CREATE an account, and the API refuses to without a version.
      // It is this build's, added by main — the renderer cannot send one.
      terms_version: TERMS_VERSION,
    });

    // The token reached the OS credential store and nothing else.
    expect(secretValue("voidcode")).toBe("provider-token");
    expect(JSON.stringify(result)).not.toContain("provider-token");
    expect(events).toContain("signedIn");
  });

  it("sends the verifier for the challenge the provider was actually given", async () => {
    /**
     * The PKCE binding, end to end and in the only place it can be checked: the challenge goes to
     * the provider and the verifier to our API, so nothing but a test holding both sides can tell
     * whether they are a pair. A flow that generated them independently would work against a
     * provider that does not enforce PKCE and fail against one that does.
     */
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    const authorize = await browserUrl();
    await redirectBack(authorize, { code: "provider-code" });
    await flow;

    const relay = calls.find((call) => call.url.includes("/auth/desktop/oauth/google"));
    const verifier = String(relay?.body?.code_verifier);
    expect(verifier).toMatch(API_VERIFIER_PATTERN);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    // And the nonce is a shape the API's pattern accepts, for the same reason as the redirect URI.
    expect(String(relay?.body?.nonce)).toMatch(API_NONCE_PATTERN);
    expect(authorize.searchParams.get("state")).not.toBe(authorize.searchParams.get("nonce"));
  });

  it("explains a password that was removed by the linking rules", async () => {
    stubFetch(apiThatSignsIn(sessionBody({ created: false, password_cleared: true })));
    const flow = oauth.signIn("google", "signIn");
    await redirectBack(await browserUrl(), { code: "provider-code" });

    const result = await flow;
    // Rare, and alarming if unexplained: a password that used to work has stopped working, because
    // it was set on an address nobody had proven. The renderer turns this into a toast.
    expect(result).toMatchObject({ ok: true, passwordCleared: true });
  });

  it("releases the port once the code has been relayed", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    const authorize = await browserUrl();
    const redirect = authorize.searchParams.get("redirect_uri") ?? "";
    await redirectBack(authorize, { code: "provider-code" });
    await flow;

    expect(await isListening(redirect)).toBe(false);
  });
});

// ── Connecting a provider to an account that already exists ──────────────────

describe("connecting a provider", () => {
  it("sends the session and no terms version, and issues no new token", async () => {
    setSecret("voidcode", "existing-session");
    stubFetch((url) =>
      url.includes("/auth/desktop/oauth/microsoft")
        ? { status: 200, body: { linked: true, provider: "microsoft" } }
        : { status: 200, body: ME },
    );

    const flow = oauth.signIn("microsoft", "link");
    const authorize = await browserUrl();
    expect(authorize.searchParams.get("client_id")).toBe(MICROSOFT_ID);
    await redirectBack(authorize, { code: "ms-code" });

    expect(await flow).toEqual({ ok: true, linked: true, provider: "microsoft" });

    const relay = calls.find((call) => call.url.includes("/auth/desktop/oauth/microsoft"));
    // Link mode IS the credential: the API decides it from the Bearer rather than from a flag,
    // because a flag can ask to attach a provider without proving who is asking.
    expect(relay?.authorization).toBe("Bearer existing-session");
    // Nothing is being created, so nothing is consenting to anything.
    expect(relay?.body).not.toHaveProperty("terms_version");
    // The session is unchanged — a connect does not re-issue one.
    expect(secretValue("voidcode")).toBe("existing-session");
  });

  it("refuses when nobody is signed in, before opening a browser", async () => {
    stubFetch(() => ({ status: 200, body: ME }));
    const result = await oauth.signIn("google", "link");

    expect(result).toEqual({
      ok: false,
      code: "signed_out",
      message: "Sign in first, then connect an account.",
    });
    // Five minutes in a consent screen that can only end in "you're not signed in" is worse than
    // being told now.
    expect(__shell.opened).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("passes the conflict the server reports straight through", async () => {
    setSecret("voidcode", "existing-session");
    stubFetch((url) =>
      url.includes("/auth/desktop/oauth/google")
        ? {
            status: 409,
            body: {
              detail: {
                code: "conflict",
                message: "That Google account is already connected to another VoidCode account.",
              },
            },
          }
        : { status: 200, body: ME },
    );

    const flow = oauth.signIn("google", "link");
    await redirectBack(await browserUrl(), { code: "code" });

    expect(await flow).toEqual({
      ok: false,
      code: "conflict",
      message: "That Google account is already connected to another VoidCode account.",
    });
    // The rejected provider token must not end the session the request carried.
    expect(secretValue("voidcode")).toBe("existing-session");
  });
});

// ── Everything that can go wrong ─────────────────────────────────────────────

describe("a sign-in that does not complete", () => {
  it("reports a consent screen the person cancelled, without calling the API", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    await redirectBack(await browserUrl(), { error: "access_denied" });

    expect(await flow).toEqual({
      ok: false,
      code: "denied",
      message: "Google sign-in was cancelled.",
    });
    expect(calls).toEqual([]);
  });

  it("prefers the provider's own description of any other refusal", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("microsoft", "signIn");
    await redirectBack(await browserUrl(), {
      error: "consent_required",
      error_description: "Your organisation requires an administrator to approve this application.",
    });

    expect(await flow).toMatchObject({
      ok: false,
      code: "denied",
      message: "Your organisation requires an administrator to approve this application.",
    });
  });

  it("is cancelled by the person going back to the dialog", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    const redirect = (await browserUrl()).searchParams.get("redirect_uri") ?? "";
    oauth.cancel();

    expect(await flow).toEqual({ ok: false, code: "cancelled", message: "Sign-in cancelled." });
    expect(await isListening(redirect)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is superseded by starting another one", async () => {
    stubFetch(apiThatSignsIn());
    const first = oauth.signIn("google", "signIn");
    const firstRedirect = (await browserUrl()).searchParams.get("redirect_uri") ?? "";

    // The person pressed Google, then decided on Microsoft. The abandoned tab's listener has to go
    // with it, or a code arriving from it would be relayed on behalf of a flow nobody is watching.
    const second = oauth.signIn("microsoft", "signIn");
    expect(await first).toMatchObject({ ok: false, code: "cancelled" });
    expect(await isListening(firstRedirect)).toBe(false);

    const authorize = await until(
      () => (__shell.opened.length === 2 ? __shell.lastUrl() : undefined),
      "the second browser",
    );
    await redirectBack(authorize, { code: "ms-code" });
    expect(await second).toMatchObject({ ok: true });
  });

  it("says so when there is no browser to open", async () => {
    stubFetch(apiThatSignsIn());
    __shell.fail = true;
    const result = await oauth.signIn("google", "signIn");

    expect(result).toMatchObject({ ok: false, code: "no_browser" });
    expect(calls).toEqual([]);
  });

  it("gives up rather than waiting on a tab that was closed", async () => {
    /**
     * Driven through the module's own timeout by shortening it, because the alternative — waiting
     * out the real five minutes — is not a test anyone runs. `pendingFlow()` is the observable
     * proof that the module forgot the flow, rather than leaving a listener behind.
     */
    const listener = await openLoopback({ state: "s", timeoutMs: 40 });
    expect(await listener.result).toEqual({ outcome: "timeout" });
    expect(oauth.pendingFlow()).toBeNull();
  });

  it("reports a provider refusal from our API in the server's words", async () => {
    stubFetch(
      apiThatSignsIn({
        status: 422,
        body: {
          detail: {
            code: "unverified_email",
            message:
              "Microsoft didn't confirm this email address, so it can't be used to sign in. Sign in with your email and password (or create an account), then connect Microsoft from your Account page.",
          },
        },
      }),
    );
    const flow = oauth.signIn("microsoft", "signIn");
    await redirectBack(await browserUrl(), { code: "code" });

    const result = await flow;
    // The renderer branches on `unverified_email` to offer the email route the message describes.
    expect(result).toMatchObject({ ok: false, code: "unverified_email" });
    expect((result as { message: string }).message).toContain("then connect Microsoft");
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("collapses a rate limit into one sentence, without the server's own", async () => {
    stubFetch(apiThatSignsIn({ status: 429, body: { detail: "Rate limit exceeded: 20 per 300s" } }));
    const flow = oauth.signIn("google", "signIn");
    await redirectBack(await browserUrl(), { code: "code" });

    // The limiter's wording names its own window and counter, which is of no use to the person.
    expect(await flow).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many attempts. Wait a few minutes and try again.",
    });
  });

  it("says it could not reach VoidCode rather than blaming the provider", async () => {
    stubFetch(() => new TypeError("fetch failed"));
    const flow = oauth.signIn("google", "signIn");
    await redirectBack(await browserUrl(), { code: "code" });

    expect(await flow).toMatchObject({ ok: false, code: "offline" });
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("refuses to store a session it cannot keep, and revokes it", async () => {
    /**
     * The server has ALREADY issued the token by this point. Reporting the failure and stopping
     * would leave a live session on our server held by no device and revocable by nobody, so
     * `keep()` revokes it with its own header — the one behaviour the provider path inherits from
     * the password path rather than reimplementing, which is why they share `outcomes.ts`.
     */
    __safeStorage.available = false;
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    await redirectBack(await browserUrl(), { code: "code" });

    expect(await flow).toMatchObject({ ok: false, code: "storage_unavailable" });
    const revoke = calls.find((call) => call.method === "DELETE");
    expect(revoke?.url).toContain("/auth/desktop/session");
    expect(revoke?.authorization).toBe("Bearer provider-token");
    expect(secretValue("voidcode")).toBeUndefined();
  });
});

// ── Reopening the browser ────────────────────────────────────────────────────

describe("opening the browser again", () => {
  it("reopens the same authorization request", async () => {
    stubFetch(apiThatSignsIn());
    const flow = oauth.signIn("google", "signIn");
    const first = await browserUrl();

    expect(await oauth.reopen()).toEqual({ ok: true });
    // The SAME url, deliberately: a fresh one would mean a new state and a new listener, leaving the
    // tab the person still has open answering a flow nobody is waiting for.
    expect(__shell.opened).toHaveLength(2);
    expect(__shell.opened[1]).toBe(first.toString());

    await redirectBack(first, { code: "code" });
    expect(await flow).toMatchObject({ ok: true });
  });

  it("has nothing to reopen once the flow is over", async () => {
    expect(await oauth.reopen()).toMatchObject({ ok: false, code: "no_flow" });
    expect(__shell.opened).toEqual([]);
  });
});
