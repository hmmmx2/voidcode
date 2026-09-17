/**
 * The entire privileged surface exposed to the renderer.
 *
 * Two properties this file exists to guarantee:
 *
 *   1. A Study window is never handed a Build-only namespace. `host.fs` is
 *      literally `undefined` there — not a function that throws. Honest renderer
 *      code cannot call the wrong thing by accident, and feature-detection
 *      (`if (host.fs)`) is the natural way to write mode-aware UI.
 *
 *   2. The renderer never gets `ipcRenderer`. It gets a fixed set of named
 *      functions closing over it. There is no channel-name parameter anywhere in
 *      the exposed API, so the renderer cannot reach a channel we did not choose
 *      to expose, even by constructing a string.
 *
 * The allowed channel list arrives via `additionalArguments`, set by main at
 * window creation. It is not importable from here: this preload runs sandboxed,
 * and `contract.ts` pulls in zod, which has no business inside a sandbox. Main
 * derives the list from that same contract, so there is still exactly one source
 * of truth for the privilege table.
 *
 * argv cannot be forged by the renderer — it is fixed by main before the
 * renderer process starts, and the renderer has no API to alter its own argv.
 */
import { contextBridge, ipcRenderer } from "electron";
import { cleanError } from "./errors.js";

const MODE_PREFIX = "--voidcode-mode=";
const CHANNELS_PREFIX = "--voidcode-channels=";

