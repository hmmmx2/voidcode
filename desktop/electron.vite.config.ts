import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import path from "node:path";

/**
 * Only main and the preload are built here. The renderer is the real VoidCode app under
 * `renderer/`, built by Next as a static export and served over `app://` — see
 * `main/protocol.ts`.
 */
/**
 * What this build talks to, decided when the build is made. See `src/main/platform/config.ts`.
 *
 * Read from `VOIDCODE_BUILD_*` in the environment of whoever runs the build — CI passes them as
 * repository VARIABLES, not secrets, because every value here is public: an API address, a website,
 * and OAuth client ids, which identify the app to Google and Microsoft and grant nothing on their
 * own. No secret is ever baked into the installer; the Google client secret lives only in the API.
 */
const BUILD = {
  apiUrl: process.env.VOIDCODE_BUILD_API_URL ?? null,
  siteUrl: process.env.VOIDCODE_BUILD_SITE_URL ?? null,
  googleClientId: process.env.VOIDCODE_BUILD_GOOGLE_CLIENT_ID ?? null,
  microsoftClientId: process.env.VOIDCODE_BUILD_MICROSOFT_CLIENT_ID ?? null,
  allowOverride: process.env.VOIDCODE_BUILD_ALLOW_OVERRIDE === "1",
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __VOIDCODE_BUILD__: JSON.stringify(BUILD),
    },
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
