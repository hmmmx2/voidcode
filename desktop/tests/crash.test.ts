/**
 * The handlers for the failures that leave no exception.
 *
 * `log.test.ts` proves the logger works. This proves the four handlers are wired to it, which is a
 * different claim and the one that was untrue: a renderer segfault, a killed GPU process and an
 * OOM-killed Pyodide worker all used to produce **nothing at all** in the log.
 *
 * Every assertion here is about a way that silence comes back:
 *   - a handler that no longer writes anything,
 *   - a handler that writes at a level nobody looks at,
 *   - a real crash misclassified as a normal exit (or a normal exit shouted about, which is the same
 *     defect from the other side — a log full of false errors hides the true one),
 *   - context that leaks a secret, because a crash line carries a URL and URLs carry tokens,
 *   - and an Electron upgrade that adds a reason this build has never heard of.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `app.on` and `crashReporter.start` are recorded rather than stubbed away.
 *
 * `installCrashHandlers` is worth a test precisely because its job is registration — asserting on the
 * handlers alone would pass in a build where nothing calls them, which is the bug being fixed.
 */
const registered = new Map<string, (...args: never[]) => void>();
const started: Array<Record<string, unknown>> = [];

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.0",
    getPath: (name: string) => {
      if (name === "crashDumps") return "/tmp/voidcode-crashpad";
      throw new Error(`getPath(${name}) — the test seam should have taken precedence`);
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      registered.set(event, listener);
    },
  },
  crashReporter: {
    start: (options: Record<string, unknown>) => {
      started.push(options);
    },
  },
}));

const { __setLogDir, logFile } = await import("../src/main/log.js");
const {
  installCrashHandlers,
  __resetCrashHandlers,
  onRenderProcessGone,
  onChildProcessGone,
  onUncaughtException,
  onUnhandledRejection,
  REASON_LEVEL,
} = await import("../src/main/crash.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "voidcode-crash-"));
  __setLogDir(dir);
  __resetCrashHandlers();
  registered.clear();
  started.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  /**
   * `process` is not mocked — it is the process running the test, so a registered handler would
   * outlive the file and swallow a genuine failure in another one. Removing them by the exported
   * references also happens to assert that `installCrashHandlers` registers those exact functions:
   * `off` with a different function silently removes nothing, and the listener count below catches it.
   */
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
  __setLogDir(undefined);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Line {
  level: string;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
}

const lines = (): Line[] =>
  readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);

/** The last line, which is the one the call under test just wrote. */
const last = (): Line => {
  const all = lines();
  const line = all[all.length - 1];
  if (line === undefined) throw new Error("nothing was written to the log");
  return line;
};

describe("a renderer that disappears", () => {
  it("records the reason, the exit code and which route it was on", () => {
    onRenderProcessGone({ reason: "crashed", exitCode: 139 }, "app://bundle/problems/layer-norm/");

    const line = last();
    expect(line.level).toBe("error");
    // The half of the app to look in. A crash line that does not say this is a starting point at best.
    expect(line.source).toBe("renderer");
    expect(line.message).toContain("crashed");
    expect(line.context?.exitCode).toBe(139);
    /**
     * The URL, because with two window modes and a dozen routes "the renderer crashed" is not yet
     * actionable — and reproducing it starts with knowing which page was open.
     */
    expect(line.context?.url).toBe("app://bundle/problems/layer-norm/");
  });

  it("still writes a line when the URL could not be read", () => {
    // Destroyed `webContents.getURL()` throws, which is the normal case here: the contents are gone.
    onRenderProcessGone({ reason: "oom", exitCode: 0 }, null);

    expect(last().level).toBe("error");
    expect(last().context?.url).toBeNull();
  });

  it("does not shout about a clean exit", () => {
    /**
     * The other direction of the same defect. A log that prints an error every time a renderer exits
     * normally is a log nobody reads, and the real crash then arrives inside a wall of false ones.
     */
    onRenderProcessGone({ reason: "clean-exit", exitCode: 0 }, "app://bundle/");
    expect(last().level).toBe("info");
  });

  it("drops the query string, which is where a token would be", () => {
    /**
     * This assertion failed when it was written, and the fix was in the handler rather than here.
     *
     * The logger redacts by **key name** — deliberately, see `log.ts` — and `url` is not a secret key,
     * so `?api_key=…` reached the file verbatim. Not hypothetical: the OpenRouter flow puts a key in a
     * URL, and this code path quotes a string without ever looking at what is in it.
     *
     * Both halves are asserted. Dropping the whole URL would also pass "no token in the file" while
     * destroying the only thing the line is for.
     */
    onRenderProcessGone(
      { reason: "crashed", exitCode: 1 },
      "https://openrouter.ai/callback/x?api_key=sk-live-secret#frag"
    );

    expect(readFileSync(logFile(), "utf8")).not.toContain("sk-live-secret");
    expect(last().context?.url).toBe("https://openrouter.ai/callback/x");
  });

  it("keeps an app:// path intact, query or not", () => {
    // The common case, and the one the line exists for. Nothing is lost by stripping a query here.
    onRenderProcessGone({ reason: "crashed", exitCode: 1 }, "app://bundle/problems/layer-norm/");
    expect(last().context?.url).toBe("app://bundle/problems/layer-norm/");
  });

  it("reports something even when the URL will not parse", () => {
    onRenderProcessGone({ reason: "crashed", exitCode: 1 }, "not a url?token=abc");
    expect(last().context?.url).toBe("not a url");
  });
});

