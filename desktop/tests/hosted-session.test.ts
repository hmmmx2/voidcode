/**
 * The VoidCode session, from the desktop's side: where it may be stored, who may write it, when it
 * is sent, and what main is willing to open in a browser.
 *
 * Until this file nothing tested `inference/hosted.ts` or the hosted provider's credential path,
 * and four defects sat there unnoticed:
 *
 *   - a signed-out app probed `GET {api}/models` on every availability check, because the session
 *     was attached as extra headers instead of as the provider's auth-token getter;
 *   - the renderer could overwrite the session through `vault:set`, having only been prevented
 *     from reading it;
 *   - sign-in on a machine with no credential store threw into a masked error and left a live
 *     session on the server that no device held;
 *   - the checkout URL check let any scheme through when the host was 127.0.0.1.
 *
 * Each `describe` below pins one of them, and each was confirmed to fail against the old code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { __useInMemory } = await import("../src/main/store/db.js");
const { __safeStorage } = await import("./stubs/electron.js");
const { secretValue, setSecret, clearSecret, __resetSessionSecrets } = await import(
  "../src/main/inference/vault.js"
);
const password = await import("../src/main/account/password.js");
const { __setOverridesAllowed } = await import("../src/main/platform/config.js");
const { __resetSessionMemory } = await import("../src/main/account/session.js");
const { providerById } = await import("../src/main/inference/registry.js");
const { checkedExternalUrl } = await import("../src/main/net/external.js");
const { CHANNELS } = await import("../src/main/ipc/contract.js");

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
}

let calls: Call[] = [];

/** A fetch that records every request and answers from a table, so a test can count network use. */
function stubFetch(respond: (url: string, method: string) => { status: number; body?: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const method = init.method ?? "GET";
      calls.push({ url: String(input), method, authorization: headers.authorization });
      const { status, body } = respond(String(input), method);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );
}

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
  calls = [];
  delete process.env.VOIDCODE_DEV_SESSION_TOKEN;
  // A configured, acceptable API address, so that in every test below the SESSION is the only thing
  // standing between the app and a request. Without this, "no request" would pass because there is
  // no address at all — true, and not the property being tested.
  __setOverridesAllowed(true);
  process.env.VOIDCODE_API_URL = "http://127.0.0.1:59999/v1";
  __resetSessionMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setOverridesAllowed(undefined);
  delete process.env.VOIDCODE_API_URL;
});

describe("signed out means no network", () => {
  it("the hosted provider is unavailable without asking the server", async () => {
    stubFetch(() => ({ status: 200, body: { data: [] } }));

    const available = await providerById("hosted")!.available();

    expect(available).toBe(false);
    // THE assertion. With the session passed as extra headers this was 1: a GET to /models from
    // an app nobody had signed into.
    expect(calls).toHaveLength(0);
  });

  it("with a session, the probe carries it as a bearer token", async () => {
    setSecret("voidcode", "session-token-abc");
    stubFetch(() => ({ status: 200, body: { data: [] } }));

    await providerById("hosted")!.available();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer session-token-abc");
  });

  it("a dev session token is not honoured when the build cannot be shown to be unpackaged", async () => {
    // Under the unit-test Electron stub `app` does not exist, which must read as "packaged": the
    // override is the thing that may never apply by accident.
    __setOverridesAllowed(false);
    process.env.VOIDCODE_DEV_SESSION_TOKEN = "dev-token";
    stubFetch(() => ({ status: 200, body: { data: [] } }));

    expect(await providerById("hosted")!.available()).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("the renderer cannot write the session", () => {
  const keyOf = (channel: "vault:set" | "vault:has" | "vault:clear", key: string): boolean => {
    const input =
      channel === "vault:set" ? { key, value: "attacker-session" } : { key };
    return CHANNELS[channel].input.safeParse(input).success;
  };

  it.each(["vault:set", "vault:has", "vault:clear"] as const)(
    "%s refuses the voidcode key",
    (channel) => {
      // Reading was never exposed; writing was, and writing is how a session gets swapped.
      expect(keyOf(channel, "voidcode")).toBe(false);
    },
  );

  it.each(["vault:set", "vault:has", "vault:clear"] as const)(
    "%s still accepts the key the user pastes in",
    (channel) => {
      expect(keyOf(channel, "openrouter")).toBe(true);
    },
  );
});

describe("sign-in on a machine with no credential store", () => {
  const OK = {
    status: 200,
    body: { token: "server-issued-token", expires_at: "2027-01-01T00:00:00", user: { id: "u", email: "a@b.c", name: "A" } },
  };

  it("says why, stores nothing, and revokes the session the server already issued", async () => {
    __safeStorage.available = false;
    stubFetch((url, method) => (method === "POST" ? OK : { status: 200, body: { message: "Signed out." } }));

    const result = await password.signInPassword("a@b.c", "correct horse battery");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/credential|keyring|keychain|store/i);
    expect(secretValue("voidcode")).toBeUndefined();

    // The orphan is revoked with its OWN header — it was never stored, so the vault had nothing.
    const revoke = calls.find((c) => c.method === "DELETE");
    expect(revoke, "the issued session was left live on the server").toBeDefined();
    expect(revoke!.url).toMatch(/\/auth\/desktop\/session$/);
    expect(revoke!.authorization).toBe("Bearer server-issued-token");
  });

  it("a healthy machine still keeps the session", async () => {
    stubFetch(() => OK);

    const result = await password.signInPassword("a@b.c", "correct horse battery");

    expect(result.ok).toBe(true);
    expect(secretValue("voidcode")).toBe("server-issued-token");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    clearSecret("voidcode");
  });
});

describe("what main will open in the browser", () => {
  const dev = { allowLoopbackHttp: true };
  const shipped = { allowLoopbackHttp: false };

  it("opens an https page", () => {
    expect(checkedExternalUrl("https://checkout.stripe.com/c/pay/cs_test", shipped)?.hostname).toBe(
      "checkout.stripe.com",
    );
  });

  it.each([
    ["a file on the loopback host", "file://127.0.0.1/C:/Windows/System32/calc.exe"],
    ["a network share", "smb://127.0.0.1/share"],
    ["a custom application scheme", "vscode://file/etc/passwd"],
    ["plain http off-machine", "http://checkout.example.com/pay"],
    ["https with embedded credentials", "https://user:pass@checkout.stripe.com/pay"],
    ["garbage", "not a url"],
  ])("refuses %s", (_why, raw) => {
    // The first case is the one the old check let through: host 127.0.0.1, so no https required.
    expect(checkedExternalUrl(raw, dev)).toBeNull();
  });

  it("allows plain-http loopback only in a development build", () => {
    expect(checkedExternalUrl("http://127.0.0.1:8020/credits", dev)).not.toBeNull();
    expect(checkedExternalUrl("http://127.0.0.1:8020/credits", shipped)).toBeNull();
  });
});
