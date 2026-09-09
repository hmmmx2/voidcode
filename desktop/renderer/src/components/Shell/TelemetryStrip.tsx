"use client";

import { useRouter } from "next/navigation";
import { formatGB, formatLoad, usedFraction, useTelemetry } from "@/lib/shell/useTelemetry";

/**
 * Live load in the status bar: CPU, RAM, GPU, VRAM.
 *
 * Constrained by where it lives. The bar is 22px and its docstring calls it the quietest
 * strip on screen — "metadata in ink-3, nothing clickable that is not obviously a control, no
 * colour except the readiness dot". So these are 3px tracks in `ink-3`, no colour at all, and
 * the whole group is one button rather than four, because four adjacent hover targets in a
 * 22px strip is a worse experience than one.
 *
 * A gauge with no reading shows `—` and an empty track, never a full-width zero. That is the
 * same rule main enforces on the sample and the reason it is worth carrying all the way here:
 * on a machine with no NVIDIA adapter, GPU and VRAM have no number, and a 0% bar would be
 * telling the user their GPU is idle when nothing has looked at it.
 */

export default function TelemetryStrip() {
  const sample = useTelemetry();
  const router = useRouter();

  // Nothing measuring — the browser build, or before the first sample lands. Rendering
  // placeholder gauges would put four dashes in the bar for a second on every launch.
  if (sample === undefined) return null;

  const ram = usedFraction(sample.ramUsedMB, sample.ramTotalMB);
  const vram = usedFraction(sample.vramUsedMB, sample.vramTotalMB);

  return (
    <button
      type="button"
      onClick={() => router.push("/models")}
      title={[
        `CPU ${formatLoad(sample.cpuBusy)}`,
        `RAM ${formatGB(sample.ramUsedMB)} of ${formatGB(sample.ramTotalMB)}`,
        sample.gpuBusy === null
          ? "GPU load not reported on this machine"
          : `GPU ${formatLoad(sample.gpuBusy)}`,
        sample.vramUsedMB === null || sample.vramTotalMB === null
          ? "VRAM not reported on this machine"
          : `VRAM ${formatGB(sample.vramUsedMB)} of ${formatGB(sample.vramTotalMB)}`,
        "",
        "Open the model manager",
      ].join("\n")}
      className="hidden items-center gap-2.5 rounded px-1 transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink md:flex"
    >
      <Gauge label="CPU" fraction={sample.cpuBusy} />
      <Gauge label="RAM" fraction={ram} />
      <Gauge label="GPU" fraction={sample.gpuBusy} />
      <Gauge label="VRAM" fraction={vram} />
    </button>
  );
}

/**
 * One metric: a label, a track, and a number.
 *
 * `transition-[width]` rather than a spring. Samples arrive on a one-second interval, so a
 * CSS transition just under that reads as the bar moving continuously; anything with
 * overshoot would have the gauge still settling when the next value arrives, which looks
 * like noise rather than load.
 */
function Gauge({ label, fraction }: { label: string; fraction: number | null }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-ink-3">{label}</span>
      <span aria-hidden className="relative h-[3px] w-8 overflow-hidden rounded-full bg-ide-raised">
        {/*
          Nothing at all when there is no reading — not a zero-width bar, which is the same
          pixels but a different claim. The `—` beside it is what says why.
        */}
        {fraction !== null && (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-ink-2 transition-[width] duration-700 ease-void"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        )}
      </span>
      {/* Tabular width so the strip does not jitter as digits change. */}
      <span className="w-7 text-right font-mono text-ink-3">{formatLoad(fraction)}</span>
    </span>
  );
}
