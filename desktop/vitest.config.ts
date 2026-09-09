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
       * There are two installs — `renderer/node_modules/react` at 19.2.3 and this root's at
       * 19.2.8 — and `@monaco-editor/react` resolves the renderer's while `react-dom/server`
       * resolves the root's. Two copies means two hook dispatchers, and the second component to
       * call `useState` gets `null`. Pinning both to the renderer's copy is what makes a
       * component renderable here at all; it is a test-runner concern only, since the real
       * renderer bundle has exactly one React by construction.
       */
      react: path.resolve(__dirname, "renderer/node_modules/react"),
      "react-dom": path.resolve(__dirname, "renderer/node_modules/react-dom"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Resolve renderer-only packages (@monaco-editor/react) from the renderer install.
        fallbackCJS: true,
      },
    },
  },
});
