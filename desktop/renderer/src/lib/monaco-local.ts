/**
 * Make Monaco load from disk instead of a CDN.
 *
 * `@monaco-editor/react` fetches `monaco-editor` from jsDelivr at runtime through its
 * `loader` module. On the web that is invisible; in a packaged desktop app served from
 * `app://` it means the editor sits on "Loading editor…" forever the first time someone
 * opens it offline — which is exactly when they are least able to work out why.
 *
 * `monaco-editor` is a real dependency of this package, and the `vs/` directory is copied
 * into the export at build time (see `scripts/copy-monaco.mjs`), so this points the loader
 * at the copy that is already installed.
 *
 * Called once, from `MonacoWrapper`, before the editor mounts.
 */
import { loader } from "@monaco-editor/react";

let configured = false;

export function useLocalMonaco(): void {
  if (configured || typeof window === "undefined") return;
  configured = true;

  /**
   * Absolute against the scheme root, not relative to the page.
   *
   * `new URL("vs", document.baseURI)` resolves to `app://bundle/problems/1/vs` on a
   * problem page, which does not exist. That 404 was then answered with `index.html` by
   * the protocol handler's old blanket fallback, so Monaco parsed HTML as JavaScript and
   * the whole page's hydration died on `Unexpected token '<'`.
   */
  const vs = new URL("/vs", window.location.origin).href;

  loader.config({ paths: { vs } });

  /**
   * Monaco spawns a worker per language service. Its default resolution builds a
   * `blob:` URL from an importScripts shim, which the CSP in `main/index.ts` refuses —
   * `worker-src` allows `blob:` but `script-src 'self'` blocks the inner import.
   *
   * Pointing at the real worker file avoids the blob entirely. `editor.worker.js` covers
   * the basics; Python has no dedicated web worker in Monaco (its language support is
   * tokenisation only), so this is sufficient for the Study workspace. Build Mode's
   * IntelliSense comes from LSP over `MessagePort` instead (spec §2.10), not from these.
   */
  (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorkerUrl(): string {
      return `${vs}/base/worker/workerMain.js`;
    },
  };
}
