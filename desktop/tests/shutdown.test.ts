/**
 * Everything that has to be torn down on quit is torn down on quit.
 *
 * ── WHY A TABLE AND NOT SIX ASSERTIONS ────────────────────────────────────────────────────────
 *
 * This bug has now happened three times in the same file. `quit.ts`'s own header records the first:
 * *"`killAllTerminals` was exported with no caller, and `closeDatabase` was called only from
 * tests."* Then `killAllCommands` and `killAllPreviews` were added, each with a comment explaining
 * the leak it fixes. And then `exec/host.ts` exported `shutdownSandbox` with a comment claiming it
 * was *"Called on app quit so a live interpreter does not outlive the window"* — and nothing called
 * it, so a Pyodide `utilityProcess` that had graded anything outlived the app.
 *
 * Five subsystems, the same mistake in the fifth, and no test could see it: each teardown is
 * correct on its own, `quit.ts` compiles, and the leak is a stray process after the window is gone.
 *
 * So this is a **declaration test** in the shape of `ipc-callers.test.ts`: the table below is the set
 * of teardowns the app has, and the assertion is that `will-quit` calls *exactly* that set. Adding a
 * sixth subsystem fails here until it is either wired or deliberately listed as not needing to be —
 * which is the friction that was missing.
 *
 * Read from source rather than executed. `quit.ts` imports `electron`, and the property is textual
 * anyway: is this function called inside the `will-quit` handler.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const quit = fs.readFileSync(path.join(root, "src/main/quit.ts"), "utf8");

/**
 * Every teardown, and what leaks without it.
 *
 * The reason column is not decoration: each of these was added because something outlived the app,
 * and a future reader deciding whether a new subsystem belongs here needs to know what the bar is.
 */
const TEARDOWNS: Record<string, string> = {
  /** Shells spawned by a window that never emitted `destroyed`. */
  killAllTerminals: "a shell keeps running after the app is gone",
  /** The nvidia-smi poller. Unref'd, so not a hang — just noise through shutdown. */
  stopTelemetry: "nvidia-smi keeps being spawned during shutdown",
  /** Whatever Auto mode started. A run's port closing kills its tree; a torn-down window does not. */
  killAllCommands: "an agent command tree survives the app",
  /** The most visible one: a dev server still holding port 3000 after VoidCode exits. */
  killAllPreviews: "a preview server keeps a port bound",
  /**
   * The Pyodide interpreter. This is the one that was exported, documented as called on quit, and
   * never called — found by reading `exec/host.ts`'s unreferenced exports rather than by any test.
   */
  shutdownSandbox: "the Pyodide utilityProcess outlives the window",
  /** WAL plus process exit is safe, so this is explicitness rather than a leak. */
  closeDatabase: "shutdown relies on the OS rather than being explicit",
};

/** The body of the `will-quit` handler, with comments stripped. */
function willQuitBody(): string {
  const source = quit.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const from = source.indexOf('app.on("will-quit"');
  expect(from, "no will-quit handler in quit.ts").toBeGreaterThan(-1);

  // To the end of the handler: the first line that closes it at the handler's own indentation.
  const rest = source.slice(from);
  const end = rest.indexOf("\n  });");
  expect(end, "could not find the end of the will-quit handler").toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("quitting tears down everything that outlives the app", () => {
  const body = willQuitBody();

  it("finds a handler with calls in it", () => {
    // Guards the extraction. If this stops matching, the assertions below pass on an empty string
    // and the test becomes the thing it was written to prevent.
    expect(body.length).toBeGreaterThan(50);
    expect(body).toContain("closeDatabase");
  });

  it("calls every teardown in the table", () => {
    const missing = Object.keys(TEARDOWNS).filter((fn) => !body.includes(`${fn}(`));
    expect(missing, "declared teardowns that will-quit does not call").toEqual([]);
  });

  it("calls nothing that is not in the table", () => {
    /**
     * The other direction, and the reason this is a declaration rather than a checklist: a teardown
     * added to `will-quit` without a line here is a subsystem whose leak nobody wrote down. Cheap to
     * satisfy — one entry naming what leaks — and it keeps the table the real inventory.
     */
    const called = [...body.matchAll(/\b([a-z][A-Za-z]*)\(\)/g)].map((m) => m[1] as string);
    const undeclared = [...new Set(called)].filter((fn) => TEARDOWNS[fn] === undefined);
    expect(undeclared, "called by will-quit but not declared above").toEqual([]);
  });

  it("imports each of them, so none is a same-file coincidence", () => {
    // `body.includes("killAllTerminals(")` would also match a local helper of the same name. The
    // import is what makes it the subsystem's own teardown.
    for (const fn of Object.keys(TEARDOWNS)) {
      expect(quit, `${fn} is not imported`).toMatch(new RegExp(`import[\\s\\S]{0,120}\\b${fn}\\b`));
    }
  });

  it("gives every teardown a reason", () => {
    // An empty reason is the same as no entry: it records that somebody noticed and nothing more.
    for (const [fn, reason] of Object.entries(TEARDOWNS)) {
      expect(reason.length, fn).toBeGreaterThan(20);
    }
  });
});
