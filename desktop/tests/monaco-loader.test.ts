/**
 * Monaco is loaded from the bundle, and it is configured early enough for that to matter.
 *
 * THE DEFECT THIS FILE WAS WRITTEN FOR. `@monaco-editor/loader` ships a default
 * `paths.vs` of `https://cdn.jsdelivr.net/npm/monaco-editor@<v>/min/vs`, and its `init()`
 * injects `<script src="{paths.vs}/loader.js">` into the document. `lib/monaco-local.ts`
 * overrides that path to the copy `scripts/copy-monaco.mjs` puts in the export — but it used
 * to be called from `MonacoWrapper` only, which mounts on the Study route and nowhere else.
 *
 * `markdown/CodeBlock.tsx` calls `useMonaco()` for every fenced code block, and `useMonaco()`
 * runs `init()`. So on `/build` — the standalone IDE, where the assistant streams code — the
 * first fence asked for Monaco with the CDN path still in place. The CSP in `main/index.ts`
 * names no remote origin, so the script was blocked, nothing threw, `useMonaco()` stayed
 * `undefined`, and every code block rendered as plain text. Silently, and permanently:
 *
 * WHY PERMANENTLY, which is what makes placement rather than presence the fix. `init()` sets
 * `isInitialized: true` before it does anything else
 * (`@monaco-editor/loader/lib/cjs/loader/index.js:58-60`) and returns early ever after. The
 * first caller decides where Monaco comes from for the life of the page, and a `config()` that
 * arrives afterwards is ignored. Configuring from `MonacoWrapper` worked on the Study route
 * only because `WorkspaceClient` happens to render `ProblemTabs` before `CodeColumn`, and this
 * ran during render while `init()` ran in an effect. Nothing guarded that ordering.
 *
 * ONE `init()` PER PROCESS, WHICH SHAPES THIS FILE. That one-shot flag lives in the package,
 * and `vi.resetModules()` does not reach it — externalised dependencies are cached outside the
 * module registry Vitest resets. So there is exactly one `init()` available here, and the first
 * test below spends it on the whole story: configure, init, then try to reconfigure and init
 * again. Every other test asserts something reachable without it. Splitting that first test in
 * two would make the second half pass vacuously, which is worse than one test doing two things.
 *
 * WHY THE PLACEMENT TEST IS A SOURCE SCAN. The property is module-evaluation ORDER: the
 * configuration has to run while the root client component's module is evaluated, which is
 * strictly before any component effect can call `useMonaco()`. No unit test can observe that —
 * importing the module in a test *is* evaluating it. What can be asserted is that the call sits
 * at module scope in the root component, which is the thing a refactor would quietly move into
 * a `useEffect` and break.
 *
 * `tests/markdown-render.test.ts` covers the other side: a fence still renders as readable text
 * when Monaco is unavailable. That fallback is legitimate and stays — it is what made this
 * defect invisible, not what caused it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RENDERER = path.resolve(__dirname, "..", "renderer", "src");

type Injected = { src?: string; onload?: () => void; onerror?: () => void };

/** Everything `@monaco-editor/loader` touches on the globals, and nothing else. */
function installFakeDom(): Injected[] {
  const injected: Injected[] = [];
  Object.assign(globalThis, {
    window: { location: { origin: "app://bundle" } },
    document: {
      createElement: (): Injected => ({}),
      body: {
        appendChild: (node: Injected): Injected => {
          injected.push(node);
          return node;
        },
      },
    },
  });
  return injected;
}

function clearFakeDom(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
}

/**
 * A fresh `monaco-local`, whose `configured` flag is module-level on purpose.
 *
 * Only our own module resets. The loader package does not — see the header.
 */
async function freshLocal() {
  vi.resetModules();
  return import("@/lib/monaco-local");
}

/**
 * Read back what `configureMonacoLoader` installed.
 *
 * Through `unknown` and by key, not as `window.MonacoEnvironment`: `monaco-editor`'s global
 * types declare that property as its own `Environment`, whose `getWorkerUrl` takes two
 * arguments, so a direct cast to the zero-argument shape this file installs is a type error
 * rather than a convenience.
 */
const monacoEnvironment = (): { getWorkerUrl(): string } | undefined => {
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  return win?.["MonacoEnvironment"] as { getWorkerUrl(): string } | undefined;
};

beforeEach(clearFakeDom);
afterEach(clearFakeDom);

