/**
 * Live load, and the difference between "zero" and "not measured".
 *
 * Every guard here defends the same property, which is the only reason this module is worth
 * having rather than animating a plausible number: **a value that could not be read is null.**
 * A gauge at 0% and a gauge reading "not reported" look nothing alike to someone deciding
 * whether a 9 GB model will fit, and on an AMD card only one of them is true.
 *
 * The CPU half has a second property that is easy to get wrong and invisible when you do:
 * `os.cpus()` returns counters cumulative since boot, so a single reading is the average
 * since the machine started. It looks plausible, it never moves, and it is not CPU load.
 * Utilisation is the *difference* between two readings, which is why this module holds state
 * and why the first sample must be null.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";

/**
 * `execFile` is mocked at the module boundary so the nvidia-smi *failure* path is reachable.
 *
 * It has to be: the machine these tests run on has a working nvidia-smi, so every unmocked
 * call succeeds and the "no NVIDIA adapter" branch — the one that must return null rather
 * than zero, and the whole reason this module is trustworthy on AMD and Apple — is never
 * executed. A mutation replacing those nulls with zeros passed the entire suite before this
 * mock existed.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import {
  __resetTelemetry,
  cpuBusyFraction,
  isTelemetryRunning,
  sampleTelemetry,
  startTelemetry,
  stopTelemetry,
} from "../src/main/hardware/telemetry.js";

/** A cpus() fixture whose totals we control, so the arithmetic is checkable. */
function cpus(idle: number, busy: number): os.CpuInfo[] {
  return [
    {
      model: "test",
      speed: 1,
      times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
    },
  ];
}

/** Make the next nvidia-smi call fail the way a machine without one does. */
function nvidiaMissing(): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(new Error("ENOENT: nvidia-smi not found"), "", "");
  });
}

/** Make it succeed with a known reading. */
function nvidiaReports(line: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, line + String.fromCharCode(10), "");
  });
}

beforeEach(() => {
  __resetTelemetry();
  execFileMock.mockReset();
  nvidiaMissing();
});

afterEach(() => {
  stopTelemetry();
  vi.restoreAllMocks();
  __resetTelemetry();
});

describe("CPU utilisation is a difference, not a reading", () => {
  it("returns null for the first sample", () => {
    // There is no previous counter to difference against. Reporting an idle CPU because we
    // have not measured yet is the fabrication this module exists to avoid.
    expect(cpuBusyFraction()).toBeNull();
  });

  it("computes busy fraction from the delta between two readings", () => {
    const spy = vi.spyOn(os, "cpus");
    spy.mockReturnValue(cpus(1000, 1000)); // total 2000, idle 1000
    expect(cpuBusyFraction()).toBeNull();

    // 500 more ticks, 100 of them idle → 80% busy over the interval.
    spy.mockReturnValue(cpus(1100, 1400)); // total 2500, idle 1100
    expect(cpuBusyFraction()).toBeCloseTo(0.8, 5);
  });

  it("reports the interval, not the average since boot", () => {
    /**
     * THE mutation. Using `1 - idle/total` on a single reading instead of on the delta gives
     * a number that is plausible, stable, and wrong — here the machine has been 50% busy
     * since boot but is 100% busy right now, and only the delta says so.
     */
    const spy = vi.spyOn(os, "cpus");
    spy.mockReturnValue(cpus(1000, 1000)); // 50% since boot
    cpuBusyFraction();

    spy.mockReturnValue(cpus(1000, 1100)); // 100 busy ticks, 0 idle, since last read
    expect(cpuBusyFraction()).toBeCloseTo(1, 5);
  });

  it("returns null when two reads land inside one counter tick", () => {
    // Dividing by a zero delta gives NaN or Infinity. Not knowing is the honest answer for
    // that interval, and a NaN reaching a width style silently renders nothing.
    const spy = vi.spyOn(os, "cpus");
    spy.mockReturnValue(cpus(1000, 1000));
    cpuBusyFraction();
    expect(cpuBusyFraction()).toBeNull();
  });

  it("clamps into 0..1", () => {
    const spy = vi.spyOn(os, "cpus");
    spy.mockReturnValue(cpus(1000, 1000));
    cpuBusyFraction();
    // Counters that appear to go backwards — a suspend/resume, or a core coming online — must
    // not produce a negative width.
    spy.mockReturnValue(cpus(2000, 1000));
    const value = cpuBusyFraction();
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThanOrEqual(0);
    expect(value!).toBeLessThanOrEqual(1);
  });
});

