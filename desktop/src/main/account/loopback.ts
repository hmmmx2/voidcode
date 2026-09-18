/**
 * The one-shot loopback listener that receives an authorization code from the browser.
 *
 * WHY A LISTENER AT ALL. RFC 8252 gives a native application two ways to be handed a code: a custom
 * URI scheme, or a redirect to a loopback address. Loopback is the one used here because a custom
 * scheme is registered with the operating system and any other program can register the same one —
 * on a shared machine, a second application claiming `voidcode://` would receive the code. A
 * listener on an ephemeral port belongs to this process and nothing else can bind it.
 *
 * WHAT THIS FILE HAS TO GET RIGHT, AND WHY EACH RULE EXISTS
 *
 *   1. BOUND TO 127.0.0.1, NEVER 0.0.0.0. `listen(port)` with no host binds every interface, which
 *      would put a server that hands out authorization codes on the local network for as long as a
 *      sign-in is open. The address is asserted after binding rather than assumed from the argument.
 *
 *   2. THE `Host` HEADER MUST BE THE LOOPBACK ADDRESS WE PUBLISHED. A page on the public internet
 *      can point a script at `http://127.0.0.1:<port>/…`, and it can also resolve a domain it owns
 *      to 127.0.0.1 and have the browser send requests that look local (DNS rebinding). What it
 *      cannot do is make the browser send `Host: 127.0.0.1:<port>` for a page served from its own
 *      domain, so that header is the thing checked.
 *
 *   3. A WRONG `state` IS ANSWERED AND IGNORED, NOT FATAL. `state` is compared in constant time and
 *      a mismatch gets a 400 while the flow KEEPS WAITING. Treating it as a failure would let any
 *      page that can guess the port cancel somebody's sign-in — a denial of service handed out for
 *      free, and one that would look like the provider failing.
 *
 *   4. ONE ANSWER, THEN CLOSED. The first request that passes every check settles the flow; anything
 *      after it gets a 410 and nothing is re-delivered. Sockets are destroyed rather than left to
 *      `server.close()`, which waits for keep-alive connections the browser is in no hurry to drop
 *      — so "the port is gone" is observable immediately, which is what the test asserts.
 *
 * THE RESPONSE PAGE CARRIES THE CODE IN ITS OWN URL, which is why it has no subresources at all:
 * `default-src 'none'` and `Referrer-Policy: no-referrer` together mean nothing is fetched from that
 * page and no later navigation carries the query string anywhere. It is unstyled for the same
 * reason — a stylesheet, even an inline one, would need the policy relaxed for the sake of
 * appearance on a tab the reader is about to close.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";

/** The only path the listener answers. Must match the pattern the API accepts for `redirect_uri`. */
export const CALLBACK_PATH = "/oauth/callback";

export type CallbackOutcome =
  /** The provider sent an authorization code back. */
  | { outcome: "code"; code: string }
  /** The provider refused, usually because the person pressed Cancel on the consent screen. */
  | { outcome: "denied"; error: string; description: string | null }
  | { outcome: "timeout" }
  | { outcome: "cancelled" };

export interface Loopback {
  readonly port: number;
  /** Exactly the string sent as `redirect_uri` and later relayed to the API. */
  readonly redirectUri: string;
  /** Settles once. Never rejects — every way a sign-in can end is one of the outcomes above. */
  readonly result: Promise<CallbackOutcome>;
  /** Stop waiting. Idempotent, and safe to call after the flow has already settled. */
  cancel(): void;
  /** Requests answered and discarded: wrong path, wrong host, wrong state, or arriving too late. */
  refusedCount(): number;
}

const RETURN_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head>',
  "<body><h1>You can close this tab</h1>",
  "<p>VoidCode has what it needs. Go back to the application.</p>",
  "</body></html>",
  "",
].join("\n");