function argvValue(prefix: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

const mode = argvValue(MODE_PREFIX);
const channels = (argvValue(CHANNELS_PREFIX) ?? "").split(",").filter(Boolean);

if (mode !== "study" && mode !== "build") {
  // Fail closed. A window with no declared mode gets no bridge at all rather
  // than a default one — guessing "probably study" here would mean a bug in the
  // window factory silently produces a window with ambient privilege.
  throw new Error(`Preload: missing or invalid ${MODE_PREFIX} argument`);
}

/**
 * Streaming channels return a `MessagePort` rather than a value.
 *
 * Spec §2.3: token-by-token over `ipcRenderer.send` serialises every chunk
 * through the broker and stalls main under load. These use the port transfer
 * instead, so tokens flow renderer<->child directly and the port dies with the
 * window.
 */
const PORT_CHANNELS = new Set(["chat:open", "agent:open", "pty:spawn"]);

type Fn = (arg?: unknown) => Promise<unknown>;

function invoker(channel: string): Fn {
  if (PORT_CHANNELS.has(channel)) {
    return (arg?: unknown) =>
      new Promise((resolve, reject) => {
        // Main replies on this channel with the port attached to the event.
        const replyChannel = `${channel}:port`;
        const onPort = (event: Electron.IpcRendererEvent) => {
          const port = event.ports[0];
          if (port === undefined) {
            reject(new Error(`${channel}: main did not transfer a port`));
            return;
          }

          /**
           * The port stays in the preload. **A `MessagePort` cannot cross `contextBridge`** —
           * it is proxied into an object with none of its methods, so the renderer received
           * something that looked like a port until the first `.start()` and then threw
           * `start is not a function`. Streaming had never worked, in either the tutor or the
           * Build assistant.
           *
           * Functions do cross the bridge, so the port is kept here and an interface over it
           * is handed out instead. `close()` still reaches the real port, which is what
           * aborts generation — main ties the model's `AbortSignal` to the port's lifetime.
           */
          resolve({
            onChunk(callback: (chunk: unknown) => void): void {
              port.onmessage = (message: MessageEvent) => callback(message.data);
              // Assigning `onmessage` implicitly starts the port, but only for that
              // assignment form. Explicit here so a later switch to `addEventListener`
              // does not silently deliver nothing.
              port.start();
            },
            /**
             * Renderer to main, over the same port.
             *
             * This wrapper was receive-only, because `chat:open` is: tokens flow out and
             * nothing flows back. A terminal is the first bidirectional consumer — keystrokes
             * and resizes have to reach the pty — so the port needed a way in as well as out.
             *
             * Main validates everything arriving here. This is renderer input that ends up at
             * `child.write()`, so "it came over our own port" is not a reason to trust it.
             */
            send(message: unknown): void {
              port.postMessage(message);
            },
            close(): void {
              port.close();
            },
          });
        };
        ipcRenderer.once(replyChannel, onPort);
        ipcRenderer.invoke(channel, arg).catch((err: unknown) => {
          ipcRenderer.removeListener(replyChannel, onPort);
          reject(cleanError(err));
        });
      });
  }
  return (arg?: unknown) => ipcRenderer.invoke(channel, arg).catch((err: unknown) => {
    // Here rather than in each panel: there are dozens of call sites and one transport, and a
    // fix applied per-panel is one that the next panel forgets.
    throw cleanError(err);
  });
}

/**
 * Build `host` from the flat channel list.
 *
 * `"fs:read"` becomes `host.fs.read`. Generated rather than hand-written so that
 * adding a channel to the contract needs no edit here — and, more importantly,
 * so this file cannot drift out of sync with the privilege table and expose
 * something the broker would refuse (or worse, keep exposing something the
 * contract has since restricted).
 */
const host: Record<string, Record<string, Fn>> = {};

for (const channel of channels) {
  const [namespace, method] = channel.split(":");
  if (namespace === undefined || method === undefined) continue;
  (host[namespace] ??= {})[method] = invoker(channel);
}

/**
 * Subscriptions are separate from invocations: they are main -> renderer pushes,
 * so they are wired explicitly rather than generated, and each one is filtered to
 * the events that mode is allowed to observe.
 */
const subscriptions = {
  /**
   * Live hardware load — CPU, RAM, GPU utilisation and VRAM in use.
   *
   * This subscription existed before and was deleted, because `hw:telemetry` had no sender and
   * a listener for an event that cannot arrive is a claim the API does not keep. It is back
   * because `startTelemetry` in main now emits it, roughly once a second.
   *
   * Both modes: the status bar carries the widget on every surface, and a Study window is
   * exactly where someone checks whether there is room for a model before switching.
   */
  onHardwareTelemetry(cb: (sample: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("hw:telemetry", listener);
    return () => ipcRenderer.removeListener("hw:telemetry", listener);
  },
  /**
   * Download progress for `models:pull`.
   *
   * The handler has been calling `ctx.sender.send("models:pullProgress", …)` all along with
   * nothing on this side listening, so a pull ran to completion in silence. This is the other
   * half.
   *
   * ALWAYS-ON, NOT BUILD-ONLY. `models:pull` is `modes: BOTH`, so gating this would leave a
   * Study window able to start a multi-gigabyte download it could never report on — a bug
   * that only appears in one of the two window kinds, which is the worst place to put one.
   *
   */
  onModelPullProgress(cb: (progress: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("models:pullProgress", listener);
    return () => ipcRenderer.removeListener("models:pullProgress", listener);
  },
  /**
   * The preview's state, as its dev server starts, becomes ready, or dies.
   *
   * A push rather than a poll because the interesting part takes a long time and arrives in
   * steps: a cold `next dev` compiles for a minute before it listens, and the log is worth
   * showing while it does. Polling would either miss the log or hammer main for it.
   *
   * NOT gated here, and it does not need to be. The Build-only gate is on the channels in
   * `ipc/contract.ts`; a Study window cannot start a preview, so nothing will ever send it one
   * — and a listener for an event that never arrives grants nothing.
   */
  onPreviewChanged(cb: (state: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("preview:changed", listener);
    return () => ipcRenderer.removeListener("preview:changed", listener);
  },
  /**
   * Menu and accelerator intents from main.
   *
   * The window is frameless and the menus are native, but almost every item is really a
   * renderer intention — toggle a panel, go to a destination, run the file. Main delivers
   * the intent and the shell decides what it means; main does not model the UI.
   *
   * Available in both modes: a menu item that a mode cannot service is simply not built
   * into that mode's menu, and the channels those items eventually call are gated as usual.
   */
  onShellCommand(cb: (payload: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("shell:command", listener);
    return () => ipcRenderer.removeListener("shell:command", listener);
  },
  /**
   * A notification, the moment it is raised.
   *
   * This is what `GET /v1/notifications/stream` becomes on the desktop. The web held an SSE
   * connection open through Redis pub/sub so an event on one node reached a client on
   * another; here main and the renderer are the only two parties, and the seam turns these
   * pushes back into the SSE frames the bell already parses.
   *
   * Both modes: a notification says what happened to the user's own work and grants nothing.
   */
  onNotification(cb: (payload: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("notifications:new", listener);
    return () => ipcRenderer.removeListener("notifications:new", listener);
  },
  /**
   * The VoidCode account changed: signed in, signed out, a session that ended on the server, or
   * fresh details for the person signed in.
   *
   * A push because the change often does not come from this window. Signing in from the Models
   * page in one window has to update the title bar in another, and a session revoked from another
   * computer is discovered by whichever request happens to hit it — possibly a chat in a window the
   * account menu is not in.
   *
   * Both modes, and it carries no credential: whether someone is signed in, and their name and
   * address, which the window was going to show anyway.
   */
  onAccountChanged(cb: (payload: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("account:changed", listener);
    return () => ipcRenderer.removeListener("account:changed", listener);
  },
  /**
   * Whether this window is maximised, so the renderer's own control draws the right glyph.
   *
   * **Outside the Build block on purpose.** Every window in the app is frameless, so a Study
   * window draws its own controls too and needs this exactly as much.
   *
   * A push rather than something the renderer asks for: the OS maximises windows without going
   * near our button — Win+Up, edge snapping, a double-click on the drag region — so a renderer
   * tracking its own state would be wrong the moment the user touches the window manager.
   */
  onWindowState(cb: (state: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  ...(mode === "build"
    ? {
        /**
         * Progress while the project index builds.
         *
         * Build only, like everything that names a file: the payload counts files inside a
         * folder the user granted.
         */
        onMemoryProgress(cb: (p: unknown) => void): () => void {
          const listener = (_e: unknown, payload: unknown) => cb(payload);
          ipcRenderer.on("memory:progress", listener);
          return () => ipcRenderer.removeListener("memory:progress", listener);
        },
        onFileChanged(cb: (p: unknown) => void): () => void {
          const listener = (_e: unknown, payload: unknown) => cb(payload);
          ipcRenderer.on("fs:changed", listener);
          return () => ipcRenderer.removeListener("fs:changed", listener);
        },
      }
    : {}),
};

contextBridge.exposeInMainWorld("host", {
  // Named `windowMode`, not `mode`, because the generated namespaces above already
  // claim `host.mode` for the `mode:get` channel — spreading `...host` over a
  // `mode` key would silently replace this string with `{ get }`.
  //
  // Static, so the renderer can branch without a round trip. The authoritative
  // copy lives in main's registry; this is a convenience, not a credential, and
  // nothing security-relevant may key off it.
  windowMode: mode,
  ...host,
  ...subscriptions,
});
