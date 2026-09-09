/**
 * The renderer half: getting an error out of a sandboxed page and onto disk.
 *
 * The renderer cannot write files, so every one of its errors has to travel through
 * `host.log.write` or be lost. That makes the interesting cases the ones where the trip
 * fails — no host at all (the browser build), a rejecting bridge, a listener installed twice
 * — because each of those loses errors silently rather than loudly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { reportError, describeError, installErrorReporting, __resetErrorReporting } = await import(
  "../renderer/src/lib/shell/report-error.js"
);

type Written = {
  level: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
};

let written: Written[];

beforeEach(() => {
  written = [];
  __resetErrorReporting();
  vi.spyOn(console, "error").mockImplementation(() => {});
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { location?: unknown }).location = { pathname: "/problems/3" };
  (globalThis as { host?: unknown }).host = {
    log: {
      write: (input: Written) => {
        written.push(input);
        return Promise.resolve({ ok: true });
      },
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { host?: unknown }).host;
  __resetErrorReporting();
});

describe("shaping what was thrown", () => {
  it("names the error type alongside its message", () => {
    expect(describeError(new TypeError("bad")).message).toBe("TypeError: bad");
  });

  it("survives a thrown string and a thrown object", () => {
    expect(describeError("nope")).toEqual({ message: "nope", stack: null });
    expect(describeError({ code: 7 }).message).toBe('{"code":7}');
  });

  it("survives something unserialisable rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeError(cyclic)).not.toThrow();
  });
});

describe("the trip to main", () => {
  it("sends the message and the stack", () => {
    reportError(new Error("kaboom"));
    expect(written).toHaveLength(1);
    expect(written[0]?.message).toBe("Error: kaboom");
    expect(written[0]?.stack).toContain("report-error.test.ts");
  });

  it("attaches the route, which no stack trace contains", () => {
    // The single most useful field for reproducing a renderer bug.
    reportError(new Error("x"));
    expect(written[0]?.context).toMatchObject({ route: "/problems/3" });
  });

  it("keeps caller context alongside the route", () => {
    reportError(new Error("x"), { region: "page", kind: "react" });
    expect(written[0]?.context).toMatchObject({ region: "page", kind: "react" });
  });

  it("truncates rather than letting the schema reject the whole report", () => {
    // The contract caps message at 4k and stack at 16k. Sending an over-long string would be
    // refused at the boundary and the error would vanish entirely — truncating first means a
    // shortened report still lands.
    const huge = new Error("m".repeat(9_000));
    huge.stack = "s".repeat(40_000);
    reportError(huge);
    expect(written[0]?.message.length).toBeLessThanOrEqual(4_000);
    expect((written[0]?.stack ?? "").length).toBeLessThanOrEqual(16_000);
  });
});

describe("never becoming the second failure", () => {
  it("does not throw when there is no host, as in the browser build", () => {
    delete (globalThis as { host?: unknown }).host;
    expect(() => reportError(new Error("x"))).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("does not throw when the bridge rejects", () => {
    (globalThis as { host?: unknown }).host = {
      log: { write: () => Promise.reject(new Error("bridge gone")) },
    };
    expect(() => reportError(new Error("x"))).not.toThrow();
  });

  it("leaves no unhandled rejection when the bridge rejects", async () => {
    /**
     * The assertion that `not.toThrow()` cannot make.
     *
     * A rejected promise never throws synchronously, so dropping the `.catch` passes every
     * "does not throw" test while producing an unhandled rejection — which, in the renderer,
     * is picked up by the `unhandledrejection` listener this very module installs, reported,
     * and reported again for each failure of that report. A reporter that feeds itself.
     *
     * Verified by watching for the event rather than by reading the source.
     */
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      (globalThis as { host?: unknown }).host = {
        log: { write: () => Promise.reject(new Error("bridge gone")) },
      };
      reportError(new Error("x"));
      // Two macrotask turns: Node raises `unhandledRejection` once the microtask queue has
      // drained and nothing has attached a handler.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not throw when the bridge throws synchronously", () => {
    (globalThis as { host?: unknown }).host = {
      log: {
        write: () => {
          throw new Error("revoked");
        },
      },
    };
    expect(() => reportError(new Error("x"))).not.toThrow();
  });

  it("always reaches the console, so a lost trip still leaves a trace", () => {
    reportError(new Error("x"));
    expect(console.error).toHaveBeenCalled();
  });
});

describe("the global listeners", () => {
  /**
   * A recording window, because the Node test environment has no `addEventListener` to spy on.
   *
   * Building one is also more honest than a spy: `installErrorReporting` is supposed to work
   * against whatever `window` it is handed, and this asserts on the pairs it actually
   * registered rather than on a method existing.
   */
  const fakeWindow = () => {
    const added: string[] = [];
    const removed: string[] = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener: (type: string) => void added.push(type),
      removeEventListener: (type: string) => void removed.push(type),
      location: { pathname: "/build" },
    };
    return { added, removed };
  };

  it("installs both listeners", () => {
    const { added } = fakeWindow();
    installErrorReporting();
    expect(added).toEqual(["error", "unhandledrejection"]);
  });

  it("installs once even when mounted twice", () => {
    // React 18 runs effects twice in development. Two installs means every error reported
    // twice, which reads as a loop in the log.
    const { added } = fakeWindow();
    installErrorReporting();
    installErrorReporting();
    expect(added.filter((t) => t === "error")).toHaveLength(1);
    expect(added.filter((t) => t === "unhandledrejection")).toHaveLength(1);
  });

  it("removes what it added, so a remount does not stack listeners", () => {
    const { removed } = fakeWindow();
    installErrorReporting()();
    expect(removed).toEqual(["error", "unhandledrejection"]);
  });

  it("can be installed again after teardown", () => {
    // The idempotence guard must be cleared by the teardown, or a remount after an unmount
    // silently registers nothing and the app stops reporting.
    const first = fakeWindow();
    installErrorReporting()();
    const second = fakeWindow();
    installErrorReporting();
    expect(first.removed).toEqual(["error", "unhandledrejection"]);
    expect(second.added).toEqual(["error", "unhandledrejection"]);
  });
});