describe("a sample", () => {
  it("measures RAM in use, not just total", () => {
    // `scan.ts` already reported ramTotalMB and nothing else; used is the half that answers
    // "is there room".
    const spy = vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 * 1024 * 1024);
    const free = vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 * 1024 * 1024);

    return sampleTelemetry(false).then((sample) => {
      expect(sample.ramTotalMB).toBe(32768);
      expect(sample.ramUsedMB).toBe(24576);
      spy.mockRestore();
      free.mockRestore();
    });
  });

  it("carries a timestamp", async () => {
    const sample = await sampleTelemetry(false);
    expect(sample.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports null rather than zero when nvidia-smi is absent", async () => {
    /**
     * THE property, exercised through the real failure path.
     *
     * The earlier version of this test passed `includeGpu: false`, which skips the call
     * entirely — so it asserted nulls without ever running the code that produces them, and a
     * mutation turning those nulls into zeros passed. This drives the branch a machine
     * without an NVIDIA adapter actually takes.
     */
    nvidiaMissing();
    const sample = await sampleTelemetry(true);
    expect(sample.gpuBusy).toBeNull();
    expect(sample.vramUsedMB).toBeNull();
    expect(sample.vramTotalMB).toBeNull();
    // And RAM, which does not depend on the GPU, is still real.
    expect(sample.ramTotalMB).toBeGreaterThan(0);
  });

  it("parses a real nvidia-smi reading", async () => {
    nvidiaReports("16, 2100, 16311");
    const sample = await sampleTelemetry(true);
    // Percent in, fraction out — a UI multiplying by 100 again would show 1600%.
    expect(sample.gpuBusy).toBeCloseTo(0.16, 5);
    expect(sample.vramUsedMB).toBe(2100);
    expect(sample.vramTotalMB).toBe(16311);
  });

  it("returns null for a field nvidia-smi reported as unparseable", async () => {
    // "[N/A]" is what it prints for a metric the driver does not expose on that adapter.
    nvidiaReports("[N/A], 2100, 16311");
    const sample = await sampleTelemetry(true);
    expect(sample.gpuBusy).toBeNull();
    expect(sample.vramUsedMB).toBe(2100);
  });

  it("never runs two nvidia-smi calls at once", async () => {
    /**
     * `scan.ts` documents that nvidia-smi can block for seconds on a machine with a sleeping
     * discrete GPU. Without the in-flight guard, a three-second call on a one-second poll
     * queues a new process every tick and ends up with three outstanding, each slower than
     * the last — a poller that degrades the thing it is measuring.
     *
     * Skipping while one is outstanding means the reading is occasionally a second stale,
     * which is invisible. The alternative is not.
     */
    let resolveCall: (() => void) | undefined;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      // Hang, the way a sleeping GPU does, until this test lets it finish.
      resolveCall = () => cb(null, "16, 2100, 16311" + String.fromCharCode(10), "");
    });

    const first = sampleTelemetry(true);
    const second = sampleTelemetry(true);
    const third = sampleTelemetry(true);

    expect(execFileMock).toHaveBeenCalledTimes(1);

    resolveCall?.();
    await Promise.all([first, second, third]);
  });

  it("reuses the last reading while a call is outstanding", async () => {
    // The skipped polls must return the previous value rather than null, or the gauge blinks
    // to "not reported" every time a sample runs long.
    nvidiaReports("42, 3000, 16311");
    await sampleTelemetry(true);

    let pending: (() => void) | undefined;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      pending = () => cb(null, "50, 4000, 16311" + String.fromCharCode(10), "");
    });

    const slow = sampleTelemetry(true);
    const whileBusy = await sampleTelemetry(true);
    expect(whileBusy.gpuBusy).toBeCloseTo(0.42, 5);

    pending?.();
    await slow;
  });

  it("takes the first adapter on a multi-GPU machine", async () => {
    nvidiaReports(["16, 2100, 16311", "88, 9000, 24576"].join(String.fromCharCode(10)));
    const sample = await sampleTelemetry(true);
    expect(sample.vramTotalMB).toBe(16311);
  });

  it("skips GPU fields when not asked, without inventing them", async () => {
    /**
     * The property the whole module turns on. On a machine with no NVIDIA adapter — which is
     * every AMD, Intel and Apple machine — these must be null so the UI can say "not
     * reported". Zero would draw an idle GPU with free VRAM, which is a claim about hardware
     * nobody measured.
     *
     * `includeGpu: false` is the reliable way to exercise the no-reading path on a machine
     * that does happen to have nvidia-smi, which is the one these tests run on.
     */
    const sample = await sampleTelemetry(false);
    expect(sample.gpuBusy).toBeNull();
    expect(sample.vramUsedMB).toBeNull();
    expect(sample.vramTotalMB).toBeNull();
  });

  it("keeps every load field nullable in the type as well as at runtime", async () => {
    // A caller doing `sample.gpuBusy ?? 0` reintroduces the lie one level up; keeping the
    // nulls in the shape is what forces that decision to be made visibly.
    const sample = await sampleTelemetry(false);
    for (const key of ["cpuBusy", "gpuBusy", "vramUsedMB", "vramTotalMB"] as const) {
      expect(sample[key] === null || typeof sample[key] === "number").toBe(true);
    }
  });
});

