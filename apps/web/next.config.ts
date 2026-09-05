import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Required to containerise this app at all.
   *
   * Without it, `next build` leaves a `.next` directory that needs the whole
   * `node_modules` tree at runtime — around 1 GB, and it means the production image
   * carries every devDependency. `standalone` emits a self-contained server plus
   * only the modules actually traced as reachable.
   *
   * There was no `apps/web` Dockerfile, and this is why: the image would have been
   * enormous and nobody had a reason to build it.
   */
  output: "standalone",
  reactCompiler: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "graph.microsoft.com" },
    ],
  },
};

export default nextConfig;
