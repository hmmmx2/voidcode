/**
 * Showing the dev server, without letting it into the app.
 *
 * **A `WebContentsView`, not an iframe, and that is the security decision in this feature.**
 * The cheap version is one line — widen `frame-src` in the CSP to `http://127.0.0.1:*` and put
 * an iframe in the right pane. It is also the wrong version: an iframe lives inside the app's
 * own document, so the page it loads is one `frame-src`-shaped hole away from the privileged
 * renderer, and every future bug in that boundary is a bug in the app rather than in a sandbox.
 * A `WebContentsView` is a separate web contents with its own process and its own session; the
 * page cannot see the app's DOM, its storage, or its preload, because it is not in them.
 *
 * The content here is not trustworthy merely because it is local. It is whatever the user's
 * project serves — including whatever an agent just wrote into it, and whatever an npm
 * dependency injected. "It came from localhost" is a statement about the network path, not
 * about the code.
 *
 * ## What this view is denied
 *
 * **No preload.** `window.host` is the entire IPC surface; a preview that had it could read the
 * project, write files, and start processes. Nothing is passed, so there is nothing to reach.
 *
 * **Its own session partition.** Separate cookies, storage and cache from `app://bundle`. A
 * page that could write the app's storage could tamper with the workspace document the app
 * restores from on the next launch.
 *
 * **Pinned navigation.** It may move within its own dev-server origin — that is what clicking a
 * link in your own app does — and nowhere else. `app://` is refused outright rather than opened
 * externally, because nothing should ever ask for it and a request that does is not a mistake.
 *
 * **No new windows.** `window.open` and `target="_blank"` are denied; an https link goes to the
 * real browser, where it is ordinary untrusted content.
 */
import { WebContentsView, BrowserWindow, shell } from "electron";

/** Where the pane is, in the window's own coordinates. */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Attached {
  view: WebContentsView;
  /** The origin it is pinned to, so navigation can be checked against it. */
  origin: string;
  visible: boolean;
}

/** One preview view per window. */
const views = new WeakMap<BrowserWindow, Attached>();

/**
 * Show the preview at `url`, creating the view if needed.
 *
 * Reuses an existing view for the same origin rather than rebuilding it: the pane is shown and
 * hidden every time someone switches tabs, and a rebuild would reload the page — losing scroll
 * position, form state, and whatever the user was actually looking at.
 */
export function showPreview(window: BrowserWindow, url: string, bounds: PreviewBounds): void {
  const origin = originOf(url);
  if (origin === null) return;

  let attached = views.get(window);

  if (attached !== undefined && attached.origin !== origin) {
    // A different server — the user restarted and it landed on another port. The old contents
    // are pointed at something that is no longer there, so this one is genuinely replaced.
    destroy(window, attached);
    attached = undefined;
  }

  if (attached === undefined) {
    const view = new WebContentsView({
      webPreferences: {
        // Everything here is a denial. See the header for what each one is denying.
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        // Its own jar. `partition` without `persist:` is in-memory and dies with the view,
        // which is right for a preview: it is not somewhere anyone should be signing in.
        partition: "voidcode-preview",
      },
    });
    harden(view, origin);
    attached = { view, origin, visible: false };
    views.set(window, attached);
    void view.webContents.loadURL(url);
  }

  // Destructured with defaults: `getContentSize` is typed as a plain `number[]`, so under
  // `noUncheckedIndexedAccess` both elements are possibly-undefined. Zero is the safe reading —
  // it clamps everything to nothing rather than letting an undefined widen the rectangle.
  const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
  attached.view.setBounds(clampBounds({ width: contentWidth, height: contentHeight }, bounds));

  if (!attached.visible) {
    window.contentView.addChildView(attached.view);
    attached.visible = true;
  }
}

/**
 * Take it off screen without tearing it down.
 *
 * `removeChildView` detaches from the view tree and leaves the web contents alive, so switching
 * to the Plan tab and back returns to the same page in the same place. Destroying instead would
 * make every tab switch a reload — and on a dev server, a reload that re-runs the app's startup.
 */
export function hidePreview(window: BrowserWindow): void {
  const attached = views.get(window);
  if (attached === undefined || !attached.visible) return;
  window.contentView.removeChildView(attached.view);
  attached.visible = false;
}

/** Tear it down for good — the preview stopped, or the project closed. */
export function destroyPreview(window: BrowserWindow): void {
  const attached = views.get(window);
  if (attached === undefined) return;
  destroy(window, attached);
}

function destroy(window: BrowserWindow, attached: Attached): void {
  if (attached.visible) window.contentView.removeChildView(attached.view);
  // `close()` rather than leaving it to GC: this holds a renderer process, and a preview the
  // user stopped should not still be running their project's JavaScript.
  attached.view.webContents.close();
  views.delete(window);
}

/**
 * Keep it inside the window.
 *
 * The bounds come from the renderer measuring its own pane, which is fine — a rectangle is not
 * a capability. This clamps anyway, because the one thing a wrong rectangle could do is cover
 * the app's chrome with content from the project, and a preview drawn over the title bar is
 * indistinguishable from the app's own UI to the person looking at it.
 */
export function clampBounds(
  content: { width: number; height: number },
  bounds: PreviewBounds
): PreviewBounds {
  const { width, height } = content;
  const x = Math.max(0, Math.min(Math.round(bounds.x), width));
  const y = Math.max(0, Math.min(Math.round(bounds.y), height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width), width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height), height - y)),
  };
}

/** The origin, or nothing if this is not a URL we would ever load. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Belt and braces with `url.ts`, which already filtered to loopback. This is the last place
    // before a page is actually loaded, and the cost of checking twice is one comparison.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function harden(view: WebContentsView, origin: string): void {
  const { webContents } = view;

  webContents.setWindowOpenHandler(({ url }) => {
    // Never a second window. An https link goes to the real browser, where it is ordinary
    // untrusted content rather than something rendered inside the app's frame.
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    if (mayNavigateTo(origin, url)) return;
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });

  // A preview must never attach a webview, whatever attributes it sets.
  webContents.on("will-attach-webview", (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    event.preventDefault();
  });

  // Permission requests from a page the user did not choose to visit. A dev server has no
  // business asking for the camera, and a prompt attributed to VoidCode would be worse than
  // the refusal.
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
}

/**
 * May the preview go here?
 *
 * Within its own origin is normal — that is what clicking a link in your own app does. Anything
 * else is not, and `app://` least of all: nothing in a dev server has any business asking for
 * the app's own origin, so a request for it is refused rather than opened elsewhere.
 *
 * **Compared with the trailing slash, which is the whole subtlety.** A bare `startsWith(origin)`
 * would accept `http://127.0.0.1:30000` for an origin of `http://127.0.0.1:3000` — a different
 * port, and on a developer machine quite possibly a different person's service. It would also
 * accept `http://127.0.0.1:3000.evil.com`, which is not loopback at all.
 */
export function mayNavigateTo(origin: string, url: string): boolean {
  return url === origin || url.startsWith(`${origin}/`);
}
