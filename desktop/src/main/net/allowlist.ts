/**
 * Deciding whether a URL may be fetched at all.
 *
 * Every function here is pure, and that is deliberate: this is the part of the web-fetch tool
 * that has to be *exhaustively* tested, and a module that resolves DNS or opens sockets cannot
 * be. `fetch.ts` does the I/O and calls these.
 *
 * The threat is not "a bad web page". It is that an agent acting on a model's output can be
 * talked into naming a URL, and some URLs are not documents — they are the cloud metadata
 * endpoint, a router's admin panel, a service bound to localhost that assumes anything reaching
 * it is already trusted. Server-side request forgery is the whole risk, and an allowlist alone
 * does not close it, because DNS is controlled by whoever owns the name.
 */
import net from "node:net";

/**
 * Registrable domains the tool may reach.
 *
 * Documentation and package registries. Short on purpose: every entry is a place a model can
 * be persuaded to send a request, so the list should contain only sites where the *answer* is
 * worth the exposure. Adding one is a decision, which is why it is a literal here rather than
 * something configurable from the renderer.
 */
export const ALLOWED_DOMAINS: readonly string[] = [
  "developer.mozilla.org",
  "docs.python.org",
  "docs.rs",
  "pkg.go.dev",
  "pypi.org",
  "registry.npmjs.org",
  "npmjs.com",
  "crates.io",
  "github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "stackoverflow.com",
  "typescriptlang.org",
  "react.dev",
  "nodejs.org",
  "rust-lang.org",
  "python.org",
];

export type RejectionReason =
  | "not-https"
  | "credentials-in-url"
  | "host-not-allowed"
  | "private-address"
  | "too-many-redirects"
  | "unsupported-content-type"
  | "too-large"
  | "timeout";

export class FetchRefused extends Error {
  constructor(
    readonly reason: RejectionReason,
    detail: string
  ) {
    super(detail);
    this.name = "FetchRefused";
  }
}

/**
 * Whether a hostname is on the list.
 *
 * Exact match, or a subdomain — `docs.python.org` allows `docs.python.org` and
 * `x.docs.python.org`, and nothing else. The two failure modes this exists to prevent are both
 * strings that *contain* an allowed domain:
 *
 *   `mozilla.org.evil.com`    — the allowed name as a prefix of someone else's domain
 *   `evil-mozilla.org`        — the allowed name as a suffix of a different registration
 *
 * A `includes()` check passes the first; an `endsWith()` check passes the second. The dot is
 * what makes the boundary real.
 */
export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/**
 * Addresses a fetch must never reach.
 *
 * `169.254.169.254` is the one worth naming: the cloud metadata endpoint, which on an
 * unconfigured instance hands out credentials to anything that asks. It falls inside
 * link-local, so it is covered by the range rather than special-cased — but the range is here
 * *because* of it.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is checked explicitly. It is a real address that
 * reaches loopback and does not look like one to a naive string or family check, which is
 * exactly what makes it a bypass.
 */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 0) return true; // Not an address at all — refuse rather than guess.

  if (version === 4) return isPrivateIPv4(address);

  const lower = address.toLowerCase();

  /**
   * Every IPv4-mapped address is refused, public ones included.
   *
   * `::ffff:127.0.0.1` is an IPv4 address wearing an IPv6 hat: it reaches loopback and passes
   * a naive family or string check, which is what makes it a bypass. The obvious version
   * parses the embedded v4 and applies the v4 rules — but that branch only decides whether a
   * *public* mapped address is allowed, so removing it makes the check stricter and no
   * security test can tell. That was found by mutating it and watching nothing fail.
   *
   * An uncovered branch guarding a case `dns.lookup` does not produce in practice is worse
   * than not having it. Refusing the whole form is simpler, strictly safer, and testable.
   */
  if (lower.startsWith("::ffff:")) return true;

  if (lower === "::" || lower === "::1") return true;
  // fc00::/7 — unique local, the IPv6 equivalent of 10.0.0.0/8.
  if (/^f[cd]/.test(lower)) return true;
  // fe80::/10 — link-local.
  if (/^fe[89ab]/.test(lower)) return true;

  return false;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 — "this network", and a route to localhost on Linux.
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — a carrier's internal space
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a >= 224) return true; // multicast and reserved

  return false;
}

export interface CheckedUrl {
  url: URL;
  hostname: string;
}

/**
 * Everything that can be decided from the URL alone.
 *
 * Runs before any DNS or socket work, and runs *again* on every redirect hop — a check applied
 * only to the URL the caller supplied is not a check at all when the server can answer with a
 * `Location`.
 */
export function checkUrl(raw: string): CheckedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("host-not-allowed", `Not a URL: ${raw}`);
  }

  // https only. `file:` would read the disk, `data:` would let a model hand itself content and
  // call it a source, and plain http is trivially interceptable on any shared network.
  if (url.protocol !== "https:") {
    throw new FetchRefused("not-https", `Only https is allowed (got ${url.protocol})`);
  }

  // `https://docs.python.org@evil.com/` — the part before the `@` is a username, not a host,
  // and it is the oldest way to make a URL read as one site and reach another.
  if (url.username !== "" || url.password !== "") {
    throw new FetchRefused("credentials-in-url", "URLs with credentials are refused");
  }

  if (!isAllowedHost(url.hostname)) {
    throw new FetchRefused("host-not-allowed", `${url.hostname} is not an allowed source`);
  }

  return { url, hostname: url.hostname };
}
