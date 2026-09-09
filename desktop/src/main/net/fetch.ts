/**
 * Fetching a page, safely.
 *
 * THE PINNED LOOKUP IS THE POINT OF THIS FILE. Resolving a hostname, checking the addresses,
 * and then handing the *name* back to an HTTP client is a control that controls nothing: the
 * client resolves it again, and whoever owns the name can answer differently the second time.
 * That is DNS rebinding, it is trivial to set up, and it is the piece that gets left out.
 *
 * So this resolves once, vets every address, and then connects to a specific address — the
 * `lookup` option below returns the vetted one rather than asking DNS again.
 *
 * `node:https` rather than `fetch`, for exactly that reason: `fetch` has no way to pin a
 * connection to an address. undici's `Agent` does, but undici is present here only as a
 * transitive dependency and depending on another package's dependency is its own kind of rot.
 *
 * Nothing in the renderer can reach this. There is no channel; the CSP still says
 * `connect-src 'self' http://127.0.0.1:*`. It exists for main-side tools, and the first of
 * those is the agent.
 */
import https from "node:https";
import dns from "node:dns/promises";
import { checkUrl, isPrivateAddress, FetchRefused } from "./allowlist.js";
import { extractText } from "./html-text.js";

/** Long enough for a slow docs site, short enough that a hung request is not a hung agent. */
const TIMEOUT_MS = 15_000;

/**
 * Enforced by counting bytes off the stream.
 *
 * `Content-Length` is a claim, not a limit — a server can omit it, understate it, or stream
 * forever with `Transfer-Encoding: chunked`. The header is used as an early exit; the counter
 * is what actually stops it.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** Following a chain is fine; being led round one is not. */
const MAX_REDIRECTS = 3;

/** Documents, not downloads. Anything else is not something a model should be reading. */
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xhtml+xml",
];

export interface FetchedPage {
  /** What was asked for. */
  url: string;
  /** Where it ended up, which may differ after redirects. */
  finalUrl: string;
  title: string | null;
  text: string;
  /** The byte cap stopped it early, so the text is a prefix rather than the page. */
  truncated: boolean;
}

/** Injectable, so the tests can drive every branch without a network or a DNS server. */
export interface FetchDeps {
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: typeof https.request;
}

const realDeps: FetchDeps = {
  resolve: (hostname) => dns.lookup(hostname, { all: true }),
  request: https.request,
};

/**
 * Resolve, and refuse unless *every* address is public.
 *
 * Every, not the first. A name can resolve to a public address and a private one, and a client
 * that checks `addresses[0]` and connects to whichever the OS prefers has checked nothing. The
 * address that survives is the one the connection is then pinned to.
 */
async function vetAddress(hostname: string, deps: FetchDeps): Promise<string> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await deps.resolve(hostname);
  } catch {
    throw new FetchRefused("host-not-allowed", `${hostname} could not be resolved`);
  }

  if (addresses.length === 0) {
    throw new FetchRefused("host-not-allowed", `${hostname} resolved to nothing`);
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchRefused(
        "private-address",
        `${hostname} resolves to a private address (${address})`
      );
    }
  }

  return addresses[0]!.address;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  truncated: boolean;
}

/** One request, to a pinned address, with the byte cap enforced as the body arrives. */
function requestOnce(url: URL, address: string, deps: FetchDeps): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = deps.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // THE PIN. Every address this connection could use is the one already vetted, so a
        // second DNS answer cannot redirect it — which is what makes the check above mean
        // something.
        lookup: (_hostname, _options, callback) => {
          // `4` here is the address *family*, not a version claim about `address`: Node accepts
          // a v6 literal with family 6, and `net.isIP` decided which we have.
          callback(null, address, address.includes(":") ? 6 : 4);
        },
        // SNI and certificate validation still use the real hostname, so pinning the address
        // does not weaken TLS — the certificate must still be valid for the name.
        servername: url.hostname,
        headers: {
          // Named honestly. A tool that disguises itself as a browser is one a site cannot
          // rate-limit or block, which is not a decision this app gets to make for them.
          "user-agent": "VoidCode/0.1 (+local developer tool)",
          accept: ALLOWED_CONTENT_TYPES.join(", "),
          "accept-encoding": "identity",
        },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const type = String(response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
        // Checked before reading a byte: a 4 GB tarball should cost one header, not a stream.
        if (type !== "" && !ALLOWED_CONTENT_TYPES.includes(type) && response.statusCode !== 301 && response.statusCode !== 302) {
          response.destroy();
          reject(new FetchRefused("unsupported-content-type", `Refusing ${type}`));
          return;
        }

        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > MAX_BYTES) {
          response.destroy();
          reject(new FetchRefused("too-large", `${declared} bytes exceeds the ${MAX_BYTES} limit`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            // The counter, not the header. This is what stops a chunked response that claims
            // nothing and streams forever.
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const finish = (): void =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });

        response.on("end", finish);
        // `destroy()` above emits `close`, not `end` — without this the promise never settles
        // when the cap trips, and the agent waits on it forever.
        response.on("close", finish);
        response.on("error", reject);
      }
    );

    request.on("timeout", () => {
      request.destroy();
      reject(new FetchRefused("timeout", `No response within ${TIMEOUT_MS}ms`));
    });
    request.on("error", (err) => reject(err));
    request.end();
  });
}

/**
 * Fetch a page, following redirects under the same rules.
 *
 * `manual` redirects rather than `follow`, because following them in the client skips every
 * check on hops 2..n — and a redirect to `http://169.254.169.254/` from an allowed host is the
 * exact shape of the attack this whole file exists to stop.
 */
export async function fetchPage(
  rawUrl: string,
  deps: FetchDeps = realDeps
): Promise<FetchedPage> {
  const original = rawUrl;
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop, from scratch: scheme, credentials, allowlist, resolution, and the pin.
    const { url } = checkUrl(current);
    const address = await vetAddress(url.hostname, deps);
    const response = await requestOnce(url, address, deps);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      const next = Array.isArray(location) ? location[0] : location;
      if (next === undefined) {
        throw new FetchRefused("host-not-allowed", "Redirect with no destination");
      }
      // Resolved against the current URL, so a relative `Location` works — and then re-checked
      // from the top on the next pass.
      current = new URL(next, url).toString();
      continue;
    }

    if (response.status >= 400) {
      throw new FetchRefused("host-not-allowed", `${url.hostname} returned ${response.status}`);
    }

    const { title, text } = extractText(response.body);
    return {
      url: original,
      finalUrl: url.toString(),
      title,
      text,
      truncated: response.truncated,
    };
  }

  throw new FetchRefused("too-many-redirects", `More than ${MAX_REDIRECTS} redirects`);
}
