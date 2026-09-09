import type { NextConfig } from "next";

/**
 * Desktop build of the VoidCode renderer.
 *
 * The same source as the web app, exported to static files and served over the `app://`
 * protocol from Electron's main process. That is not a preference: a local HTTP server
 * would be reachable by every other process on the machine, which is why spec §2.1 rules
 * one out.
 */
const nextConfig: NextConfig = {
  output: "export",

  // Directory-style URLs, so `app://bundle/problems/` resolves through the protocol
  // handler's index.html fallback rather than needing `problems.html`.
  trailingSlash: true,

  // The image optimiser is a server route; without this every `next/image` 404s under a
  // static export. Remote avatar patterns are dropped with it — they needed the network
  // and a signed-in user, and this build has neither.
  images: { unoptimized: true },

  reactCompiler: true,

  /**
   * Source maps in the production bundle, so a logged stack can be resolved to real code.
   *
   * Without these, every frame the error log records is a minified chunk coordinate —
   * `at t (7121a7b3572656f4.js:1:155)` — and there is no way, after the fact, to turn that
   * back into a file and a line. Measured on a real render error: sixty-nine frames of
   * single-letter names. The log knew something broke and could not say where.
   *
   * The maps do not ship. `electron-builder.yml` filters `.map` out of the packaged renderer,
   * so the installer neither grows by 6.8MB nor carries a reconstruction of the original
   * TypeScript. They stay on the build machine, which is where resolving happens.
   *
   * That buys the size and the privacy back, and costs a habit: **keep `renderer/out` for any
   * build you release**, because a stack from a user's install can only be resolved against
   * the maps from the build that produced it. Chunk hashes change every build.
   *
   * Note this does not change what `err.stack` contains at runtime; V8 still reports minified
   * names. It makes those coordinates *resolvable* — see `npm run resolve-log`.
   */
  productionBrowserSourceMaps: true,
};

export default nextConfig;
