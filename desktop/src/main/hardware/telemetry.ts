/**
 * Live load, as distinct from the static profile `scan.ts` measures.
 *
 * `scan.ts` answers "what is this machine" and caches for 30 seconds because the answer does
 * not change. This answers "what is it doing right now", which changes constantly and is the
 * question you actually have before starting a 9 GB download onto a card already holding a
 * model.
 *
 * It inherits `scan.ts`'s governing rule without softening it: **every value here is measured
 * or absent.** A field that could not be read is `null`, never `0`. That distinction is the
 * whole reason this file is worth having rather than animating a plausible number — a gauge
 * reading 0% and a gauge reading "not reported" look nothing alike to a user deciding whether
 * they have room, and only one of them is true on an AMD card.
 *
 * What is measurable, and what is not:
 *
 * - **RAM** — `os.freemem()` against `os.totalmem()`. Real everywhere.
 * - **CPU** — `os.cpus()` returns cumulative tick counters, so a single reading is meaningless
 *   and the *difference* between two is the utilisation. That is why this module holds state.
 *   Real everywhere. `os.loadavg()` was the obvious alternative and is useless here: it
 *   returns `[0, 0, 0]` on Windows, which is the platform this runs on.
 * - **GPU utilisation and VRAM in use** — `nvidia-smi`, and only `nvidia-smi`. AMD, Intel and
 *   Apple report nothing comparable through any portable interface, so on those machines the
 *   GPU fields stay null and the UI says so rather than drawing an empty bar.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import type { TelemetrySample } from "../../shared/hardware-types.js";

/**
 * How often each half samples.
 *
 * The OS metrics are two array reads and cost nothing. `nvidia-smi` is a process spawn, and
 * `scan.ts` already documents that it can block for seconds on a machine with a sleeping
 * discrete GPU — so it runs a third as often and, more importantly, never overlaps itself.
 */
const OS_INTERVAL_MS = 1_000;
const GPU_EVERY_N_TICKS = 3;

/** Long enough for a sleeping GPU to wake, short enough not to wedge the poller. */
const NVIDIA_TIMEOUT_MS = 4_000;

interface CpuSnapshot {
  idle: number;
  total: number;
}

/**
 * Cumulative CPU ticks across all cores.
 *
 * `os.cpus()[].times` counts since boot, so utilisation is `1 - Δidle/Δtotal` between two
 * readings. A single reading gives the average since the machine started, which is a number
 * that looks plausible, never moves, and is not what anyone means by "CPU load".
 */
function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let previous: CpuSnapshot | undefined;

/** Test seam — the previous snapshot is module state and would leak between cases. */
export function __resetTelemetry(): void {
  previous = undefined;
  gpuInFlight = false;
  lastGpu = null;
  tick = 0;
}

/**
 * CPU busy fraction since the last call, or null on the first.
 *
 * Null rather than 0 for the first sample: there is no previous reading to difference
 * against, and reporting an idle CPU because we have not measured yet is the fabrication this
 * module exists to avoid. The UI shows one second of "—" and then real numbers.
 */
export function cpuBusyFraction(): number | null {
  const now = cpuSnapshot();
  const before = previous;
  previous = now;
  if (before === undefined) return null;

  const deltaTotal = now.total - before.total;
  const deltaIdle = now.idle - before.idle;
  // A zero delta means two reads inside one tick of the counter's resolution. Dividing would
  // give NaN or Infinity; not knowing is the honest answer for that interval.
  if (deltaTotal <= 0) return null;

  return clamp01(1 - deltaIdle / deltaTotal);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

interface GpuLoad {
  utilisation: number | null;
  vramUsedMB: number | null;
  vramTotalMB: number | null;
}

let gpuInFlight = false;
let lastGpu: GpuLoad | null = null;
let tick = 0;

/**
 * GPU load from nvidia-smi, reusing the last reading between polls.
 *
 * `gpuInFlight` is the load-bearing part. Without it a machine where nvidia-smi takes three
 * seconds would queue a new process every second and end up with three in flight, each
 * slower than the last — a poller that degrades the thing it is measuring. Skipping while one
 * is outstanding means the reading is occasionally a second stale, which is invisible, rather
 * than the alternative, which is not.
 */
function readGpu(): Promise<GpuLoad | null> {
  if (gpuInFlight) return Promise.resolve(lastGpu);
  gpuInFlight = true;

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { timeout: NVIDIA_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        gpuInFlight = false;
        if (err) {
          // No NVIDIA GPU, no driver, or the call timed out. All mean "cannot determine",
          // and a machine without one must not start reporting zeros.
          lastGpu = null;
          resolve(null);
          return;
        }

        // First line only: a multi-GPU machine gets its primary adapter, matching the
        // largest-VRAM choice `useRuntimeStatus` already makes for the status bar.
        const parts = stdout.trim().split("\n")[0]?.split(",").map((p) => p.trim()) ?? [];
        const [util, used, total] = parts;
        const utilisation = Number(util);
        const usedMB = Number(used);
        const totalMB = Number(total);

        lastGpu = {
          utilisation: Number.isFinite(utilisation) ? clamp01(utilisation / 100) : null,
          vramUsedMB: Number.isFinite(usedMB) ? usedMB : null,
          vramTotalMB: Number.isFinite(totalMB) ? totalMB : null,
        };
        resolve(lastGpu);
      }
    );
  });
}

/**
 * One reading. Exported so a caller can sample without running a poller — the Models page
 * asks for one on mount rather than waiting a full interval for the first frame.
 */
export async function sampleTelemetry(includeGpu = true): Promise<TelemetrySample> {
  const totalMB = os.totalmem() / (1024 * 1024);
  const freeMB = os.freemem() / (1024 * 1024);
  const gpu = includeGpu ? await readGpu() : lastGpu;

  return {
    at: new Date().toISOString(),
    cpuBusy: cpuBusyFraction(),
    ramTotalMB: Math.round(totalMB),
    ramUsedMB: Math.round(totalMB - freeMB),
    gpuBusy: gpu?.utilisation ?? null,
    vramUsedMB: gpu?.vramUsedMB ?? null,
    vramTotalMB: gpu?.vramTotalMB ?? null,
  };
}

let timer: NodeJS.Timeout | undefined;

/**
 * Start pushing samples. Idempotent, and stops itself when the last listener goes.
 *
 * The poller only exists while something is watching: this is a desktop app that should be
 * idle when idle, and spawning nvidia-smi every three seconds forever so a status bar can
 * show a number nobody is looking at is exactly the kind of cost `useRuntimeStatus` refused
 * to pay when it chose not to poll at all.
 */
export function startTelemetry(emit: (sample: TelemetrySample) => void): void {
  if (timer !== undefined) return;

  // Prime the CPU counter so the first emitted sample a second from now has a delta to work
  // with, rather than being null for no reason the user can see.
  cpuBusyFraction();

  timer = setInterval(() => {
    tick += 1;
    void sampleTelemetry(tick % GPU_EVERY_N_TICKS === 0).then(emit, () => {
      // A failed sample is a skipped frame, not a reason to stop measuring.
    });
  }, OS_INTERVAL_MS);

  // Never hold the process open. Without this, quitting waits for the interval.
  timer.unref?.();
}

export function stopTelemetry(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

export function isTelemetryRunning(): boolean {
  return timer !== undefined;
}
