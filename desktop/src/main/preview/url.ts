/**
 * Finding the address a dev server just printed.
 *
 * There is no protocol for this. A dev server announces itself in prose, on stdout, in whatever
 * shape its authors liked — so the only way to know where Vite landed after it found 5173 busy
 * and took 5174 is to read what it said. Passing `--port` instead would work for the servers we
 * hard-coded and break for every project whose dev script is its own, which is most of them.
 *
 * **Only loopback is ever returned, and that is the security-relevant line in this file.**
 * Vite prints two addresses when `--host` is on:
 *
 *     ➜  Local:   http://localhost:5173/
 *     ➜  Network: http://192.168.1.14:5173/
 *
 * They are the same server, but they are not the same trust decision. Taking the second would
 * point the preview at a LAN address — one that can be answered by anything on the network that
 * wins a race, and one that leaves the machine. The preview exists to show the user their own
 * project on their own machine; a non-loopback host is never that, and is refused rather than
 * rewritten, because a host we did not expect is not a host we can vouch for.
 *
 * `0.0.0.0` and `::` are the exception, and only because they are not addresses at all: they are
 * a server saying "every interface". Reaching such a server over loopback is exactly right, so
 * they normalise to `127.0.0.1` rather than being refused.
 */

/**
 * Colour codes, stripped before anything else looks at the line.
 *
 * Every dev server in common use colours this output, and the escape sequence lands *inside* the
 * URL — Vite emits the address in cyan, so the raw bytes are
 * `http://localhost:\x1b[1m5173\x1b[22m/`. A matcher run over that finds a port of nothing.
 * This is the single most likely reason a parser like this silently never matches.
 */
// eslint-disable-next-line no-control-regex -- the point of this expression is control characters
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** `localhost`, any `127.x.x.x`, and IPv6 loopback. */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  // The whole 127/8 block, not just 127.0.0.1 — some tooling binds 127.0.0.2 to isolate ports.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** "Every interface", which is a bind target rather than an address to dial. */
function isWildcard(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "0.0.0.0" || bare === "::" || bare === "[::]";
}

/**
 * The address in this line, or nothing.
 *
 * Total, and called on every line of output — most lines are not announcements, and "no" is the
 * overwhelmingly common answer rather than a failure.
 */
export function parseDevServerUrl(line: string): string | null {
  const clean = line.replace(ANSI, "");

  /**
   * Every URL on the line is considered, not just the first.
   *
   * Some servers print `Local: http://localhost:5173/` and `Network: http://…` on ONE line, and
   * some print a docs link before the address. Taking the first match would pick whichever the
   * author happened to put first; taking the first *loopback* match is the property actually
   * wanted, and it does not depend on their ordering.
   */
  for (const match of clean.matchAll(/https?:\/\/(\[[0-9a-fA-F:]+\]|[^\s/:]+):(\d{2,5})\b/g)) {
    const host = match[1];
    const port = match[2];
    if (host === undefined || port === undefined) continue;
    if (!isValidPort(port)) continue;
    if (isLoopback(host) || isWildcard(host)) return `http://127.0.0.1:${port}`;
  }

  /**
   * The prose form, for servers that print no URL at all.
   *
   * `python -m http.server` says "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)" on
   * newer versions but only the first half on older ones, and plenty of hand-rolled scripts say
   * "listening on port 3000". Requiring the word `port` immediately before the number keeps this
   * from matching a version string or a byte count.
   */
  const prose = /\bport\s+(\d{2,5})\b/i.exec(clean);
  const prosePort = prose?.[1];
  if (prosePort !== undefined && isValidPort(prosePort)) return `http://127.0.0.1:${prosePort}`;

  return null;
}

/**
 * A port a dev server could actually be on.
 *
 * The lower bound is not pedantry. Two digits is the shortest thing worth matching, and without
 * an upper bound `65536` and above parse happily and then fail to connect with an error that
 * says nothing about why.
 */
function isValidPort(text: string): boolean {
  const port = Number(text);
  return Number.isInteger(port) && port >= 10 && port <= 65_535;
}
