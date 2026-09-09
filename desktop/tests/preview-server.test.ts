/**
 * A dev server that outlives the turn that started it.
 *
 * These spawn **real processes** rather than mocking `child_process`. The failures worth catching
 * here are all in the seam between this code and the operating system — a process that announces
 * itself on stderr, one that prints an address nothing answers on, one that must actually be dead
 * afterwards — and a mock asserts only that the code calls the functions it already calls.
 *
 * The stand-in servers are `node -e` one-liners, so there is no fixture directory to keep in step
 * and each test says on its own face what the process it is testing against does.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { startPreview, stopPreview, previewState, killAllPreviews } = await import(
  "../src/main/preview/server.js"
);
import type { PreviewState } from "../src/main/preview/server.js";
import type { PreviewCommand } from "../src/main/preview/detect.js";

const ROOT = process.cwd();

/** A command that runs a node one-liner, in the shape `detect.ts` returns. */
const node = (source: string): PreviewCommand => ({
  file: process.execPath,
  args: ["-e", source],
  script: "dev",
  label: "node -e",
});

/** Wait until `predicate` holds for the published state, or give up. */
function until(
  predicate: (state: PreviewState) => boolean,
  timeoutMs = 25_000
): { onChange: (s: PreviewState) => void; done: Promise<PreviewState> } {
  let settle: (s: PreviewState) => void;
  let last: PreviewState | undefined;
  const done = new Promise<PreviewState>((resolve, reject) => {
    settle = resolve;
    const timer = setTimeout(
      () => reject(new Error(`timed out; last state: ${JSON.stringify(last)}`)),
      timeoutMs
    );
    timer.unref();
  });
  return {
    onChange: (s) => {
      last = s;
      if (predicate(s)) settle(s);
    },
    done,
  };
}

/** Is anything listening there? Used to prove a kill actually killed. */
async function listening(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** A real HTTP server that prints where it landed, exactly as a dev server does. */
const SERVER_SOURCE = `
  const http = require("http");
  const s = http.createServer((req, res) => { res.writeHead(200); res.end("hello"); });
  s.listen(0, "127.0.0.1", () => {
    console.log("  \\u001b[32m\\u27a1\\u001b[39m  Local:   http://localhost:" + s.address().port + "/");
  });
`;

afterEach(() => {
  killAllPreviews();
});

describe("starting a preview", () => {
  it("becomes ready once something answers, on the address the server printed", async () => {
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), watch.onChange);

    const state = await watch.done;
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(state.status).toBe("ready");
    // Reported through `previewState` too, not only to the subscriber — the UI reads both.
    expect(previewState(ROOT).url).toBe(state.url);
  });

  it("reports starting synchronously, before anything is ready", () => {
    // The channel must not block for the ninety seconds a cold Next build can take.
    const state = startPreview(ROOT, node(SERVER_SOURCE), () => {});
    expect(state.status).toBe("starting");
    expect(state.url).toBeNull();
    expect(state.label).toBe("node -e");
  });

  it("finds the address when it arrives on stderr", async () => {
    // Vite, Next and webpack all announce themselves there at least some of the time.
    const source = SERVER_SOURCE.replace("console.log", "console.error");
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(source), watch.onChange);
    expect((await watch.done).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ignores a LAN address and waits for the loopback one", async () => {
    // Both lines, in the order Vite prints them. Taking the first would leave the machine.
    const source = `
      const http = require("http");
      const s = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
      s.listen(0, "127.0.0.1", () => {
        console.log("  \\u27a1  Network: http://192.168.1.14:" + s.address().port + "/");
        console.log("  \\u27a1  Local:   http://localhost:" + s.address().port + "/");
      });
    `;
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(source), watch.onChange);
    expect((await watch.done).url).toContain("127.0.0.1");
  });

  it("keeps the server's own output, which is what you read when it will not start", async () => {
    const source = `console.log("compiling..."); console.log("done"); setTimeout(() => {}, 60000);`;
    const watch = until((s) => s.log.includes("done"));
    startPreview(ROOT, node(source), watch.onChange);
    expect((await watch.done).log).toContain("compiling...");
  });
});

describe("a preview that does not work", () => {
  it("fails when the process exits by itself", async () => {
    // A dev script that errors out — a missing dependency, most often. It must be seen to have
    // died rather than spinning: this module never restarts anything.
    const watch = until((s) => s.status === "failed");
    startPreview(ROOT, node(`console.error("Cannot find module 'vite'"); process.exit(1);`), watch.onChange);

    const state = await watch.done;
    expect(state.exitCode).toBe(1);
    expect(state.error).toContain("1");
    expect(state.log).toContain("Cannot find module");
  });

  it("fails when the binary is not there, and names the fix", async () => {
    const watch = until((s) => s.status === "failed");
    startPreview(
      ROOT,
      { file: "definitely-not-a-real-binary", args: ["run", "dev"], script: "dev", label: "pnpm run dev" },
      watch.onChange
    );
    // The errno is not the message. "pnpm was not found on PATH" is.
    expect((await watch.done).error).toContain("not found on PATH");
  });

  it("fails when an address is printed that nothing answers on", async () => {
    /**
     * The case `starting` and `ready` are separate states for.
     *
     * A printed address is a promise, not a fact. This one binds an ephemeral port, releases it,
     * and then announces it — so the address is well-formed and certainly nobody's.
     *
     * The first version of this test used port 9 (`discard`, never listening) and the parser
     * refused it: ports are matched as two to five digits, because a single-digit port is
     * reserved and a lone digit in a log line is far more likely to be something else. The
     * parser was right and the test was wrong.
     */
    const source = `
      const net = require("net");
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = s.address().port;
        s.close(() => { console.log("Local: http://localhost:" + port + "/"); });
      });
      setTimeout(() => {}, 60000);
    `;
    const watch = until((s) => s.status === "failed", 40_000);
    startPreview(ROOT, node(source), watch.onChange);
    const state = await watch.done;
    expect(state.error).toContain("Nothing answered");
    expect(state.url).toBeNull();
  }, 45_000);
});