describe("where Monaco is loaded from", () => {
  it("loads from the bundle, and a later config cannot move it", async () => {
    const injected = installFakeDom();
    const local = await freshLocal();
    const { loader } = await import("@monaco-editor/react");

    local.configureMonacoLoader();
    loader.init();

    expect(injected).toHaveLength(1);
    expect(injected[0]?.src).toBe("app://bundle/vs/loader.js");
    /**
     * Named explicitly rather than left implied by the path above: this is the string the CSP
     * blocks, and a reader arriving here after a regression needs to see the failure mode.
     */
    expect(injected[0]?.src, "Monaco is being fetched from a CDN the CSP blocks").not.toContain(
      "cdn.jsdelivr.net"
    );
    /**
     * Absolute against the scheme root, not the page. `new URL("vs", document.baseURI)` gives
     * `app://bundle/problems/1/vs` on a problem page; that 404 was once answered with
     * `index.html` by the protocol handler's blanket fallback, so Monaco parsed HTML as
     * JavaScript and hydration died on `Unexpected token '<'`. One leading slash prevents it.
     */
    expect(injected[0]?.src).not.toContain("/problems/");

    /**
     * The second half, and the reason `Providers.tsx` rather than a component owns the call:
     * once something has asked, the path is settled. This is a characterisation test of the
     * dependency — if a future version lets `config()` take effect after `init()`, this fails
     * and the placement constraint can be relaxed deliberately rather than discovered.
     */
    loader.config({ paths: { vs: "app://bundle/somewhere-else" } });
    loader.init();

    expect(injected, "a second init injected another script").toHaveLength(1);
    expect(injected[0]?.src).toBe("app://bundle/vs/loader.js");
  });

  it("points the worker at a real file rather than a blob", async () => {
    /**
     * `worker-src` allows `blob:` but `script-src 'self'` blocks the inner `importScripts`, so
     * Monaco's default blob shim cannot start a worker here. The bare `workerMain.js` carries
     * its own `'../../../'` baseUrl fallback, which is what lets the TypeScript, JSON, CSS and
     * HTML language workers resolve from it — the reason those languages get diagnostics and
     * Python does not.
     */
    installFakeDom();
    const local = await freshLocal();

    local.configureMonacoLoader();

    expect(monacoEnvironment()?.getWorkerUrl()).toBe(
      "app://bundle/vs/base/worker/workerMain.js"
    );
    expect(monacoEnvironment()?.getWorkerUrl()).not.toContain("blob:");
  });

  it("does nothing before there is a window, and still configures once there is", async () => {
    // The static export evaluates this module in Node during the prerender pass.
    const duringPrerender = await freshLocal();
    expect(() => duringPrerender.configureMonacoLoader()).not.toThrow();
    expect(monacoEnvironment()).toBeUndefined();

    installFakeDom();
    const inTheBrowser = await freshLocal();
    inTheBrowser.configureMonacoLoader();

    expect(monacoEnvironment()?.getWorkerUrl()).toContain("app://bundle/vs");
  });

  it("is idempotent, so the old call site can stay as belt and braces", async () => {
    /**
     * `MonacoWrapper` still calls `useLocalMonaco()`. That call is now a no-op and is kept
     * deliberately — the same belt-and-braces reasoning `Providers.tsx` gives for its
     * side-effect import of `@/lib/api/client`. Asserted by identity: a second configuration
     * would build a new `MonacoEnvironment` object.
     */
    installFakeDom();
    const local = await freshLocal();

    local.configureMonacoLoader();
    const first = monacoEnvironment();
    local.useLocalMonaco();
    local.configureMonacoLoader();

    expect(first).toBeDefined();
    expect(monacoEnvironment()).toBe(first);
  });
});

describe("when it is configured", () => {
  /** Comments stripped: this file discusses the call it is asserting, at length. */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is called at module scope in the root client component", () => {
    const source = withoutComments(
      readFileSync(path.join(RENDERER, "components", "Providers.tsx"), "utf8")
    );

    expect(source, "Providers.tsx does not import the loader configuration").toContain(
      "configureMonacoLoader"
    );

    /**
     * At module scope, not inside the component or an effect — asserted by position: the call
     * has to appear before the component that would otherwise contain it. An effect would lose
     * the very race it exists to win, because `CodeBlock`'s `useMonaco()` is also an effect and
     * effects in children run before their parents'.
     */
    const call = source.indexOf("configureMonacoLoader()");
    const component = source.indexOf("export default function Providers");
    expect(call, "the configuration call is gone from Providers.tsx").toBeGreaterThan(-1);
    expect(component).toBeGreaterThan(-1);
    expect(
      call < component,
      "configureMonacoLoader() is inside the component or an effect; it has to run during " +
        "module evaluation, before any child effect can ask for Monaco"
    ).toBe(true);
  });

  it("is reached on every route, because the root layout renders it", () => {
    const layout = readFileSync(path.join(RENDERER, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("Providers");
  });

  it("names the mechanism that actually reports Python problems", () => {
    /**
     * The comment this replaces pointed the reader at a language server for Build Mode's
     * IntelliSense, citing a spec section. No such thing exists: no `lsp:` channel in
     * `contract.ts`, no implementation in `src/main`, and the smoke asserts `host.lsp` is
     * absent on purpose. A comment describing an unbuilt subsystem sends the next reader
     * looking for it.
     *
     * ASSERTED POSITIVELY, AND THAT IS THE POINT RATHER THAN A STYLE CHOICE. The first version
     * of this test banned the spec-section string — and failed, on the sentence in
     * `monaco-local.ts` explaining that the spec section was the wrong answer. A file that
     * documents its own trap always contains the string a text scan forbids, which this
     * repository has now been bitten by more than once. So: the *fact* is checked against the
     * contract, and the *comment* is checked for naming the true mechanism.
     */
    const local = readFileSync(path.join(RENDERER, "lib", "monaco-local.ts"), "utf8");
    expect(
      local,
      "monaco-local.ts no longer names lint:run, so nothing tells the reader where Python " +
        "diagnostics come from"
    ).toContain("lint:run");

    const contract = readFileSync(
      path.resolve(__dirname, "..", "src", "main", "ipc", "contract.ts"),
      "utf8"
    );
    expect(
      /"lsp:[A-Za-z]+":/.test(contract),
      "a language-server channel exists now, so monaco-local.ts should describe it again and " +
        "this test should be rewritten rather than loosened"
    ).toBe(false);
  });
});