describe("a child process that disappears", () => {
  it("names the process type, so the consequence is legible", () => {
    /**
     * `Utility` is the Pyodide sandbox. That distinction is the entire value of the line: a dead GPU
     * process means the window is software-rendered and the user may not notice, whereas a dead
     * utility process means grading will never return.
     */
    onChildProcessGone({ type: "Utility", reason: "oom", exitCode: 137, name: "Node Utility Process" });

    const line = last();
    expect(line.level).toBe("error");
    // Main observed it, and a utility process is not a renderer — the source field points at a half
    // of the app rather than being decorative.
    expect(line.source).toBe("main");
    expect(line.message).toContain("Utility");
    expect(line.context?.type).toBe("Utility");
    expect(line.context?.name).toBe("Node Utility Process");
  });

  it("tolerates the optional names being absent", () => {
    onChildProcessGone({ type: "GPU", reason: "killed", exitCode: 1 });
    expect(last().context?.name).toBeNull();
    expect(last().context?.serviceName).toBeNull();
  });
});

describe("exceptions nobody caught", () => {
  it("keeps the stack, and marks it fatal", () => {
    onUncaughtException(new Error("boom"));

    const line = last();
    expect(line.level).toBe("error");
    expect(line.context?.fatal).toBe(true);
    expect(String(line.message)).toContain("boom");
  });

  it("records a rejection that is not an Error", () => {
    // `throw "string"` and `Promise.reject({code:1})` are both legal and both reach these handlers.
    onUnhandledRejection("just a string");
    expect(last().message).toBe("just a string");
    expect(last().level).toBe("error");
  });
});

describe("installation", () => {
  it("registers all four, and starts the reporter with uploading off", () => {
    installCrashHandlers();

    expect(registered.has("render-process-gone")).toBe(true);
    expect(registered.has("child-process-gone")).toBe(true);
    /**
     * By identity, not by count. A lambda registered here would pass a count assertion while doing
     * something the tests above never see — and the tests above are the whole evidence that these two
     * behave, so a count would make them prove nothing about what actually runs.
     */
    expect(process.listeners("uncaughtException")).toContain(onUncaughtException);
    expect(process.listeners("unhandledRejection")).toContain(onUnhandledRejection);

    /**
     * `uploadToServer: false` is an assertion about the product, not about the API. The app has no
     * telemetry and `/privacy` says so; a reporter that posts minidumps to a server would make the
     * Privacy Policy false. `honest-copy.test.ts` guards the prose, and this guards the code it
     * describes.
     */
    expect(started).toHaveLength(1);
    expect(started[0]?.uploadToServer).toBe(false);
    expect(started[0]?.submitURL).toBeUndefined();
  });

  it("routes the registered listeners into the handlers", () => {
    /**
     * The join between registration and behaviour. Without this, a listener registered against the
     * wrong event — or one that swallows its details — passes every test above.
     */
    installCrashHandlers();

    const onRender = registered.get("render-process-gone");
    const contents = {
      getURL: () => "app://bundle/interview/",
    } as unknown as never;
    (onRender as unknown as (e: unknown, c: unknown, d: unknown) => void)(
      {},
      contents,
      { reason: "crashed", exitCode: 5 }
    );
    expect(last().context?.url).toBe("app://bundle/interview/");
    expect(last().context?.exitCode).toBe(5);

    const onChild = registered.get("child-process-gone");
    (onChild as unknown as (e: unknown, d: unknown) => void)({}, {
      type: "GPU",
      reason: "crashed",
      exitCode: 3,
    });
    expect(last().message).toContain("GPU");
  });

  it("survives webContents.getURL() throwing, which is the normal case", () => {
    installCrashHandlers();

    const onRender = registered.get("render-process-gone");
    const destroyed = {
      getURL: () => {
        throw new Error("Object has been destroyed");
      },
    } as unknown as never;

    expect(() =>
      (onRender as unknown as (e: unknown, c: unknown, d: unknown) => void)(
        {},
        destroyed,
        { reason: "crashed", exitCode: 1 }
      )
    ).not.toThrow();
    expect(last().context?.url).toBeNull();
  });

  it("is idempotent, so a second call cannot double every line", () => {
    installCrashHandlers();
    installCrashHandlers();
    expect(started).toHaveLength(1);
  });
});

