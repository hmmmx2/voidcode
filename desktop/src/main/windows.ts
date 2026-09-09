/**
 * Window factory. The only place a window — and therefore a mode — is created.
 *
 * Everything security-relevant about a renderer is decided here and cannot be
 * changed afterwards: its mode, which channels its preload will expose, and the
 * navigation and popup policy it runs under.
 */
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { assignMode, type WindowMode, MODE_ARGV_PREFIX } from "./modes.js";
import { channelsForMode } from "./ipc/contract.js";
import { randomUUID } from "node:crypto";
import { APP_ORIGIN, PACKAGED_ICON } from "./protocol.js";
import { rememberWindow, forgetWindow } from "./store/session.js";
import { currentProjectRoot } from "./workspace.js";

export interface CreateWindowOptions {
  mode: WindowMode;
  /** Renderer route to open, e.g. `/study/papers`. Must be app-relative. */
  route?: string;
  /**
   * The session row this window continues. A fresh uuid for a new window; the stored id when
   * restoring, so the window reclaims its own arrangement rather than starting a second row.
   */
  sessionId?: string;
  /** Restored geometry, already clamped to a display the user can reach. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/**
 * The renderer is untrusted (spec §2.1). These five flags are what make that
 * statement true rather than aspirational:
 *
 *   contextIsolation  preload and page get separate JS contexts, so the page
 *                     cannot reach into the preload's scope for `ipcRenderer`
 *   nodeIntegration   no `require` in the page
 *   sandbox           OS-level sandbox on the renderer process
 *   webSecurity       same-origin policy stays on
 *   webviewTag        off — a page cannot spawn an embedder it controls
 *
 * `sandbox: true` is why the preload cannot import zod (see preload/index.ts);
 * that constraint is a consequence of this line and is worth the trade.
 */
function securePreferences(
  mode: WindowMode,
  preloadPath: string
): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    // How the preload learns what it may expose. Set before the renderer starts;
    // the renderer has no API to alter its own argv, so it cannot widen this.
    additionalArguments: [
      `${MODE_ARGV_PREFIX}${mode}`,
      `--voidcode-channels=${channelsForMode(mode).join(",")}`,
    ],
  };
}

/**
 * Frameless chrome, so the app draws its own title bar.
 *
 * **Windows/Linux draw their own controls now.** This used to set `titleBarOverlay`, which has
 * the OS paint minimise/maximise/close over our bar in colours we nominate. That was the right
 * trade while the bar was the only custom thing here — the overlay brings snap layouts, correct
 * hit targets and high-contrast themes for free.
 *
 * It is dropped because the overlay is a *system* surface and does not follow the app's theme
 * beyond two colour hints: no hover states we control, no radius, no alignment with the rest of
 * the strip. Against a dark IDE it reads as borrowed. `WindowControls.tsx` replaces it and takes
 * on what the overlay was giving us — see that file for what had to be reproduced.
 *
 * `titleBarStyle: "hidden"` WITHOUT the overlay is the combination that yields no OS controls
 * while keeping a real window frame, so Aero Snap, edge-drag resizing and Win+Arrow all still
 * work. `frame: false` would have removed those too and required reimplementing them.
 *
 * **macOS keeps its traffic lights.** `hiddenInset` leaves them where every Mac user expects,
 * and overriding them is the classic Electron-app tell in the other direction — it breaks
 * muscle memory and the accessibility affordances attached to them. The renderer already
 * indents to clear them.
 *
 * `-webkit-app-region: drag` on the bar is what makes the window movable at all. Every
 * interactive child needs `no-drag`, or the user's click lands on a drag surface and the
 * window slides instead of the menu opening.
 */
/**
 * The icon file, packaged or not.
 *
 * Same shape as `onReady`'s renderer-root resolution in `index.ts`, and for the same reason: the
 * packaged layout is a `process.resourcesPath` join against a name `extraResources` also writes down,
 * and the development layout is relative to the source tree.
 */
function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, PACKAGED_ICON)
    : path.join(__dirname, "..", "..", "build", "icon.png");
}

function framelessChrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 11 } };
  }

  return { titleBarStyle: "hidden" };
}

/**
 * Which session row a live window belongs to.
 *
 * Keyed by `WebContents.id` for the same reason `modes.ts` and `workspace.ts` are: ids are
 * monotonic within a session and never reused, so a late event from a dead window resolves to
 * nothing rather than to whoever occupies that slot next.
 */
