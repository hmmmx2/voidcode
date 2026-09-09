/**
 * Finding a dev server, and deciding what to start.
 *
 * Two properties carry real weight here. **Only loopback is ever previewed** — Vite prints a LAN
 * address beside the local one and they are not the same trust decision. And **the renderer never
 * names the command** — main reads the project's own `package.json`, so a preview cannot become
 * an unguarded path to running whatever a renderer asks for.
 */
import { describe, it, expect } from "vitest";
import { parseDevServerUrl } from "../src/main/preview/url.js";
import { detectPreviewCommand, detectPackageManager } from "../src/main/preview/detect.js";

describe("parseDevServerUrl", () => {
  it("reads the address real dev servers print", () => {
    // Captured shapes, not invented ones. Each of these is a line a server actually emits.
    const cases: Array<[string, string]> = [
      ["  ➜  Local:   http://localhost:5173/", "http://127.0.0.1:5173"],
      ["   - Local:        http://localhost:3000", "http://127.0.0.1:3000"],
      ["┃ Local    http://localhost:4321/", "http://127.0.0.1:4321"],
      ["Server listening on http://127.0.0.1:8080", "http://127.0.0.1:8080"],
      ["Starting development server at http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
      ["  On Your Network:  http://localhost:3000", "http://127.0.0.1:3000"],
    ];
    for (const [line, expected] of cases) {
      expect(parseDevServerUrl(line), line).toBe(expected);
    }
  });

  it("sees through the colour codes the address is wrapped in", () => {
    /**
     * The most likely reason a parser like this silently never matches.
     *
     * Vite emits the port in bold, and the escape lands *inside* the URL — so a matcher run over
     * the raw bytes finds a host and then no port at all.
     */
    const vite = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
    expect(parseDevServerUrl(vite)).toBe("http://127.0.0.1:5173");
  });

  it("refuses a LAN address", () => {
    // The security-relevant case. Same server, different trust decision: a non-loopback host can
    // be answered by anything on the network that wins a race, and it leaves the machine.
    expect(parseDevServerUrl("  ➜  Network: http://192.168.1.14:5173/")).toBeNull();
    expect(parseDevServerUrl("  Network:  http://10.0.0.8:3000")).toBeNull();
    expect(parseDevServerUrl("On Your Network:  http://172.16.4.2:3000")).toBeNull();
    expect(parseDevServerUrl("http://example.com:8080")).toBeNull();
    // `127.0.0.1.evil.com` is not loopback, and a prefix match would say it is.
    expect(parseDevServerUrl("http://127.0.0.1.evil.com:8080")).toBeNull();
    expect(parseDevServerUrl("http://localhost.evil.com:8080")).toBeNull();
  });

  it("takes the loopback address even when a LAN one comes first", () => {
    // Servers print both, and on one line often enough. Picking the first URL would make the
    // answer depend on the author's ordering; picking the first loopback one does not.
    const line = "  Network: http://192.168.1.14:5173/   Local: http://localhost:5173/";
    expect(parseDevServerUrl(line)).toBe("http://127.0.0.1:5173");
  });

  it("treats a wildcard bind as loopback", () => {
    // `0.0.0.0` is not an address, it is "every interface" — and reaching such a server over
    // loopback is exactly right.
    expect(parseDevServerUrl("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)")).toBe(
      "http://127.0.0.1:8000"
    );
    expect(parseDevServerUrl("listening on http://[::]:4000")).toBe("http://127.0.0.1:4000");
    expect(parseDevServerUrl("ready at http://[::1]:4000")).toBe("http://127.0.0.1:4000");
  });

  it("reads the prose form for servers that print no URL", () => {
    expect(parseDevServerUrl("Serving HTTP on 0.0.0.0 port 8000 ...")).toBe(
      "http://127.0.0.1:8000"
    );
    expect(parseDevServerUrl("listening on port 3000")).toBe("http://127.0.0.1:3000");
  });

  it("says nothing about the lines that are not announcements", () => {
    // The overwhelmingly common answer. A parser that guesses here points the preview at a
    // number it found in a stack trace.
    for (const line of [
      "",
      "  VITE v5.4.2  ready in 231 ms",
      "Compiled successfully.",
      "webpack 5.90.0 compiled with 2 warnings",
      "  at Object.<anonymous> (/app/src/index.ts:42:15)",
      "Downloaded 4096 bytes",
      "See https://vitejs.dev/guide/ for docs",
      "node:internal/modules/cjs/loader:1147",
    ]) {
      expect(parseDevServerUrl(line), JSON.stringify(line)).toBeNull();
    }
  });

  it("does not read a port out of a word that merely ends in one", () => {
    /**
     * Stack traces land on a dev server's stderr constantly, and they carry paths.
     *
     * Without the word boundary and the required space, `transport8080` in a filename is an
     * address — and the preview would point at whatever happens to be on 8080. The guard is
     * `port\s+`, and both halves of it are doing work.
     */
    for (const line of [
      "    at Object.<anonymous> (/app/src/transport8080.ts:4:2)",
      "Module not found: ./lib/transport3000",
      "export5173 is not defined",
      "listening on port3000",
      // And words that *end* in "port" — without the leading boundary, "Report 8080" is an
      // address. Dev servers print coverage and bundle reports constantly.
      "Coverage Report 8080 lines covered",
      "Bundle Report 2024 modules",
      "Transport 5173 disconnected, retrying",
    ]) {
      expect(parseDevServerUrl(line), line).toBeNull();
    }
  });

  it("refuses a port that is not one", () => {
    expect(parseDevServerUrl("http://localhost:99999")).toBeNull();
    expect(parseDevServerUrl("http://localhost:0")).toBeNull();
    expect(parseDevServerUrl("listening on port 70000")).toBeNull();
    /**
     * A longer number must not be truncated into a plausible one.
     *
     * The trailing `` is what does this. Without it the digit run is greedy but capped at
     * five, so `port 300000` yields `30000` — inside the valid range, entirely wrong, and a
     * preview pointed at whatever else is listening there.
     */
    expect(parseDevServerUrl("listening on port 300000")).toBeNull();
    expect(parseDevServerUrl("port 1234567")).toBeNull();
  });
});

describe("detectPackageManager", () => {
  it("reads the lockfile", () => {
    expect(detectPackageManager(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(["bun.lockb"])).toBe("bun");
    expect(detectPackageManager(["package-lock.json"])).toBe("npm");
  });

  it("defaults to npm when nothing says otherwise", () => {
    expect(detectPackageManager([])).toBe("npm");
    expect(detectPackageManager(["package.json", "README.md"])).toBe("npm");
  });

  it("prefers the manager that had to be chosen deliberately", () => {
    // A repo with both is a pnpm repo where someone once ran the wrong install.
    expect(detectPackageManager(["package-lock.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["package-lock.json", "yarn.lock"])).toBe("yarn");
  });
});

describe("detectPreviewCommand", () => {
  it("prefers dev, then start, then serve", () => {
    expect(detectPreviewCommand({ scripts: { dev: "vite", start: "node .", serve: "x" } }, [])
      ?.script).toBe("dev");
    expect(detectPreviewCommand({ scripts: { start: "node .", serve: "x" } }, [])?.script).toBe(
      "start"
    );
    expect(detectPreviewCommand({ scripts: { serve: "x" } }, [])?.script).toBe("serve");
  });

  it("does not run a script called preview", () => {
    // Vite's `preview` serves dist/ and exits immediately without a build — a failure that would
    // read as "the preview is broken" rather than "nothing is built".
    expect(detectPreviewCommand({ scripts: { preview: "vite preview" } }, [])).toBeNull();
  });

  it("passes run, and the manager from the lockfile", () => {
    const cmd = detectPreviewCommand({ scripts: { dev: "vite" } }, ["pnpm-lock.yaml"]);
    expect(cmd?.args).toEqual(["run", "dev"]);
    expect(cmd?.label).toBe("pnpm run dev");
    // `npm dev` is not a command; npm requires `run` and errors without it.
    expect(cmd?.args[0]).toBe("run");
  });

  it("never returns a command string, only a file and arguments", () => {
    // `proc/spawn.ts` takes a file and an argv precisely so nothing here can be injected into.
    const cmd = detectPreviewCommand({ scripts: { dev: "vite --port 1234 && rm -rf /" } }, []);
    expect(cmd?.file).not.toContain(" ");
    expect(cmd?.args).toEqual(["run", "dev"]);
    // The script body is never used as a command — only its name is.
    expect(JSON.stringify(cmd)).not.toContain("rm -rf");
  });

  it("says nothing for a project with no runnable script", () => {
    expect(detectPreviewCommand({ scripts: { build: "tsc", test: "vitest" } }, [])).toBeNull();
    expect(detectPreviewCommand({ scripts: {} }, [])).toBeNull();
    expect(detectPreviewCommand({}, [])).toBeNull();
    expect(detectPreviewCommand(null, [])).toBeNull();
    expect(detectPreviewCommand("not a package", [])).toBeNull();
    expect(detectPreviewCommand({ scripts: "dev" }, [])).toBeNull();
  });

  it("ignores an empty or non-string script body", () => {
    expect(detectPreviewCommand({ scripts: { dev: "" } }, [])).toBeNull();
    expect(detectPreviewCommand({ scripts: { dev: "   " } }, [])).toBeNull();
    expect(detectPreviewCommand({ scripts: { dev: 42 } }, [])).toBeNull();
    // Falls through to the next preference rather than giving up.
    expect(detectPreviewCommand({ scripts: { dev: "", start: "node ." } }, [])?.script).toBe(
      "start"
    );
  });

  it("does not mistake an inherited property for a script", () => {
    // `scripts` is parsed JSON, so `scripts.constructor` is a function on every object and
    // `"toString" in scripts` is true for every project on earth.
    expect(detectPreviewCommand({ scripts: { build: "tsc" } }, [])).toBeNull();
    expect(detectPreviewCommand({ scripts: Object.create({ dev: "vite" }) as object }, [])).toBeNull();
  });
});