describe("the poller", () => {
  it("starts once and stops", () => {
    expect(isTelemetryRunning()).toBe(false);
    startTelemetry(() => {});
    expect(isTelemetryRunning()).toBe(true);

    // Idempotent: a second window subscribing must not create a second interval, each
    // spawning its own nvidia-smi.
    startTelemetry(() => {});
    expect(isTelemetryRunning()).toBe(true);

    stopTelemetry();
    expect(isTelemetryRunning()).toBe(false);
  });

  it("primes the CPU counter at start", () => {
    /**
     * Otherwise the first emitted sample a second later is null for a reason nobody watching
     * a gauge could work out.
     *
     * The counter has to be driven to test this. Calling `cpuBusyFraction()` immediately
     * after `startTelemetry` returns null whether or not priming happened — two reads inside
     * one tick have a zero delta, which is null by design — so an unmocked version of this
     * test passes against both the fix and the bug.
     */
    const spy = vi.spyOn(os, "cpus");
    spy.mockReturnValue(cpus(1000, 1000));
    startTelemetry(() => {});

    // If start had not primed, this would be the *first* reading and therefore null.
    spy.mockReturnValue(cpus(1100, 1400));
    expect(cpuBusyFraction()).toBeCloseTo(0.8, 5);
  });

  it("emits real samples on its interval", async () => {
    const seen: number[] = [];
    startTelemetry((sample) => seen.push(sample.ramUsedMB));
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    stopTelemetry();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    // RAM in use on a running machine is never zero; a zero here means the sample is a
    // default rather than a measurement.
    for (const used of seen) expect(used).toBeGreaterThan(0);
  }, 10_000);

  it("stops emitting once stopped", async () => {
    let count = 0;
    startTelemetry(() => {
      count += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    stopTelemetry();
    const after = count;

    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(count).toBe(after);
  }, 10_000);
});
