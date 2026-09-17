/**
 * The optional VoidCode account, from main's side: what signed out means, when a session ends, and
 * which errors may end it.
 *
 * `honest-copy.test.ts` pins the Privacy Policy's "an account is optional, and without one the
 * application runs entirely on your machine" to this file, so the first block is not a nicety: it is
 * the evidence behind a legal sentence. Every "no request" assertion below runs with a configured,
 * acceptable API address, so it holds because of the session and not because there was nowhere to
 * send one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { __useInMemory } = await import("../src/main/store/db.js");
const { __safeStorage } = await import("./stubs/electron.js");
const { secretValue, setSecret, __resetSessionSecrets } = await import("../src/main/inference/vault.js");
const { __setOverridesAllowed } = await import("../src/main/platform/config.js");
const session = await import("../src/main/account/session.js");
const password = await import("../src/main/account/password.js");
const hosted = await import("../src/main/inference/hosted.js");
const { TERMS_VERSION } = await import("../src/shared/legal.js");
const { CHANNELS } = await import("../src/main/ipc/contract.js");

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

let calls: Call[] = [];
let events: { reason: string; signedIn: boolean }[] = [];

type Reply = { status: number; body?: unknown } | Error;

/** Records every request and answers from `respond`. An `Error` reply simulates no connection. */
function stubFetch(respond: (url: string, method: string) => Reply): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const method = init.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        authorization: headers.authorization,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const reply = respond(String(input), method);
      if (reply instanceof Error) throw reply;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
    }),
  );
}

const ME = {
  id: "u-1",
  email: "learner@example.com",
  name: "Learner",
  has_password: true,
  email_verified: false,
  providers: [],
  created_at: "2026-09-01T00:00:00Z",
};

const SESSION = (token: string) => ({
  status: 200,
  body: { token, expires_at: "2026-12-16T00:00:00Z", user: { id: ME.id, email: ME.email, name: ME.name } },
});

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
  calls = [];
  events = [];
  delete process.env.VOIDCODE_DEV_SESSION_TOKEN;
  __setOverridesAllowed(true);
  process.env.VOIDCODE_API_URL = "http://127.0.0.1:59999/v1";
  session.__resetSessionMemory();
  session.setAccountBroadcaster((event) => events.push({ reason: event.reason, signedIn: event.state.signedIn }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setOverridesAllowed(undefined);
  delete process.env.VOIDCODE_API_URL;
  session.setAccountBroadcaster(() => {});
});

