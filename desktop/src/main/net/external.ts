/**
 * Deciding whether main may hand a URL to `shell.openExternal`.
 *
 * Pure for the same reason `allowlist.ts` is: this is a security boundary, so it has to be
 * exhaustively testable, and the caller that actually opens the browser cannot be.
 *
 * WHY IT EXISTS. `shell.openExternal` opens anything the OS will open — a `file://` path, a
 * `smb://` share, a custom scheme another installed application registered. The URLs that reach it
 * from here came from our own API (a Stripe checkout page, a paper's PDF), so the threat is not a
 * hostile renderer choosing a URL — the renderer never supplies one — but a compromised or
 * misconfigured upstream supplying a URL that launches something instead of showing a page.
 *
 * The checkout handler used to test `protocol !== "https:" && hostname !== "127.0.0.1"`, which
 * accepts EVERY scheme whose host happens to be 127.0.0.1 — `file://127.0.0.1/…` included — and
 * accepted plain-http loopback in a packaged build, where no local payment server exists.
 */

export interface ExternalUrlPolicy {
  /**
   * Allow `http://127.0.0.1` in addition to `https:`. Only for an unpackaged development build
   * pointed at a local API, where Stripe's test checkout may redirect through loopback.
   */
  allowLoopbackHttp: boolean;
}

/**
 * The parsed URL when it is safe to open in the user's browser, otherwise `null`.
 *
 * Refuses embedded credentials (`https://user:pass@host`): a link that logs the browser into
 * something is not a page to show, and it is the classic way to disguise a destination.
 */
export function checkedExternalUrl(raw: string, policy: ExternalUrlPolicy): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url;
  if (policy.allowLoopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1") {
    return url;
  }
  return null;
}
