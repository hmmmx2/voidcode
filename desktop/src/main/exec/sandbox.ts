/**
 * The Tier A execution sandbox: Pyodide in a `utilityProcess`.
 *
 * Why its own process rather than a renderer worker or main:
 *
 *   - Pyodide is synchronous once `runPython` starts. In main that would freeze
 *     every window; in the renderer it would freeze the UI it is reporting into.
 *   - A hard timeout is implementable by killing a process. There is no reliable way
 *     to interrupt a blocking `runPython` from the same thread, so the host's
 *     timeout strategy depends on this isolation (see `host.ts`).
 *   - It has no `contextBridge`, no window, and nothing exposed to the renderer.
 *
 * What makes this a real sandbox is Pyodide, not this file: WASM linear memory, no
 * sockets, no host filesystem. The import allowlist layered on top is pedagogical
 * (spec §1.5) — see `runtime/bootstrap.py`.
 */
import path from "node:path";
import bootstrapSource from "./runtime/bootstrap.py?raw";
import type {
  ExecRequest,
  ExecResult,
  ExecCaseResult,
  SandboxCommand,
  SandboxEvent,
  ExecOutcome,
} from "./protocol.js";
import { MB } from "./protocol.js";

/**
 * A `utilityProcess` child talks over `process.parentPort` — not a bare `parentPort`
 * global, which is the `worker_threads` spelling and fails here with a bare
 * ReferenceError at module load.
 */
const parentPort = process.parentPort as unknown as {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: { data: SandboxCommand }) => void): void;
};

/**
 * Pyodide's own types, rather than a hand-rolled shape.
 *
 * A local interface looked tidier but drifts: it silently disagreed with the real
 * `globals: PyProxy` and the mismatch only surfaced as an unrelated-looking cast
 * error. Using the published type means a Pyodide upgrade that changes an API breaks
 * the typecheck, which is the point.
 */
type Pyodide = import("pyodide").PyodideInterface;

/** `_module` is Pyodide-internal; see `heapBytes` for why it is reached for. */
type PyodideWithModule = Pyodide & { _module?: { HEAP8?: { byteLength: number } } };

let pyodide: PyodideWithModule | undefined;
let bootstrap: Record<string, (...args: unknown[]) => unknown> | undefined;
/** Packages already loaded into this interpreter, so we never pay for them twice. */
const loaded = new Set<string>();
/** Heap at boot, before any package. Reported for context, not used as a limit. */
let baselineHeapBytes = 0;
/** Heap immediately before the current run's user code. The limit is measured here. */
let preRunHeapBytes = 0;

function send(event: SandboxEvent): void {
  parentPort.postMessage(event);
}

/**
 * Total bytes of WASM linear memory, or the closest honest proxy.
 *
 * `_module.HEAP8` is Pyodide-internal and may vanish across versions, so there is a
 * documented fallback: `arrayBuffers` from `process.memoryUsage()` counts backing
 * stores for ArrayBuffers, and WASM memory is one. The fallback over-reports (it
 * includes any other ArrayBuffer in the process) which is the right direction for a
 * limit check — it fails safe.
 */
function heapBytes(): number {
  const direct = pyodide?._module?.HEAP8?.byteLength;
  if (typeof direct === "number" && direct > 0) return direct;
  return process.memoryUsage().arrayBuffers;
}

async function boot(): Promise<void> {
  const startedAt = Date.now();

  // Resolved at runtime rather than bundled: Pyodide ships a .wasm and a stdlib zip
  // that must stay on disk as files.
  const { loadPyodide } = await import("pyodide");

  pyodide = (await loadPyodide({
    indexURL: pyodideIndexURL(),
    // Wheels are vendored at build time by `scripts/vendor-pyodide.mjs`. With this
    // populated, a run never touches the network — which is the offline guarantee
    // in spec §4.4, not a nicety.
    packageCacheDir: vendorDir(),
    // Pyodide's loader logs "attempting to load from cdn..." on a cache miss. Route
    // it to stderr so a miss is visible in logs instead of silently going online.
    stderr: (line: string) => console.error(`[sandbox:py] ${line}`),
  })) as PyodideWithModule;

  pyodide.runPython(bootstrapSource);
  bootstrap = pyodide.pyimport("__main__") as unknown as typeof bootstrap;

  baselineHeapBytes = heapBytes();
  send({ kind: "ready", coreLoadMs: Date.now() - startedAt });
}

function pyodideIndexURL(): string {
  // In a packaged app the module sits inside app.asar.unpacked, because the .wasm
  // must be a real file. electron-builder is configured to unpack it.
  return path.join(path.dirname(require.resolve("pyodide")), "/");
}

function vendorDir(): string {
  return process.env.VOIDCODE_PYODIDE_PACKAGES ?? path.join(__dirname, "../pyodide-packages");
}

