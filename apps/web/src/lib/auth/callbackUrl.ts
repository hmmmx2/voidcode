/**
 * Sanitise a post-sign-in destination read from the URL.
 *
 * `?callbackUrl=` is attacker-controlled by definition — it is a query
 * parameter, so anyone can put anything in it and send the link to someone
 * else. Both auth forms end with `router.push(callbackUrl)`, and Next's router
 * will happily navigate to an absolute URL, so an unchecked value turns the
 * sign-in page into an open redirect: the victim signs in on the real site,
 * then lands on an attacker's page that is one hop from a genuine login. That
 * is the classic phishing setup, and the fact that the first page really was
 * ours is what makes it work.
 *
 * Only a same-origin, path-absolute URL is accepted. Everything else falls back
 * to the dashboard rather than throwing — a malformed link should sign you in
 * and put you somewhere sensible, not show you an error.
 *
 * Rejected, each for its own reason:
 *   `https://evil.com/x`  — absolute, different origin
 *   `//evil.com/x`        — protocol-relative; a browser reads this as absolute
 *   `/\evil.com`          — backslash, which several parsers normalise to `/`
 *   `javascript:…`        — scheme, not a path
 *   `homepage`            — relative, resolves against whatever page it is on
 */
const FALLBACK = "/homepage";

/** True if any character would be stripped by a browser before URL parsing. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw) return FALLBACK;

  // Must be path-absolute. A second leading `/` or `\` makes it authority
  // relative, which leaves the origin.
  if (!raw.startsWith("/")) return FALLBACK;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return FALLBACK;

  // Control characters are stripped by browsers before parsing, so `/\tevil`
  // and `/\nevil` can smuggle past a naive prefix check.
  if (hasControlChar(raw)) return FALLBACK;

  // Final confirmation through the URL parser itself, against a throwaway base:
  // if resolving the value moves it off that base's origin, it was never a
  // plain path.
  try {
    const base = "https://callback.invalid";
    const resolved = new URL(raw, base);
    if (resolved.origin !== base) return FALLBACK;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return FALLBACK;
  }
}