describe("what it refuses to run", () => {
  /**
   * The check that replaces `shell: false` on Windows.
   *
   * Node cannot spawn a `.cmd` without a shell since the fix for CVE-2024-27980 — which is what
   * `npm run dev` does on Windows, and what made this feature fail with `spawn EINVAL` on its
   * first real run. A shell is therefore unavoidable there, so the safety has to come from the
   * command being three bare words instead.
   *
   * None of these is reachable through `detect.ts`, which builds both halves from closed sets.
   * That is the point: the guard is asserted where the shell is relied on, rather than inferred
   * from another file that could change.
   */
  // `.cmd`, because that is the only case that gets a shell — and the only case where a
  // metacharacter would mean anything. Suffix-keyed rather than platform-keyed precisely so
  // this test asserts the same thing on every OS.
  const refuses = (file: string, args: string[]) =>
    startPreview(ROOT, { file, args, script: "dev", label: "x" }, () => {});

  it("refuses a file or argument a shell would act on", () => {
    for (const [file, args] of [
      ["npm && calc.cmd", ["run", "dev"]],
      ["npm.cmd", ["run", "dev && calc"]],
      ["npm.cmd", ["run", "dev; rm -rf /"]],
      ["npm.cmd", ["run", "dev | tee out"]],
      ["npm.cmd", ["run", "%PATH%"]],
      ["npm.cmd", ["run", "dev`whoami`"]],
      ["npm.cmd", ["run", "$(whoami)"]],
      ["npm.cmd", ["run", 'dev"'],],
      ["npm.cmd", ["run dev"]],
      ["../../evil.cmd", ["run"]],
    ] as Array<[string, string[]]>) {
      const state = refuses(file, args);
      expect(state.status, `${file} ${args.join(" ")}`).toBe("failed");
      expect(state.error).toContain("Refusing");
    }
  });

  it("allows the shapes detect.ts actually produces", () => {
    // The other half — a guard that refused the real commands would be worse than none.
    for (const file of ["npm.cmd", "pnpm.cmd", "yarn.cmd"]) {
      const state = startPreview(ROOT, { file, args: ["run", "dev"], script: "dev", label: file }, () => {});
      // It may well fail to spawn — `pnpm.cmd` need not exist here — but it must not be refused
      // before it is tried, which is what this distinguishes.
      expect(state.error ?? "", file).not.toContain("Refusing");
      stopPreview(ROOT);
    }
  });
});

describe("stopping", () => {
  it("actually kills the server, not just the state", async () => {
    // The property that matters after the app is closed. A dev server still holding a port is
    // the most visible possible version of a leaked child.
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), watch.onChange);
    const url = (await watch.done).url;
    const port = Number(new URL(url ?? "").port);

    expect(await listening(port)).toBe(true);
    stopPreview(ROOT);

    // killTree is asynchronous on both platforms — taskkill is a whole process on Windows.
    for (let i = 0; i < 40 && (await listening(port)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await listening(port)).toBe(false);
  }, 30_000);

  it("does not report a deliberate stop as a crash", async () => {
    // The ordering in `stopPreview`: `cancelled` is set before the kill, so the `exit` handler
    // stays quiet. Without it, closing a preview tells the user their server crashed.
    const seen: PreviewState[] = [];
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), (s) => {
      seen.push(s);
      watch.onChange(s);
    });
    await watch.done;

    const before = seen.length;
    stopPreview(ROOT);
    await new Promise((r) => setTimeout(r, 1_500));

    expect(seen.slice(before).map((s) => s.status)).not.toContain("failed");
    // And it is idle rather than a fourth state nobody can render differently.
    expect(previewState(ROOT).status).toBe("idle");
  }, 30_000);

  it("is safe for a root with no preview", () => {
    expect(() => stopPreview("/no/such/root")).not.toThrow();
    expect(previewState("/no/such/root").status).toBe("idle");
  });

  it("replaces the previous server rather than running two", async () => {
    const first = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), first.onChange);
    const firstPort = Number(new URL((await first.done).url ?? "").port);

    const second = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), second.onChange);
    const secondPort = Number(new URL((await second.done).url ?? "").port);

    expect(secondPort).not.toBe(firstPort);
    for (let i = 0; i < 40 && (await listening(firstPort)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await listening(firstPort)).toBe(false);
  }, 40_000);

  it("kills every preview at quit", async () => {
    const watch = until((s) => s.status === "ready");
    startPreview(ROOT, node(SERVER_SOURCE), watch.onChange);
    const port = Number(new URL((await watch.done).url ?? "").port);

    killAllPreviews();
    for (let i = 0; i < 40 && (await listening(port)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await listening(port)).toBe(false);
  }, 30_000);
});