describe("the error boundary", () => {
  // A component stack as React produces it: newline-separated frames naming components.
  const NL = String.fromCharCode(10);
  const STACK = ["", "    at ProblemPanel", "    at Workbench"].join("\n");

  const load = async () =>
    (await import("../renderer/src/components/Shell/ErrorBoundary.js")).default;

  it("derives the fallback state from whatever was thrown", async () => {
    const ErrorBoundary = await load();
    expect(ErrorBoundary.getDerivedStateFromError(new Error("undefined is not a function"))).toEqual(
      { message: "undefined is not a function" }
    );
    // Not everything thrown is an Error, and a boundary that assumes otherwise renders
    // "undefined" as its explanation.
    expect(ErrorBoundary.getDerivedStateFromError("plain string")).toEqual({
      message: "plain string",
    });
  });

  it("reports to the log, with the component stack", async () => {
    const ErrorBoundary = await load();
    const boundary = new ErrorBoundary({ region: "page", children: null });

    boundary.componentDidCatch(new Error("render blew up"), {
      componentStack: STACK,
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.message).toBe("Error: render blew up");
    // The component stack is the whole reason `componentDidCatch` is implemented alongside
    // `getDerivedStateFromError`: a JS stack points at a minified render function, this names
    // the file to open.
    expect(written[0]?.context).toMatchObject({
      kind: "react",
      region: "page",
      componentStack: STACK,
    });
  });

  it("keeps a short stack whole", async () => {
    const { trimComponentStack } = await import(
      "../renderer/src/components/Shell/ErrorBoundary.js"
    );
    expect(trimComponentStack(STACK)).toBe(STACK);
    expect(trimComponentStack(null)).toBeNull();
    expect(trimComponentStack("")).toBeNull();
  });

  it("trims a long stack and says how much it dropped", async () => {
    /**
     * The production shape, measured rather than imagined: a real minified build produced 69
     * frames and 4.5KB of a 5.6KB entry, which at the 2MB cap is 374 entries before rotation.
     * A component throwing in a re-render loop would push the original cause out of the file.
     */
    const { trimComponentStack } = await import(
      "../renderer/src/components/Shell/ErrorBoundary.js"
    );
    const long = Array.from({ length: 69 }, (_, i) => `    at c${i} (chunk.js:1:${i})`).join(NL);

    const trimmed = trimComponentStack(long) ?? "";
    const lines = trimmed.split(NL);

    // 20 kept plus the marker.
    expect(lines).toHaveLength(21);
    // The frames nearest the throw are the ones that localise it.
    expect(lines[0]).toContain("at c0");
    expect(lines[19]).toContain("at c19");
    // Marked rather than silent: a truncated stack must not read as a shallow tree.
    expect(lines[20]).toContain("49 more frames");
    expect(trimmed.length).toBeLessThan(long.length / 2);
  });

  it("trims through the real report path, not only in the helper", async () => {
    // The helper being correct is worth nothing if `componentDidCatch` forgets to call it.
    const ErrorBoundary = await load();
    const long = Array.from({ length: 69 }, (_, i) => `    at c${i} (chunk.js:1:${i})`).join(NL);

    new ErrorBoundary({ region: "page", children: null }).componentDidCatch(new Error("x"), {
      componentStack: long,
    });

    const sent = String((written[0]?.context as Record<string, unknown>)?.componentStack ?? "");
    expect(sent.split(NL)).toHaveLength(21);
    expect(sent).toContain("49 more frames");
  });

  it("names the region, so nested boundaries stay distinguishable", async () => {
    const ErrorBoundary = await load();
    new ErrorBoundary({ region: "assistant", children: null }).componentDidCatch(
      new Error("x"),
      { componentStack: null }
    );
    expect(written[0]?.context).toMatchObject({ region: "assistant" });
  });

  it("renders children untouched when nothing has thrown", async () => {
    const ErrorBoundary = await load();
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, { region: "page", children: createElement("p", null, "the page") })
    );
    expect(html).toBe("<p>the page</p>");
  });

  it("shows the message and says where the details went", async () => {
    /**
     * Rendered from the caught state directly.
     *
     * A boundary does not catch during server rendering, so throwing inside
     * `renderToStaticMarkup` would produce an exception rather than the fallback. Driving the
     * component to its post-catch state is what actually exercises the markup a user reads.
     */
    const ErrorBoundary = await load();
    const boundary = new ErrorBoundary({ region: "page", children: null });
    boundary.state = { message: "Cannot read properties of undefined" };

    const html = renderToStaticMarkup(boundary.render() as React.ReactElement);

    expect(html).toContain("This panel stopped working.");
    // The message itself, not "an error occurred" — it is what the user can read back to you.
    expect(html).toContain("Cannot read properties of undefined");
    // And where the stack went, since the user is the one who has to go and find it.
    expect(html).toContain("Open Logs Folder");
    expect(html).toContain("Try again");
  });
});
