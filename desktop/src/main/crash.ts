/**
 * The failures the logger could not see.
 *
 * `log.ts` records everything that reaches a `catch` in the main process, and `uncaughtException`
 * catches what escapes one. Neither can observe a process dying: when a renderer segfaults, when the
 * GPU process is killed, or when the Pyodide `utilityProcess` is OOM-killed mid-grade, **there is no
 * exception anywhere**. The process is simply gone, and the log for that launch ends mid-sentence.
 *
 * That is the one class of failure the logging was blind to, and it is the class users report as "it
 * just went white" or "the tests never finished" — the reports hardest to act on without a line.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR LINES IN index.ts ────────────────────────────────────────
 *
 * The two handlers that already existed were written inline at the top of `index.ts`, and are
 * consequently the only error-handling code in the main process with no test. Not by choice:
 * `index.ts` is the entry point, so importing it takes the single-instance lock, registers a
 * privileged scheme and calls `app.whenReady()`. There is nothing a test can hold.
 *
 * Moving all four into one module makes the set enumerable and each handler callable with a literal.
 * `installCrashHandlers()` is then the only thing `index.ts` needs to say, and it still says it at
 * module scope — see the comment on that function, because the position is load-bearing.
 */
import { app, crashReporter } from "electron";
import { logError, logInfo, write, type LogLevel } from "./log.js";

/**
 * Electron's reason union, shared by `RenderProcessGoneDetails` and `Details`.
 *
 * Written out rather than imported so the table below is a total function over it — `Record<K, V>`
 * with an imported union would still compile if Electron widened the union, and the new reason would
 * fall through to `undefined`. `tests/crash.test.ts` reads the union back out of
 * `electron.d.ts` and fails on an upgrade that adds one, which is the only way this stays honest.
 */
export type ProcessGoneReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "launch-failed"
  | "integrity-failure"
  | "memory-eviction";

/**
 * How loudly each reason is worth reporting.
 *
 * A table rather than `if (reason !== "clean-exit")`, because two of these are not failures and
 * logging them as errors would be its own defect. A log where every quit prints an error is a log
 * nobody reads, and the crash it was written for arrives in a wall of false ones.
 *
 *   - `clean-exit` — the process exited by itself with status zero. Normal.
 *   - `memory-eviction` — the OS reclaimed a background renderer. Recoverable and not our bug, but
 *     the user does see a blank panel, so it is worth a line at `warn`.
 *   - everything else — a crash, a kill, an OOM or a failure to launch at all.
 */
export const REASON_LEVEL: Record<ProcessGoneReason, LogLevel> = {
  "clean-exit": "info",
  "memory-eviction": "warn",
  "abnormal-exit": "error",
  killed: "error",
  crashed: "error",
  oom: "error",
  "launch-failed": "error",
  "integrity-failure": "error",
};

/** Any reason Electron adds that this build has not been taught is a failure, not a silence. */
function levelFor(reason: string): LogLevel {
  return REASON_LEVEL[reason as ProcessGoneReason] ?? "error";
}

interface GoneDetails {
  reason: string;
  exitCode: number;
}

/**
 * Origin and path only — no query, no fragment.
 *
 * The logger's redaction is matched on the **key** name, deliberately (`log.ts`: a value-based
 * "looks like a token" heuristic both misses short keys and mangles innocent text). `url` is not a
 * secret key, so a token in a query string would reach the file verbatim. That is not hypothetical
 * for this app: the OpenRouter flow puts a key in a URL, and a crash line is written from a code path
 * that never looks at what it is quoting.
 *
 * Nothing is lost. The question a crash line has to answer is *which page was open*, and for
 * `app://bundle/...` there is no query to begin with.
 */
function safeUrl(url: string | null): string | null {
  if (url === null || url === "") return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not parseable as a URL, so it is not a URL-shaped secret carrier either. Report the scheme
    // alone rather than a string of unknown provenance.
    return url.split("?")[0]?.split("#")[0] ?? null;
  }
}

/**
 * A renderer process died.
 *
 * `source: "renderer"` because that is the half to look in, and the URL because with two window
 * modes and a dozen routes "the renderer crashed" is not yet actionable. `webContents.getURL()` can
 * throw once the contents are destroyed — which by definition they are here — so the caller passes
 * whatever it could get and this takes `null`.
 */