/** Same length or not, compared without leaking where the first difference is. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface LoopbackOptions {
  /** The value this flow put in the authorize URL. Anything else is not our redirect. */
  state: string;
  /** Default five minutes — long enough to create a provider account mid-flow. */
  timeoutMs?: number;
}

/**
 * Start listening. Rejects only if the port cannot be bound, which is a real failure to report.
 */
export async function openLoopback(options: LoopbackOptions): Promise<Loopback> {
  const sockets = new Set<Socket>();
  let refused = 0;
  let settle: ((outcome: CallbackOutcome) => void) | null = null;

  const result = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    // Rule 4: a browser keeps its connection alive, so `close()` alone would leave the port bound
    // for up to two minutes after a sign-in finished.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  const finish = (outcome: CallbackOutcome): void => {
    const done = settle;
    settle = null;
    done?.(outcome);
  };

  timer = setTimeout(() => {
    finish({ outcome: "timeout" });
    shutdown();
  }, options.timeoutMs ?? 5 * 60 * 1000);
  // A pending sign-in must not be a reason the process cannot quit.
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  /**
   * WHERE IT ACTUALLY BOUND, and every address below is derived from that rather than restated.
   *
   * The check and the derivation are two defences against the same mistake, on purpose. If the
   * `listen` host argument were dropped, this throws; if this check were ALSO removed, the redirect
   * URI becomes `http://0.0.0.0:<port>/oauth/callback`, which fails the API's own `redirect_uri`
   * pattern and the test that holds this module to it. A literal "127.0.0.1" here would have made
   * the second mutation invisible.
   */
  const address = server.address() as AddressInfo | null;
  if (address === null || address.address !== "127.0.0.1") {
    shutdown();
    throw new Error(
      `the sign-in listener bound ${String(address?.address)} instead of 127.0.0.1`
    );
  }
  const authority = `${address.address}:${String(address.port)}`;
  const { port } = address;
  const expectedHosts = new Set([authority]);
  const redirectUri = `http://${authority}${CALLBACK_PATH}`;

  server.on("request", (request, response) => {
    const send = (status: number, body: string, contentType = "text/plain; charset=utf-8"): void => {
      response.writeHead(status, {
        "content-type": contentType,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(body);
    };

    // Already answered, or given up on. A second delivery of the same code is either a reload of
    // the return page or something replaying it; neither gets a second answer.
    if (settle === null) {
      refused += 1;
      send(410, "This sign-in has already finished.");
      return;
    }

    if (request.method !== "GET") {
      refused += 1;
      send(405, "Only GET.");
      return;
    }

    // Rule 2. Checked before the URL is even parsed: a request from somewhere other than the
    // browser we sent has no business being interpreted.
    if (request.headers.host === undefined || !expectedHosts.has(request.headers.host)) {
      refused += 1;
      send(400, "Not for this address.");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${authority}`);
    if (url.pathname !== CALLBACK_PATH) {
      refused += 1;
      send(404, "Nothing here.");
      return;
    }

    // Rule 3 — answered, counted, and the flow stays open.
    const state = url.searchParams.get("state");
    if (state === null || !sameString(state, options.state)) {
      refused += 1;
      send(400, "That sign-in did not start here.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      // A real answer from the provider — refusing consent lands here — so the flow ends.
      send(200, RETURN_PAGE, "text/html; charset=utf-8");
      finish({
        outcome: "denied",
        error,
        description: url.searchParams.get("error_description"),
      });
      response.once("finish", shutdown);
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      refused += 1;
      send(400, "No code in that redirect.");
      return;
    }

    send(200, RETURN_PAGE, "text/html; charset=utf-8");
    finish({ outcome: "code", code });
    // Shut down only once the page has actually been written: destroying the socket first leaves
    // the browser showing a connection error on a sign-in that in fact succeeded.
    response.once("finish", shutdown);
  });

  return {
    port,
    redirectUri,
    result,
    cancel(): void {
      finish({ outcome: "cancelled" });
      shutdown();
    },
    refusedCount: () => refused,
  };
}
