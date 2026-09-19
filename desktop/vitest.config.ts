import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // PostCSS discovery is stopped by `desktop/postcss.config.cjs` — see the comment
  // in that file for why it has to exist at all.
  root: __dirname,
  resolve: {
    alias: {
      // The main-process modules import `electron` at runtime (ipcMain, dialog).
      // Under vitest there is no Electron runtime, so it resolves to a stub. The
      // gate logic under test does not depend on Electron behaviour — it depends
      // on the mode registry and the contract — which is exactly why `dispatch`
      // is exported separately from `installBroker`.
      electron: path.resolve(__dirname, "tests/stubs/electron.ts"),
      // See tests/stubs/sqlite.ts: real SQLite, reached via createRequire because the
      // system Node running vitest does not list it as a builtin. Production imports
      // `node:sqlite` directly.
      "node:sqlite": path.resolve(__dirname, "tests/stubs/sqlite.ts"),
      // The same alias `renderer/tsconfig.json` declares. A few renderer modules are pure
      // logic worth testing here rather than standing up a second test runner for them —
      // the keybinding parser most of all, since every bug in it is a shortcut that
      // silently does nothing.
      "@shared": path.resolve(__dirname, "src/shared"),
      /**
       * The renderer's own alias, so a component can be rendered here.
       *
       * `markdown.test.ts` renders `Markdown` with `react-dom/server` and asserts the payload
       * comes out escaped. That is the only assertion that covers what React actually emits —
       * the parser tests prove the tree holds no markup, but "React escapes text nodes" is the
       * other half of the claim, and it deserves to be checked rather than assumed.
       *
       * `renderer/node_modules` is on the path because the renderer keeps its own install;
       * `@monaco-editor/react` lives there, not at this root.
       */
      "@": path.resolve(__dirname, "renderer/src"),
      /**
       * One React, not two.
       *
       * There are two installs — `renderer/node_modules/react` and this root's — and a component
       * rendered here reaches both: the component imports `react` while the renderer that draws it
       * comes from whichever copy the *rendering library* resolved. Two copies means two hook
       * dispatchers, and every render dies on `Cannot read properties of null (reading 'useState')`,
       * which reads exactly like a broken component and is not.
       *
       * THE RENDERER'S COPY IS THE ANSWER, and everything that renders has to be reachable from
       * it. `@monaco-editor/react` and `@testing-library/react` both live in `renderer/node_modules`
       * and both reach `react`/`react-dom/client` through CJS `require`, which no alias intercepts
       * — so their natural resolution has to be the right one, and these lines make every *other*
       * importer agree with it. Pointing them at this root instead was tried and fails the other
       * way round: Testing Library then renders with one copy while `@monaco-editor/react` hooks
       * into the other.
       *
       * A test-runner concern only: the real renderer bundle has exactly one React by construction.
       */
      react: path.resolve(__dirname, "renderer/node_modules/react"),
      "react-dom": path.resolve(__dirname, "renderer/node_modules/react-dom"),
      /** Same reason as `@monaco-editor/react` below — see that note. */
      "@testing-library/react": path.resolve(
        __dirname,
        "renderer/node_modules/@testing-library/react"
      ),
      "@testing-library/user-event": path.resolve(
        __dirname,
        "renderer/node_modules/@testing-library/user-event"
      ),
      /**
       * Same reason, one package further out.
       *
       * The note above says `@monaco-editor/react` "lives there, not at this root", and that is
       * why a *component* can reach it: the `@` alias lands the importer inside `renderer/src`,
       * and resolution walks up from there. A test file in `tests/` walks up to this root
       * instead and finds nothing, so `monaco-loader.test.ts` — which needs the loader
       * singleton itself, not a component that happens to use it — cannot resolve it without
       * this line.
       *
       * The singleton matters: `loader` carries the module-level `isInitialized` flag that the
       * defect it guards is built on, so the test and `lib/monaco-local.ts` must be holding the
       * same copy.
       */
      "@monaco-editor/react": path.resolve(
        __dirname,
        "renderer/node_modules/@monaco-editor/react"
      ),
    },
  },
  test: {
    environment: "node",
    /**
     * `.tsx` too, for the component tests under `tests/ui/`.
     *
     * Those files opt into a DOM with a per-file `// @vitest-environment jsdom` docblock rather
     * than flipping `environment` here. That setting is load-bearing for the other 140 files: they
     * read sources off disk, drive real `node:sqlite` through a stub, and use real `Buffer`s in the
     * Electron stub's `safeStorage`. A global jsdom would be a large change for one directory.
     */
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    server: {
      deps: {
        // Resolve renderer-only packages (@monaco-editor/react) from the renderer install.
        fallbackCJS: true,
        /**
         * Testing Library has to go through Vite, or the React aliases above do not reach it.
         *
         * Externalised, it is loaded by Node directly and picks up `desktop/node_modules/react-dom`
         * (19.2.8) while the component under test gets the aliased `renderer/node_modules/react`
         * (19.2.3). Two copies means two hook dispatchers, and the render fails with
         * `Cannot read properties of null (reading 'useId')` — which reads like a bug in the
         * component and is not. Inlining puts it on the same copy as everything else.
         */
        inline: [/@testing-library\//],
      },
    },
  },
});