export function onRenderProcessGone(details: GoneDetails, url: string | null): void {
  write({
    level: levelFor(details.reason),
    source: "renderer",
    message: `renderer process gone: ${details.reason}`,
    stack: null,
    context: { reason: details.reason, exitCode: details.exitCode, url: safeUrl(url) },
  });
}

/**
 * A child process died: GPU, network service, or one of ours.
 *
 * `source: "main"` rather than `"renderer"` — a utility process is not a renderer, and the source
 * field exists to point at a half of the app rather than to be decorative. `type` and `name` are
 * what distinguish "the GPU process was killed, the window is now software-rendered" from "the
 * Python sandbox is gone and grading will hang", and those want very different responses.
 */
export function onChildProcessGone(
  details: GoneDetails & { type: string; name?: string; serviceName?: string }
): void {
  write({
    level: levelFor(details.reason),
    source: "main",
    message: `child process gone: ${details.type} — ${details.reason}`,
    stack: null,
    context: {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name ?? null,
      serviceName: details.serviceName ?? null,
    },
  });
}

/**
 * An exception nobody caught.
 *
 * Neither this nor the rejection handler quits. An uncaught exception leaves the process in an
 * undefined state and the textbook answer is to exit, but this is an editor: quitting on a stray
 * rejection from a background model pull would throw away unsaved work to tidy up something the user
 * never noticed. Recording it and staying up is the better trade here, and the log is what turns
 * that into a decision rather than a silence.
 */
export function onUncaughtException(err: unknown): void {
  logError("main", err, { fatal: true, hint: "uncaughtException — app kept running" });
}

/**
 * A rejection nobody handled.
 *
 * Not narrowed to `Error`: rejecting with a string or a plain object is legal and common in library
 * code, and `describe` in the logger is what handles that.
 */
export function onUnhandledRejection(reason: unknown): void {
  logError("main", reason, { hint: "unhandledRejection" });
}

/** Where Crashpad writes minidumps. Reported at startup, because one nobody can find is not a diagnostic. */
export function crashDumpDir(): string | null {
  try {
    return app.getPath("crashDumps");
  } catch {
    // Before `whenReady` on some platforms, and never worth failing startup over.
    return null;
  }
}

let installed = false;

/**
 * Register everything, once.
 *
 * ── POSITION IS THE WHOLE POINT ───────────────────────────────────────────────────────────────
 *
 * Called at module scope in `index.ts`, not inside `onReady`. Inside `onReady` it would miss every
 * failure during startup — scheme registration, the single-instance lock, opening the database — and
 * those are exactly the failures that leave a user staring at an app that never appeared, with no
 * window to show an error in.
 *
 * `crashReporter.start` has the stricter version of the same requirement: it must run before any
 * child process exists, or those processes are not instrumented. One call in main is enough for the
 * whole tree in modern Electron — renderers, GPU and utility processes inherit it, which matters
 * here because every renderer is sandboxed and cannot start a reporter of its own.
 *
 * `uploadToServer: false` is not a placeholder. There is no server to upload to and there will not
 * be one: this app has no telemetry, `/privacy` says so in as many words, and a crash reporter that
 * posts minidumps would make that false. Minidumps stay in `crashDumps` for the user to send if they
 * choose to — which is also why the directory is named in the startup log line.
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  crashReporter.start({ uploadToServer: false });

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  app.on("render-process-gone", (_event, webContents, details) => {
    let url: string | null = null;
    try {
      url = webContents.getURL();
    } catch {
      // Destroyed contents throw; the crash is still worth the line without a URL.
    }
    onRenderProcessGone(details, url);
  });

  app.on("child-process-gone", (_event, details) => {
    onChildProcessGone(details);
  });

  /**
   * One line, before the "started" line.
   *
   * If a launch dies during startup, a log holding this and not "VoidCode … started" says the failure
   * is in between — and that the handlers were live when it happened, so the absence of a crash line
   * means something. The `crashDumps` path is reported by the started line instead, where `getPath` is
   * reliable; this runs before the app is ready.
   */
  logInfo("main", "crash handlers installed", { uploadToServer: false });
}

/** Test seam: the module-level `installed` latch would otherwise make the second test vacuous. */
export function __resetCrashHandlers(): void {
  installed = false;
}