describe("the reason table stays total", () => {
  /**
   * ── WHY THIS READS electron.d.ts ──────────────────────────────────────────────────────────────
   *
   * `REASON_LEVEL` is a `Record` over a hand-written union, so TypeScript proves it covers every
   * reason **this file knows about**. It cannot prove the union still matches Electron's, and Electron
   * has widened it before — `memory-eviction` was added after `render-process-gone` shipped.
   *
   * A reason we have never heard of falls through `levelFor` to `error`, which is the safe direction
   * but not a free pass: `clean-exit` was once the only benign value and now there are two, so the
   * next addition could be benign as well and would start reporting false errors. Reading the union
   * out of the shipped types makes an `npm update electron` that changes it a failing test instead of
   * a slow drift.
   */
  const union = (interfaceName: string): string[] => {
    const dts = readFileSync(path.join(root, "node_modules/electron/electron.d.ts"), "utf8");
    const start = dts.indexOf(`interface ${interfaceName} {`);
    expect(start, `${interfaceName} not found in electron.d.ts`).toBeGreaterThan(0);
    const body = dts.slice(start, dts.indexOf("\n  }", start));

    // `reason: ('clean-exit' | 'abnormal-exit' | …);`
    const match = /reason:\s*\(([^)]+)\)/.exec(body);
    expect(match, `no reason union in ${interfaceName}`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string);
  };

  for (const interfaceName of ["RenderProcessGoneDetails", "Details"]) {
    it(`covers every reason in ${interfaceName}`, () => {
      const reasons = union(interfaceName);
      // Vacuity guard: a regex that stopped matching would otherwise pass this test forever.
      expect(reasons.length).toBeGreaterThan(5);
      expect(reasons).toContain("crashed");

      const missing = reasons.filter((reason) => !(reason in REASON_LEVEL));
      expect(missing, "reasons Electron has that crash.ts has never been taught").toEqual([]);
    });
  }

  it("reports a reason it has never heard of as an error", () => {
    /**
     * The fallback in `levelFor`, and it survived mutation to `"info"` until this existed — no test
     * reached it, because every reason in the table is a known one.
     *
     * It has to fail loud. The whole phase is about a class of failure that produced no log line at
     * all, so an Electron upgrade introducing a reason this build predates must not reintroduce the
     * silence for whatever that new reason turns out to be. The test above then makes the *next* person
     * classify it deliberately.
     */
    onRenderProcessGone({ reason: "reason-from-a-future-electron", exitCode: 9 }, null);
    expect(last().level).toBe("error");
    expect(last().message).toContain("reason-from-a-future-electron");
  });

  it("classifies only the two benign reasons as benign", () => {
    /**
     * Pinned in both directions. Missing an error is a silence; adding one is a wall of false errors
     * that produces the same silence by drowning it.
     */
    const benign = Object.entries(REASON_LEVEL)
      .filter(([, level]) => level !== "error")
      .map(([reason]) => reason)
      .sort();
    expect(benign).toEqual(["clean-exit", "memory-eviction"]);
  });
});

describe("index.ts installs them at module scope", () => {
  /**
   * The one thing no unit test can reach, because importing `index.ts` takes the single-instance lock
   * and calls `whenReady`. So this reads it — the same idiom `ipc-callers.test.ts` uses for the same
   * reason.
   *
   * Position is the claim, not presence. Inside `onReady` the call would miss every startup failure
   * and leave the child processes started before it uninstrumented, and it would still look correct.
   */
  const source = readFileSync(path.join(root, "src/main/index.ts"), "utf8");

  it("calls installCrashHandlers before the app-ready path", () => {
    const install = source.indexOf("installCrashHandlers()");
    const ready = source.indexOf("app.whenReady()");
    expect(install, "index.ts does not call installCrashHandlers").toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(0);
    expect(install, "installCrashHandlers must run before whenReady").toBeLessThan(ready);
  });

  it("calls it at module scope, not inside a function", () => {
    /**
     * A call indented by two spaces or more is inside something. Crude, and deliberately so: the
     * alternative is parsing TypeScript to prove a statement is top-level, and every call site in
     * this file that is top-level starts at column zero.
     */
    const line = source.split("\n").find((l) => l.includes("installCrashHandlers()"));
    expect(line).toBeDefined();
    expect(line?.startsWith("installCrashHandlers()")).toBe(true);
  });

  it("names the crash-dump directory in the startup log line", () => {
    // A minidump nobody can find is not a diagnostic, and this is the only place the path is written.
    expect(source).toContain("crashDumps: crashDumpDir()");
  });
});