async function ensurePackages(allowed: string[]): Promise<string[]> {
  // Only load what this exercise permits. An exercise restricted to numpy should not
  // silently have scipy available — the allowlist would then be enforcing a rule the
  // interpreter contradicts.
  const wanted = allowed.filter((name) => KNOWN_PACKAGES.has(name) && !loaded.has(name));
  if (wanted.length > 0) {
    await pyodide!.loadPackage(wanted);
    for (const name of wanted) loaded.add(name);
  }
  return allowed.filter((name) => KNOWN_PACKAGES.has(name));
}

/** Pyodide-provided packages we are willing to load. Anything else is stdlib-only. */
const KNOWN_PACKAGES = new Set(["numpy", "scipy", "pandas", "scikit-learn", "sympy"]);

async function handleRun(request: ExecRequest): Promise<void> {
  const startedAt = Date.now();

  let raw: Record<string, unknown>;
  try {
    const preimport = await ensurePackages(request.allowedImports);
    (bootstrap!.prepare as (a: unknown, b: unknown) => void)(
      request.allowedImports,
      preimport
    );

    // Baseline here, not at boot. Loading numpy grows the WASM heap by ~13 MB, and
    // billing that to the learner would make a stated 64 MB budget quietly ~51 MB.
    // Measured from just before user code runs, the growth is theirs alone.
    preRunHeapBytes = heapBytes();

    const result = (
      bootstrap!.run as (a: unknown, b: unknown, c: unknown, d: unknown) => unknown
    )(
      request.source,
      request.entry,
      request.cases,
      // Empty string, not undefined: `undefined` crosses into Python as `None`, which is
      // falsy and would work by accident today but breaks the moment the default changes.
      request.normalise ?? ""
    );
    // Pyodide hands back a PyProxy for a dict; `toJs` gives plain JS.
    raw = toPlain(result);
  } catch (err) {
    send({
      kind: "result",
      result: crashedResult(request, Date.now() - startedAt, (err as Error).message),
    });
    return;
  }

  const wallMs = Date.now() - startedAt;
  const cases = (raw.cases as ExecCaseResult[] | undefined) ?? [];
  const slowestCaseMs = cases.reduce((max, c) => Math.max(max, c.elapsedMs ?? 0), 0);
  const wasmHeapBytes = heapBytes();

  let outcome = (raw.outcome as ExecOutcome) ?? "crashed";
  let limitBreached: "time" | "memory" | undefined;

  // Limits are judged host-side, after the fact, for Tier A.
  //
  // The time limit is checked against the slowest *case*, not the wall clock: wall
  // includes package loading and the process handoff, and billing a learner for our
  // interpreter startup would make the stated 200 ms budget a lie.
  if (outcome === "ran" && slowestCaseMs > request.timeLimitMs) {
    outcome = "timeout";
    limitBreached = "time";
  }

  const wasmGrowthBytes = Math.max(0, wasmHeapBytes - preRunHeapBytes);
  if (outcome === "ran" && wasmGrowthBytes > request.memoryLimitMb * MB) {
    outcome = "memory_exceeded";
    limitBreached = "memory";
  }

  send({
    kind: "result",
    result: {
      runId: request.runId,
      outcome,
      cases,
      stdout: (raw.stdout as string) ?? "",
      ...(raw.error !== undefined ? { error: raw.error as string } : {}),
      ...(raw.traceback !== undefined ? { traceback: raw.traceback as string } : {}),
      ...(limitBreached !== undefined ? { limitBreached } : {}),
      measurements: {
        wallMs,
        slowestCaseMs,
        pythonPeakBytes: (raw.pythonPeakBytes as number) ?? 0,
        wasmHeapBytes,
        wasmGrowthBytes,
      },
    },
  });
}

function crashedResult(request: ExecRequest, wallMs: number, message: string): ExecResult {
  return {
    runId: request.runId,
    outcome: "crashed",
    cases: [],
    stdout: "",
    error: message,
    measurements: {
      wallMs,
      slowestCaseMs: 0,
      pythonPeakBytes: 0,
      wasmHeapBytes: heapBytes(),
      wasmGrowthBytes: 0,
    },
  };
}

/** PyProxy -> plain JS, tolerating an already-plain object. */
function toPlain(value: unknown): Record<string, unknown> {
  const proxy = value as { toJs?: (opts: { dict_converter: unknown }) => unknown };
  if (typeof proxy?.toJs === "function") {
    return proxy.toJs({ dict_converter: Object.fromEntries }) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

parentPort.on("message", (message) => {
  const command = message.data;
  if (command.kind === "ping") {
    send({ kind: "pong" });
    return;
  }
  if (command.kind === "run") {
    void handleRun(command.request);
  }
});

boot().catch((err: Error) => {
  send({ kind: "fatal", message: `sandbox failed to boot: ${err.message}` });
});
