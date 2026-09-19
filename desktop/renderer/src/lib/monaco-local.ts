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
 * CALLED FROM THE APP ROOT, AND THAT PLACEMENT IS THE WHOLE POINT.
 *
 * This used to be called only from `MonacoWrapper`, which mounts on the Study route and
 * nowhere else. `markdown/CodeBlock.tsx` calls `useMonaco()` for every fenced code block,
 * and `useMonaco()` runs the loader's `init()` — so on any route without a Monaco editor,
 * `init()` ran with the package's own default `paths.vs`, which is
 * `https://cdn.jsdelivr.net/npm/monaco-editor@…/min/vs`. The CSP in `main/index.ts` names no
 * remote origin, so the injected `<script>` was blocked, nothing threw, and `useMonaco()`
 * resolved to `undefined` forever. Every code block in the Build assistant's transcript
 * rendered as plain text, and `markdown-render.test.ts`'s fallback assertion passed happily
 * on it.
 *
 * `init()` is also ONE-SHOT: it sets `isInitialized: true` before doing anything
 * (`@monaco-editor/loader/lib/cjs/loader/index.js:58-60`), so a later `config()` cannot
 * rescue a page that has already asked. Configuring on the Study route worked only because
 * `WorkspaceClient` happens to render `ProblemTabs` before `CodeColumn`, and this ran during
 * render while `init()` ran in an effect. Nothing guarded that ordering.
 *
 * So it is configured during module evaluation of the root client component, which is
 * strictly before any component effect can run. `MonacoWrapper` still calls it, which is now
 * a no-op — belt and braces, in the same spirit as `Providers.tsx`'s side-effect import of
 * `@/lib/api/client`.
 */
import { loader } from "@monaco-editor/react";

let configured = false;

/** Point the loader at the bundled copy. Idempotent; safe before `window` exists. */
export function configureMonacoLoader(): void {
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
   * Pointing at the real worker file avoids the blob entirely, and the bare `workerMain.js`
   * is enough for the rich language services too: it carries its own `'../../../'` baseUrl
   * fallback, so `vs/language/typescript/tsWorker` and the json/css/html workers resolve from
   * it without further configuration.
   *
   * WHAT THAT MEANS FOR DIAGNOSTICS, since the previous version of this comment said
   * something untrue. It sent the reader to a language server for Build Mode's IntelliSense,
   * citing a spec section. There is no language server: `contract.ts` declares no `lsp:`
   * channel, nothing in `src/main` implements one, and the smoke asserts `host.lsp` is
   * `undefined` as a deliberate claim. What is actually true:
   *
   *   - TypeScript, JavaScript, JSON, CSS/SCSS/LESS and HTML get live diagnostics, hovers and
   *     go-to-definition from Monaco's own bundled workers.
   *   - Python gets tokenisation only. Its diagnostics come from `lint:run` (ruff, over the
   *     file on disk), and provider-backed editor actions stay greyed out — which
   *     `lib/shell/editor-commands.ts` already documents from the other side.
   */
  (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorkerUrl(): string {
      return `${vs}/base/worker/workerMain.js`;
    },
  };
}

/**
 * The old name, kept so `MonacoWrapper` need not change and so a hook-shaped call site still
 * reads as one. It is not a hook and has never used hook state.
 */
export function useLocalMonaco(): void {
  configureMonacoLoader();
}