const sessionIdByWebContents = new Map<number, string>();

/** The session row for a window, so handlers can save its workspace against the right one. */
export function sessionIdFor(sender: Electron.WebContents): string | undefined {
  return sessionIdByWebContents.get(sender.id);
}

/**
 * Long enough that dragging a window is one write rather than sixty per second, short enough
 * that a crash mid-drag loses only the last fraction of a move.
 */
const BOUNDS_DEBOUNCE_MS = 400;

/**
 * Record where a window is, from the window itself.
 *
 * Never from the renderer. A channel that accepted a rectangle would let a compromised page
 * lie about its own geometry, and there is nothing to gain by allowing it — main already
 * knows, and knows accurately.
 */
function trackBounds(window: BrowserWindow, sessionId: string, mode: WindowMode): void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const record = (): void => {
    if (window.isDestroyed()) return;
    // `getNormalBounds`, not `getBounds`: while maximised the latter reports the screen, so
    // un-maximising a restored window would leave it full-screen-sized forever.
    rememberWindow({
      id: sessionId,
      mode,
      projectRoot: currentProjectRoot(window.webContents) ?? null,
      route: routeOf(window),
      bounds: window.getNormalBounds(),
      maximised: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(record, BOUNDS_DEBOUNCE_MS);
    timer.unref?.();
  };

  /**
   * Tell the renderer whether it is maximised, so its own control can draw the right glyph.
   *
   * A push rather than something the renderer polls, because main is the only thing that knows:
   * Win+Up, edge snapping and a double-click on the drag region all maximise the window without
   * going anywhere near our button. A renderer tracking its own state would be wrong within
   * seconds of the user touching the OS.
   */
  const pushWindowState = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("window:state", { maximized: window.isMaximized() });
  };

  // Listed individually rather than looped: Electron's overloads are per event name, so a
  // loop over a union has no single signature to match and TypeScript rejects it.
  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("maximize", pushWindowState);
  window.on("unmaximize", pushWindowState);
  // And once the page exists, so a window restored maximised does not draw the wrong glyph
  // until the user happens to toggle it. React attaches its listener in an effect that runs
  // after load, so this fires after `did-finish-load` rather than with it.
  window.webContents.on("did-finish-load", pushWindowState);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);

  // Also whenever the page changes, so the route is current without the renderer telling us.
  window.webContents.on("did-navigate-in-page", schedule);
  window.webContents.on("did-navigate", schedule);

  // Once at startup, so a window that is never moved is still remembered.
  record();

  window.once("closed", () => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The app-relative route a window is showing, for restore. */
function routeOf(window: BrowserWindow): string {
  try {
    const url = new URL(window.webContents.getURL());
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return "/";
  }
}

export function createWindow(options: CreateWindowOptions): BrowserWindow {
  // Both modes open at `/`. The IDE is a route inside the app now, not a separate window —
  // filesystem access is gated by the folder-picker consent and by which tools a
  // conversation has, neither of which needs a window of its own. A `study` window still
  // cannot reach `fs:*` at all; it simply has no "Code" destination to navigate to.
  const { mode, route = "/", sessionId = randomUUID(), bounds } = options;

  // `__dirname` is the built main directory; the preload sits beside it.
  const preloadPath = path.join(__dirname, "../preload/index.js");

  const window = new BrowserWindow({
    // Restored geometry when there is some, otherwise the defaults. `clampToDisplays` has
    // already guaranteed whatever arrives here is somewhere the user can reach.
    ...(bounds !== undefined ? bounds : {}),
    width: bounds?.width ?? (mode === "build" ? 1440 : 1280),
    height: bounds?.height ?? 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0e",
    /**
     * The window icon, which is the same `#0b0b0e` as the line above — the icon and the window it
     * opens are deliberately the same colour, so they read as one product rather than two.
     *
     * Honest about its reach: Windows takes the taskbar icon from the one electron-builder embeds in
     * the executable, and macOS reads the bundle's `.icns`. Neither consults this. It is what the
     * packaged Linux window uses, and what development uses, where there is no bundle at all.
     */
    icon: iconPath(),
    // One product, one title. The mode is a deployment property, not something the user is
    // meant to be tracking in their window list.
    title: mode === "build" ? "VoidCode" : "VoidCode — Study",
    ...framelessChrome(),
    webPreferences: securePreferences(mode, preloadPath),
  });

  // Register the mode before any renderer code can run. If this throws we must
  // not end up with a live window holding no mode — the broker would deny every
  // request, which is safe, but a half-built window is still a bug worth
  // surfacing immediately.
  try {
    assignMode(window.webContents, mode);
  } catch (err) {
    window.destroy();
    throw err;
  }

  // THE ID IS CAPTURED BEFORE THE LISTENER, NOT READ INSIDE IT. Once a window is destroyed,
  // `window.webContents` throws "Object has been destroyed" — and an uncaught throw in main
  // is a modal error dialog, not a logged warning. This is the shape every `destroyed`
  // handler in the app has to take.
  const webContentsId = window.webContents.id;
  sessionIdByWebContents.set(webContentsId, sessionId);
  window.webContents.once("destroyed", () => {
    sessionIdByWebContents.delete(webContentsId);
  });

  hardenNavigation(window);
  guardUnsavedWork(window);
  trackBounds(window, sessionId, mode);

  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}${route}`);

  return window;
}

/**
 * Windows that have been cleared to close, so the second `close` is not intercepted again.
 *
 * A `WeakSet` rather than a flag on the window: nothing has to be cleaned up, and a destroyed
 * window drops out on its own.
 */
const cleared = new WeakSet<Electron.WebContents>();

/**
 * Whether the app is on its way out.
 *
 * Set by the quit path before it asks windows to close. Without it, quitting would run every
 * window through `allowClose` and mark all of them un-restorable — so the next launch would
 * open nothing, which is the exact opposite of what quitting with three projects open should
 * mean. An object so the flag can be flipped from `quit.ts` without a circular import.
 */
export const quittingRef = { value: false };

/** Called by `window:allowClose` once the renderer has dealt with unsaved work. */
export function allowClose(sender: Electron.WebContents): void {
  cleared.add(sender);
  // The user closed THIS window deliberately, so it stays closed on next launch. A quit or a
  // crash never reaches here, which is exactly what makes those cases restore everything.
  const sessionId = sessionIdByWebContents.get(sender.id);
  if (sessionId !== undefined && !quittingRef.value) forgetWindow(sessionId);
  BrowserWindow.fromWebContents(sender)?.close();
}

/**
 * Give the renderer a chance to save before the window goes.
 *
 * SHIPS WITH SAVE, NOT AFTER IT. Before saving existed, nothing persisted and everyone knew
 * it. Adding save without this would change the failure mode to "usually persists, silently
 * does not when you close the window" — worse in kind, because it is the one a user trusts
 * and then loses work to.
 *
 * THE TIMEOUT IS THE PART THAT IS EASY TO OMIT AND EXPENSIVE TO GET WRONG. If the renderer
 * has hung, crashed, or simply has no handler for the intent, `preventDefault` alone makes
 * the window unclosable and the app unquittable — the user's only recourse is the task
 * manager. Three seconds is long enough for a save round trip and short enough that a broken
 * renderer costs a pause rather than a reboot.
 */
/**
 * How long a renderer gets to answer a close before it goes anyway.
 *
 * Exported so the quit path uses the same number rather than a second one that drifts. Long
 * enough for a save round trip, short enough that a broken renderer costs a pause rather than
 * a reboot.
 */
export const CLOSE_GRACE_MS = 3_000;

function guardUnsavedWork(window: BrowserWindow): void {
  window.on("close", (event) => {
    const sender = window.webContents;
    if (cleared.has(sender) || sender.isDestroyed()) return;

    event.preventDefault();
    cleared.add(sender);

    // Marked as cleared *before* asking, so a renderer that answers instantly does not race
    // this handler and get intercepted twice.
    sender.send("shell:command", { command: "window.confirmClose" });
    setTimeout(() => {
      if (!window.isDestroyed()) window.close();
    }, CLOSE_GRACE_MS);
  });
}

/**
 * Pin the renderer to its own origin and send everything else to the real browser.
 *
 * Without this, one injected link in rendered paper content or a model response
 * could navigate the privileged renderer to an arbitrary page — which would then
 * be running with our preload attached. That is the whole attack, and these two
 * handlers are the whole fix.
 */
function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Never open a second privileged window. External links go to the user's
    // browser, where they are ordinary untrusted web content.
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  // Belt and braces: a page that somehow attaches a webview gets no preload and
  // no node, regardless of what attributes it set.
  window.webContents.on("will-attach-webview", (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    event.preventDefault();
  });
}
