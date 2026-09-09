/**
 * Main-side owner of the Tier A sandbox process.
 *
 * One long-lived sandbox, because booting Pyodide and importing numpy costs roughly
 * 1.4 s + 1.7 s. Keeping the interpreter warm is the difference between Run feeling
 * instant and feeling broken.
 *
 * Timeout strategy: kill the process and start a fresh one.
 *
 * Pyodide's `runPython` blocks its thread, and nothing on that thread can interrupt
 * it — so a cooperative cancel is not available to us here. Pyodide does support an
 * interrupt buffer, but writing it requires a *second* thread inside the sandbox, and
 * a killed process is both simpler and unconditional: an infinite loop, a C-level
 * hang inside numpy, and a stack overflow all die the same way. The cost is one cold
 * start on the next run, paid only by a learner who just wrote an infinite loop.
 */
import { app, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import type {
  ExecRequest,
  ExecResult,
  SandboxCommand,
  SandboxEvent,
} from "./protocol.js";

interface Pending {
  request: ExecRequest;
  resolve(result: ExecResult): void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

let child: UtilityProcess | undefined;
let booting: Promise<void> | undefined;
let pending: Pending | undefined;

/**
 * Grace added to the caller's limit before the process is killed.
 *
 * The sandbox judges the per-case limit itself and reports a clean `timeout` with
 * per-case timings, which is far more useful than "we killed it". This deadline is
 * the backstop for the case where it cannot report — a genuine infinite loop. It has
 * to cover package loading on a cold interpreter, hence seconds rather than
 * milliseconds.
 */
const KILL_GRACE_MS = 10_000;

function sandboxEntry(): string {
  // Built as a separate rollup input alongside main.
  return path.join(__dirname, "exec-sandbox.js");
}

/**
 * Where the vendored Pyodide wheels live.
 *
 * Not `app.getAppPath()`. That is derived from the entry file's directory, so running
 * `electron out/main/index.js` reports `out/main` as the app root and the wheels are
 * looked for two directories below where they are. Resolving from `__dirname` is
 * unambiguous in both layouts.
 *
 * Getting this wrong does not fail loudly, which is why it is worth the care: Pyodide
 * silently falls back to a CDN, so the app appears to work on a developer's machine
 * and breaks on a user's with no network. The sandbox logs any such fetch to stderr
 * precisely so that failure is visible rather than invisible.
 */
function packagesDir(): string {
  // Packaged: copied by electron-builder's extraResources, outside the asar because
  // Pyodide reads these as real files.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "vendor", "pyodide-packages");
  }
  // Development: __dirname is desktop/out/main.
  return path.join(__dirname, "..", "..", "vendor", "pyodide-packages");
}

async function ensureChild(): Promise<void> {
  if (child !== undefined) return;
  if (booting !== undefined) return booting;

  booting = new Promise<void>((resolve, reject) => {
    const proc = utilityProcess.fork(sandboxEntry(), [], {
      // Nothing inherited except the one path the sandbox needs. A deliberately bare
      // environment: the sandbox has no business reading PATH, HOME, proxy settings
      // or anything else that could steer it outward.
      env: { VOIDCODE_PYODIDE_PACKAGES: packagesDir() },
      stdio: "pipe",
    });

    const onReady = (message: SandboxEvent) => {
      if (message.kind === "ready") {
        console.log(`[exec] sandbox ready in ${message.coreLoadMs}ms`);
        child = proc;
        booting = undefined;
        resolve();
      } else if (message.kind === "fatal") {
        booting = undefined;
        reject(new Error(message.message));
      }
    };

    proc.on("message", onReady);
    proc.on("message", onSandboxMessage);

    proc.stderr?.on("data", (chunk: Buffer) => {
      // Pyodide announces a CDN fetch here. Surfacing it matters: a cache miss means
      // the offline guarantee is broken and we want that loud, not swallowed.
      process.stderr.write(`[exec:stderr] ${chunk.toString()}`);
    });

    proc.on("exit", (code) => {
      child = undefined;
      // If a run was in flight, the process died under it. Report rather than
      // leaving the caller's promise dangling forever.
      if (pending !== undefined) {
        settle(timeoutResult(pending, `sandbox exited with code ${code}`, "crashed"));
      }
    });
  });

  return booting;
}

function onSandboxMessage(message: SandboxEvent): void {
  if (message.kind !== "result") return;
  if (pending === undefined) return;
  if (message.result.runId !== pending.request.runId) return; // stale, from a killed run
  settle(message.result);
}

function settle(result: ExecResult): void {
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  const { resolve } = pending;
  pending = undefined;
  resolve(result);
}

function timeoutResult(
  p: Pending,
  message: string,
  outcome: "timeout" | "crashed" | "cancelled"
): ExecResult {
  return {
    runId: p.request.runId,
    outcome,
    cases: [],
    stdout: "",
    error: message,
    ...(outcome === "timeout" ? { limitBreached: "time" as const } : {}),
    measurements: {
      wallMs: Date.now() - p.startedAt,
      slowestCaseMs: 0,
      pythonPeakBytes: 0,
      wasmHeapBytes: 0,
      wasmGrowthBytes: 0,
    },
  };
}

/** Kill the sandbox. The next run boots a fresh one. */
function recycle(): void {
  const proc = child;
  child = undefined;
  proc?.kill();
}

export async function runInSandbox(request: ExecRequest): Promise<ExecResult> {
  if (pending !== undefined) {
    // One run at a time. A second Run click supersedes rather than queues, because a
    // learner who clicks twice wants the current code, not both.
    cancelRun(pending.request.runId);
  }

  await ensureChild();

  return new Promise<ExecResult>((resolve) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      // Hard deadline. The sandbox is presumed wedged; kill it so the next run is
      // not queued behind a loop that never ends.
      const p = pending;
      recycle();
      if (p !== undefined) {
        settle(timeoutResult(p, `Exceeded ${p.request.timeLimitMs}ms and did not respond`, "timeout"));
      }
    }, request.timeLimitMs + KILL_GRACE_MS);

    pending = { request, resolve, timer, startedAt };

    const command: SandboxCommand = { kind: "run", request };
    child!.postMessage(command);
  });
}

/**
 * Abandon a run. The sandbox is recycled because it may still be executing.
 *
 * No longer exported. Its only outside caller was the `exec:cancel` handler, which could never
 * supply a runId that matched anything — see `cancelCurrentRun` below.
 */
function cancelRun(runId: string): void {
  if (pending?.request.runId !== runId) return;
  const p = pending;
  recycle();
  settle(timeoutResult(p, "Cancelled", "cancelled"));
}

/**
 * Abandon whatever is running, without naming it.
 *
 * The runId is not something a caller outside this module can know. `gradeSubmission` makes
 * two sandbox runs — the reference, then the learner's code — and mints a fresh id for each,
 * so there is no single id that identifies "the thing the user is waiting on". That is why
 * Stop could not be wired for so long: `cancelRun` demanded an id nothing could supply.
 *
 * Safe only because of the invariant at the top of `runInSandbox`: one run at a time. Whoever
 * owns the current operation owns the sandbox, so "the pending run" is unambiguous.
 *
 * Deliberately not exported to the IPC layer. `attempts.ts` is the only caller, and it checks
 * that the attempt asking is the one actually in flight — the staleness guard `cancelRun`'s
 * runId used to provide has moved up a level rather than been dropped.
 */
export function cancelCurrentRun(): void {
  if (pending === undefined) return;
  cancelRun(pending.request.runId);
}

/** Called on app quit so a live interpreter does not outlive the window. */
export function shutdownSandbox(): void {
  recycle();
}
