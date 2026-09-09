import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import path from "node:path";

/**
 * Only main and the preload are built here. The renderer is the real VoidCode app under
 * `renderer/`, built by Next as a static export and served over `app://` — see
 * `main/protocol.ts`.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // CommonJS output for main: `__dirname` is used to locate the preload and
      // the renderer bundle, and ESM would leave it undefined.
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "src/main/index.ts"),
          // The Tier A sandbox is a second entry, not a chunk of main: it is forked
          // as its own `utilityProcess`, so it needs a standalone file on disk.
          "exec-sandbox": path.resolve(__dirname, "src/main/exec/sandbox.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
      outDir: "out/main",
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "src/preload/index.ts"),
          // The approval window has its own bridge, deliberately tiny: it must not be able
          // to reach anything the project renderer's preload exposes.
          approval: path.resolve(__dirname, "src/preload/approval.ts"),
        },
        // Sandboxed preloads must be CommonJS — a sandboxed preload has no ESM
        // loader, so an `import` statement here fails at runtime with a bare
        // "Cannot use import statement outside a module".
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
      outDir: "out/preload",
    },
  },
});
