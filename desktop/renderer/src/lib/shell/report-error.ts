/**
 * Renderer errors, on their way to the log file.
 *
 * The renderer is sandboxed and cannot write to disk, which is the point — so everything it
 * catches has to travel through `host.log.write` to reach main. Without that, a renderer
 * exception exists only in a DevTools console nobody has open.
 *
 * `host` is optional throughout, because the same code runs in a browser during development
 * where there is no host at all. There the console is genuinely the right sink, and pretending
 * otherwise would mean losing errors in the one environment where someone is watching.
 */

/**
 * The one member of `host` this module needs, declared locally.
 *
 * `host.d.ts` types the full bridge, but it is a renderer-only ambient declaration and this
 * file is also compiled by the main project (the tests import it), where that global does not
 * exist. Narrowing to what is used keeps both compilers happy and states the dependency
 * outright: a reporter that needs one method should not require the whole surface.
 */
interface LogBridge {
  log?: {
    write(input: {
      level: "error" | "warn";
      message: string;
      stack: string | null;
      context: Record<string, unknown> | null;
    }): Promise<unknown>;
  };
}

/** Shapes anything throwable. `throw "string"` is legal and reaches handlers as a string. */
export function describeError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}`, stack: err.stack ?? null };
  }
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

/**
 * Report one error. Never throws, never rejects.
 *
 * A reporter that can fail turns one bug into two, and the second arrives with no reporter
 * left to record it. Every path here swallows.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  const { message, stack } = describeError(err);
  console.error("[renderer]", message, stack ?? "");

  try {
    const host =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { host?: LogBridge }).host;
    void host?.log
      ?.write({
        level: "error",
        // Capped here as well as in the contract schema. The schema is the boundary that
        // matters, but rejecting at the boundary would lose the report entirely — truncating
        // first means a 5000-character message still arrives, shortened.
        message: message.slice(0, 4_000),
        stack: stack === null ? null : stack.slice(0, 16_000),
        context: {
          ...(context ?? {}),
          // The route is the single most useful field for reproducing a renderer bug, and it
          // is the one thing a stack trace never contains.
          route: typeof window === "undefined" ? null : window.location.pathname,
        },
      })
      .catch(() => {});
  } catch {
    // No host, a revoked bridge, a serialisation edge. The console line above already ran.
  }
}

/**
 * Catch what nothing else does: errors outside React, and rejected promises with no handler.
 *
 * React's error boundary covers render and lifecycle. It does not cover an event handler, a
 * `setTimeout`, or a `fetch().then()` that rejects — all of which are ordinary in this app and
 * all of which are invisible today. These two listeners are the floor under everything.
 *
 * Returns its own teardown, and is idempotent: React 18 mounts effects twice in development,
 * and a second install would report every error twice.
 */
let installed = false;

export function installErrorReporting(): () => void {
  if (typeof window === "undefined" || installed) return () => {};
  installed = true;

  const onError = (event: ErrorEvent) => {
    reportError(event.error ?? event.message, {
      kind: "window.onerror",
      // Where in the bundle, which survives even when `event.error` is a bare string.
      source: `${event.filename}:${event.lineno}:${event.colno}`,
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    reportError(event.reason, { kind: "unhandledrejection" });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = false;
  };
}

/** Test seam: the module-level guard would otherwise leak between cases. */
export function __resetErrorReporting(): void {
  installed = false;
}
