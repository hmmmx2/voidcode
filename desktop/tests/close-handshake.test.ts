/**
 * The window does not close until its unsaved work has been written.
 *
 * WHY THIS IS WORTH A FILE OF ITS OWN. `src/main/windows.ts` states the rule in its own comment:
 * the handshake "SHIPS WITH SAVE, NOT AFTER IT — before saving existed, nothing persisted and
 * everyone knew it. Adding save without this would change the failure mode to 'usually persists,
 * silently does not when you close the window' — worse in kind, because it is the one a user
 * trusts and then loses work to."
 *
 * Nothing in `tests/` covered that handshake at all, on either side, for as long as it has
 * existed. It was correct while the workspace was read-only and stopped being correct the moment
 * Ctrl+S did.
 *
 * A SOURCE SCAN PLUS PURE HELPERS, because the handshake spans a process boundary: main sends
 * `window.confirmClose` over `shell:command` and starts a timer, the renderer answers with
 * `allowClose`. Neither half is reachable from this suite — there is no Electron and no DOM — so
 * what is asserted here is that each half still does the thing the other depends on, and the
 * arithmetic the renderer half performs is tested directly.
 *
 * Comments are stripped before scanning. Both files discuss `allowClose` at length, including the
 * wrong version of the call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planCloseSaves, conflictPathFor } from "@/lib/build/editor-save";

const root = path.resolve(__dirname, "..");

function code(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The `window.confirmClose` branch of the shell's command listener. */
function handler(): string {
  const source = code("renderer/src/components/Shell/Workbench.tsx");
  const start = source.indexOf('command !== "window.confirmClose"');
  expect(start, "the confirmClose handler is gone from Workbench").toBeGreaterThan(-1);
  return source.slice(start, start + 900);
}

describe("main's half", () => {
  it("still asks before closing, and closes anyway if nobody answers", () => {
    /**
     * The timeout is the part that is easy to omit and expensive to get wrong: without it, a
     * renderer that has hung makes the window unclosable and the app unquittable, and the user's
     * only recourse is the task manager.
     */
    const windows = code("src/main/windows.ts");
    expect(windows).toContain("event.preventDefault()");
    expect(windows).toContain('command: "window.confirmClose"');
    expect(windows).toMatch(/setTimeout\([\s\S]{0,120}CLOSE_GRACE_MS\)/);
  });

  it("gives the renderer a bounded, short window to answer in", () => {
    // Long enough for a save round trip, short enough that a broken renderer costs a pause
    // rather than a reboot. Read off the constant so a change to it fails here.
    const windows = code("src/main/windows.ts");
    const grace = /CLOSE_GRACE_MS = ([\d_]+)/.exec(windows);
    expect(grace, "CLOSE_GRACE_MS is gone").not.toBeNull();
    const ms = Number((grace?.[1] ?? "0").replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe("the renderer's half", () => {
  it("writes everything before allowing the close", () => {
    /**
     * THE MUTATION THIS EXISTS FOR is reverting to a bare `void window.host?.window?.allowClose()`
     * — which is exactly what stood here while the workspace was read-only, and which now loses
     * every unsaved buffer on the way out.
     */
    const body = handler();
    expect(body, "the handler no longer flushes").toContain("flushAll");
    expect(body, "the handler no longer answers main").toContain("allowClose");

    const flush = body.indexOf("flushAll");
    const allow = body.indexOf("allowClose");
    expect(
      flush < allow,
      "allowClose is called before the flush, so main may close the window mid-write"
    ).toBe(true);
    expect(body, "the flush is not awaited").toMatch(/await\s+[\s\S]{0,40}flushAll/);
  });

  it("still answers when a save fails, rather than hanging the quit", () => {
    /**
     * `allowClose` in a `finally`. Main closes the window after the grace period regardless, so
     * refusing to answer buys a three-second pause and nothing else — and by then `flushAll` has
     * already done everything that can be done, including the rescue file.
     */
    expect(handler()).toMatch(/finally\s*\{[\s\S]{0,200}allowClose/);
  });

  it("does not prompt, because there is nobody to prompt", () => {
    /**
     * Three seconds, and the user has already clicked the close button or the machine is
     * shutting down. `Workbench`'s own earlier note says prompting per file at shutdown is "the
     * behaviour everyone clicks through without reading" — and a dialog that times out discards
     * the work it was asking about.
     */
    expect(handler()).not.toContain("confirmDiscard");
  });
});

describe("what the flush actually does", () => {
  it("writes only the dirty buffers", () => {
    const files = [
      { path: "clean.py", contents: "x", baseline: "x" },
      { path: "dirty.py", contents: "y2", baseline: "y" },
    ];
    expect(planCloseSaves(files).map((f) => f.path)).toEqual(["dirty.py"]);
  });

  it("has somewhere to put a buffer whose save is refused", () => {
    /**
     * The case with no good answer: the file changed underneath, there is no time to ask, and the
     * window is going. A sibling file is the least-bad outcome — confined by `RendererPath`, no
     * dialog, fits in the grace window, and visible in the tree next time.
     */
    const rescue = conflictPathFor("dirty.py", new Set(["dirty.py"]));
    expect(rescue.startsWith("dirty.py")).toBe(true);
    expect(rescue).not.toBe("dirty.py");
  });
});
