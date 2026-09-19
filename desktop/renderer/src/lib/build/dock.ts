/**
 * Which tab the bottom dock is showing.
 *
 * Its own module, and pure, so the parser can be tested without mounting a workspace — the same
 * reason `editor-tabs.ts` and `assistant-view.ts` sit beside it.
 *
 * **The value arrives off a persisted document.** `host.session.load()` returns a string this
 * window wrote, but "this window wrote it" is not a guarantee about its contents: it survives
 * downgrades, hand-editing, and a future version that knows tabs this one does not. So the parser
 * is total — anything it does not recognise becomes the default rather than propagating.
 *
 * Membership is tested against an array rather than an object, deliberately. `"__proto__" in obj`
 * and `obj["toString"]` are both truthy for a plain object literal, so a lookup-table version of
 * this would accept `__proto__` as a valid tab name and then fail somewhere far away.
 */

/**
 * Every tab the dock can show.
 *
 * Terminal came first and Problems and Output arrived with the linter — adding them here was all
 * it took for a persisted value naming them to start being honoured, which is why the parser was
 * written against this list rather than against a literal union. Problems has since gone the
 * other way: it was fed by a lint run triggered on a successful save, and the workspace stopped
 * saving, so the tab had no producer left and `parseDockTab` now falls a stored "problems" back
 * to Terminal — which is exactly the case it was written to handle.
 *
 * Ports and Debug Console are deliberately absent. Nothing in the app owns a port — `protocol.ts`
 * documents that `app://` exists *because* loopback is reachable by every process, and
 * `net/allowlist.ts` blocks it as SSRF defence — so a Ports tab could only list what the user
 * started in a terminal one tab over, via three platform-specific parsers. Debug Console has no
 * debugger behind it; what it would have shown lives in Output's channels, which is what VS
 * Code's Output pane actually is.
 */
export const DOCK_TABS = ["terminal", "output"] as const;

export type DockTab = (typeof DOCK_TABS)[number];

export const DEFAULT_DOCK_TAB: DockTab = "terminal";

/**
 * A persisted value, narrowed to a tab this build actually has.
 *
 * A version that knows more tabs than this one will have written a name that is not in
 * `DOCK_TABS`, and falling back is the correct answer to that — not an error, just an older build
 * opening where it can.
 */
export function parseDockTab(value: unknown): DockTab {
  if (typeof value !== "string") return DEFAULT_DOCK_TAB;
  return (DOCK_TABS as readonly string[]).includes(value)
    ? (value as DockTab)
    : DEFAULT_DOCK_TAB;
}
