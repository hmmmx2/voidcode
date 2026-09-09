/**
 * The error log: one file, on disk, that survives the thing that went wrong.
 *
 * Before this the app caught plenty — `IpcError` codes, a broker catch-all, handler-level
 * guards — and sent all of it to `console.error`. In development that is a terminal. In a
 * packaged app there is no terminal, so every one of those messages went nowhere. "Something
 * broke" arrived with no way to find out what, which is the case this file exists for.
 *
 * Four decisions worth stating, because each is a trade rather than an obvious default:
 *
 * **JSONL, not prose.** One JSON object per line. Prose logs are pleasant until you want
 * every `E_HANDLER_FAILED` from one session, at which point you are writing a parser for
 * your own format. A line here survives `JSON.parse` independently, so a truncated final
 * write — the likely shape of a crash — costs that line and nothing before it.
 *
 * **Synchronous writes.** `appendFileSync` on every entry. Async is faster and loses the last
 * entry when the process dies, and the last entry is the one you opened the file for. The
 * volume here is errors, not telemetry, so the cost is a few milliseconds on a path that only
 * runs when something is already wrong.
 *
 * **Redacted by default.** The app holds provider API keys in a vault, and error paths are
 * exactly where secrets leak: a failed request logs its own config, an exception message
 * quotes the argument that broke it. `redact` runs over every entry.
 *
 * **Bounded.** Two files, capped. A log that grows forever is a disk-space bug that only
 * shows up on the machines least able to absorb it.
 */
import { app } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info";

/** Where the entry came from, so a renderer bug is not read as a main-process one. */
export type LogSource = "main" | "renderer" | "ipc";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  /** Present for anything thrown. This is the "where to fix it" half. */
  stack: string | null;
  /** Channel name, route, component — whatever narrows it down. */
  context: Record<string, unknown> | null;
}

/**
 * 2MB per file, one previous kept.
 *
 * Sized so a bad loop cannot fill a disk, and so the file still opens instantly in an editor
 * — a 200MB log is not a diagnostic, it is a second problem. Two files rather than one so a
 * burst of errors at startup cannot push out the original cause before anyone reads it.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_PREVIOUS = 1;

/**
 * Keys whose values never reach the file.
 *
 * Matched on the key, not the value: a value-based heuristic ("looks like a token") both
 * misses short keys and mangles innocent text. Substring and case-insensitive, so
 * `openaiApiKey`, `API_KEY` and `refresh_token` are all caught by the same three entries.
 */
const SECRET_KEYS = ["key", "token", "secret", "password", "authorization", "cookie"];

const REDACTED = "[redacted]";

/**
 * Depth-limited, cycle-safe, and it never throws.
 *
 * A logger that can throw while reporting an error turns one failure into two, and the second
 * one has no logger left to record it. Everything here degrades to a string instead.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" || typeof value === "function" ? String(value) : value;
  }
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    // Capped: an error carrying a 10k-element array should not become the whole log file.
    return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.some((needle) => key.toLowerCase().includes(needle))
      ? REDACTED
      : redact(item, depth + 1, seen);
  }
  return out;
}

/**
 * `app.getPath("logs")` when Electron is running, a temp dir when it is not.
 *
 * Tests import this module without an Electron app, and `getPath` throws there. Resolving
 * lazily rather than at import time is what lets the same module serve both.
 */
let overrideDir: string | undefined;

/** Test seam, in the spirit of `__setProjectRoot`. */
export function __setLogDir(dir: string | undefined): void {
  overrideDir = dir;
}

export function logDir(): string {
  if (overrideDir !== undefined) return overrideDir;
  return app.getPath("logs");
}

export function logFile(): string {
  return path.join(logDir(), "voidcode.log");
}

/**
 * Rotate before writing, not after.
 *
 * After-the-fact rotation lets one enormous entry land in an already-full file and only
 * notices next time. Checking first means the cap holds for every write except one that is
 * itself larger than the cap, which no entry here can be.
 */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet. Nothing to rotate.
  }
  if (size < MAX_BYTES) return;

  for (let i = KEEP_PREVIOUS; i >= 1; i -= 1) {
    const older = `${file}.${i}`;
    const newer = i === 1 ? file : `${file}.${i - 1}`;
    try {
      if (existsSync(newer)) renameSync(newer, older);
    } catch {
      // A locked file on Windows is not worth failing a log write over.
    }
  }
}

/**
 * The one write path.
 *
 * Wrapped end to end: if logging fails — read-only disk, missing permissions, a serialisation
 * edge — the app carries on. A crash inside the crash reporter is the worst possible failure
 * mode, because it replaces a diagnosable problem with an undiagnosable one.
 */
export function write(entry: Omit<LogEntry, "ts">): void {
  const line: LogEntry = {
    ts: new Date().toISOString(),
    level: entry.level,
    source: entry.source,
    message: entry.message,
    stack: entry.stack,
    context: entry.context === null ? null : (redact(entry.context) as Record<string, unknown>),
  };

  // Console too, and unconditionally: the file write below is wrapped, so a read-only disk
  // costs the file and not the message. In development this is also the faster read.
  const consoleLine = `[${line.source}] ${line.message}`;
  if (line.level === "error") console.error(consoleLine, line.stack ?? "");
  else if (line.level === "warn") console.warn(consoleLine);

  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const file = logFile();
    rotateIfNeeded(file);
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Deliberately silent. There is nowhere left to report this to.
  }
}

/**
 * Normalise anything throwable into a message and a stack.
 *
 * `throw "string"` and `throw {code: 1}` are both legal and both reach catch blocks, so
 * assuming `err instanceof Error` is how a logger ends up recording `undefined`.
 */
export function describe(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}`, stack: err.stack ?? null };
  }
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

export function logError(
  source: LogSource,
  err: unknown,
  context?: Record<string, unknown>
): void {
  const { message, stack } = describe(err);
  write({ level: "error", source, message, stack, context: context ?? null });
}

export function logInfo(
  source: LogSource,
  message: string,
  context?: Record<string, unknown>
): void {
  write({ level: "info", source, message, stack: null, context: context ?? null });
}