describe("signed out, nothing reaches the server", () => {
  it("state, refresh and every account read answer without a request", async () => {
    stubFetch(() => ({ status: 200, body: ME }));

    expect(session.state()).toEqual({ signedIn: false, user: null, offline: false, durable: false });
    expect((await session.refresh()).signedIn).toBe(false);
    expect((await hosted.credits()).ok).toBe(false);
    expect(await hosted.packs()).toEqual([]);
    const change = await password.changePassword({ currentPassword: "x", newPassword: "y" });
    expect(change.ok).toBe(false);
    expect(await session.signOutEverywhere()).toEqual({ ok: false, message: "You're not signed in." });
    await session.signOut();

    // THE assertion the Privacy Policy rests on.
    expect(calls).toEqual([]);
  });

  it("signing in is the first request, and it is the one the person asked for", async () => {
    stubFetch((url) => (url.endsWith("/auth/desktop/session") ? SESSION("tok-1") : { status: 200, body: ME }));

    const result = await password.signInPassword("learner@example.com", "a long enough password");

    expect(result).toEqual({ ok: true, user: { id: ME.id, email: ME.email, name: ME.name } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:59999/v1/auth/desktop/session");
    expect(calls[0]?.authorization).toBeUndefined();
    expect(secretValue("voidcode")).toBe("tok-1");
    expect(events[0]).toEqual({ reason: "signedIn", signedIn: true });
  });
});

describe("a session ends when the server says so, and only then", () => {
  it("a 401 on the stored session signs out and says it expired", async () => {
    setSecret("voidcode", "stale");
    stubFetch(() => ({ status: 401, body: { detail: "This request could not be authenticated." } }));

    await session.refresh();

    expect(secretValue("voidcode")).toBeUndefined();
    expect(events).toEqual([{ reason: "expired", signedIn: false }]);
  });

  it("a 401 for a token that has since been replaced leaves the new session alone", () => {
    setSecret("voidcode", "new-session");

    session.handleUnauthorized("old-session");

    expect(secretValue("voidcode")).toBe("new-session");
    expect(events).toEqual([]);
  });

  it("no connection keeps the session and reports offline", async () => {
    setSecret("voidcode", "tok");
    stubFetch(() => new TypeError("fetch failed"));

    const state = await session.refresh();

    expect(state).toMatchObject({ signedIn: true, offline: true });
    expect(secretValue("voidcode")).toBe("tok");
  });

  it("a mistyped current password is a form error, not a sign-out", async () => {
    // The API used to answer this with 401, and `http.ts` ends the session on any 401 it sent a
    // session with — so the person who was, by definition, signed in got signed out for a typo.
    setSecret("voidcode", "tok");
    stubFetch(() => ({
      status: 400,
      body: { detail: { field: "current_password", code: "wrong_password", detail: "That is not your current password." } },
    }));

    const result = await password.changePassword({ currentPassword: "wrong", newPassword: "whatever it is" });

    expect(result).toEqual({
      ok: false,
      code: "wrong_password",
      message: "That is not your current password.",
      field: "current_password",
    });
    expect(secretValue("voidcode")).toBe("tok");
    expect(events).toEqual([]);
  });

  it("refresh caches who is signed in, in memory, and announces a change", async () => {
    setSecret("voidcode", "tok");
    stubFetch(() => ({ status: 200, body: ME }));

    const state = await session.refresh();

    expect(state.user).toEqual({
      id: ME.id,
      email: ME.email,
      name: ME.name,
      hasPassword: true,
      emailVerified: false,
      providers: [],
    });
    expect(events).toEqual([{ reason: "updated", signedIn: true }]);
    await session.refresh();
    expect(events, "an unchanged account is not a change").toHaveLength(1);
  });
});

describe("signing out", () => {
  it("clears the local session even when the server cannot be reached", async () => {
    setSecret("voidcode", "tok");
    stubFetch(() => new TypeError("fetch failed"));

    await session.signOut();

    expect(secretValue("voidcode")).toBeUndefined();
    expect(events).toEqual([{ reason: "signedOut", signedIn: false }]);
  });

  it("everywhere: revokes on the server, then signs this device out", async () => {
    setSecret("voidcode", "tok");
    stubFetch(() => ({ status: 200, body: { message: "Signed out everywhere." } }));

    expect(await session.signOutEverywhere()).toEqual({ ok: true });
    expect(calls).toEqual([
      expect.objectContaining({ url: "http://127.0.0.1:59999/v1/auth/desktop/sessions", method: "DELETE", authorization: "Bearer tok" }),
    ]);
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("everywhere, unreachable: keeps this device signed in and says the others still are", async () => {
    // Clearing locally would leave the person believing every device was signed out.
    setSecret("voidcode", "tok");
    stubFetch(() => new TypeError("fetch failed"));

    const result = await session.signOutEverywhere();

    expect(result.ok).toBe(false);
    expect(secretValue("voidcode")).toBe("tok");
  });
});

describe("registration and reset", () => {
  it("records the terms version this build displays, never one supplied from outside", async () => {
    stubFetch((url) => (url.endsWith("/auth/desktop/register") ? { ...SESSION("tok"), status: 201 } : { status: 200, body: ME }));

    const result = await password.register({ name: "Learner", email: "learner@example.com", password: "a long enough password" });

    expect(result.ok).toBe(true);
    expect(calls[0]?.body).toMatchObject({ terms_accepted: true, terms_version: TERMS_VERSION });
  });

  it("a rejected code keeps the server's words and field, and signs nobody in", async () => {
    stubFetch(() => ({ status: 400, body: { detail: { field: "code", detail: "That code isn't valid or has expired." } } }));

    const result = await password.resetPassword({ email: "learner@example.com", code: "123456", newPassword: "a long enough password" });

    expect(result).toMatchObject({ ok: false, field: "code", message: "That code isn't valid or has expired." });
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("too many attempts reads as a rate limit, whatever the body says", async () => {
    stubFetch(() => ({ status: 429, body: { detail: "Rate limit exceeded" } }));
    const result = await password.signInPassword("learner@example.com", "pw");
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("no API address is a clear answer, not a masked failure", async () => {
    delete process.env.VOIDCODE_API_URL;
    __setOverridesAllowed(false);
    stubFetch(() => ({ status: 200 }));

    const result = await password.requestPasswordCode("learner@example.com");

    expect(result).toMatchObject({ ok: false, code: "not_configured" });
    expect(calls).toEqual([]);
  });
});

describe("the account channels accept only what they need", () => {
  const accepts = (channel: keyof typeof CHANNELS, input: unknown): boolean =>
    CHANNELS[channel].input.safeParse(input).success;

  it("registration requires accepting the terms, literally", () => {
    const base = { name: "L", email: "l@example.com", password: "a long enough password" };
    expect(accepts("account:register", { ...base, acceptTerms: true })).toBe(true);
    expect(accepts("account:register", { ...base, acceptTerms: false })).toBe(false);
    expect(accepts("account:register", base)).toBe(false);
  });

  it("a reset code is six digits and nothing else", () => {
    const base = { email: "l@example.com", newPassword: "a long enough password" };
    expect(accepts("account:resetPassword", { ...base, code: "012345" })).toBe(true);
    for (const code of ["12345", "1234567", "12345a", " 123456"]) {
      expect(accepts("account:resetPassword", { ...base, code }), code).toBe(false);
    }
  });

  it("no account channel takes a terms version, a token or a URL from the renderer", () => {
    const names = Object.keys(CHANNELS).filter((name) => name.startsWith("account:")) as (keyof typeof CHANNELS)[];
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const shape = (CHANNELS[name].input as { shape?: Record<string, unknown> }).shape ?? {};
      for (const forbidden of ["termsVersion", "terms_version", "token", "url", "apiUrl"]) {
        expect(Object.keys(shape), `${name} accepts ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
