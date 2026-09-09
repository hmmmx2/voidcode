"use client";

import { useEffect, useState } from "react";
import type { TelemetrySample } from "@shared/hardware-types";

/**
 * Live hardware load from main, roughly once a second.
 *
 * The counterpart to `useRuntimeStatus`, which deliberately does not poll — its docstring
 * says a timer probing a local daemon every few seconds costs more than it tells you, and
 * that is still true of *provider* status, which changes when you start Ollama and not
 * otherwise. Load is the opposite: it is only interesting while it moves.
 *
 * The cost is paid in main, once, and broadcast — so a second window subscribing does not
 * spawn a second `nvidia-smi`. Here it is a listener and a `useState`.
 *
 * **Nulls are passed through untouched.** A sample where `gpuBusy` is null means this machine
 * does not report GPU utilisation, which is every AMD, Intel and Apple machine, and a
 * consumer writing `?? 0` turns "not measured" into "idle" one level up from where main
 * carefully refused to. `formatLoad` below is the intended way to render one.
 */
export function useTelemetry(): TelemetrySample | undefined {
  const [sample, setSample] = useState<TelemetrySample | undefined>(undefined);

  useEffect(() => {
    const host = typeof window === "undefined" ? undefined : window.host;
    // Absent in the browser build and on a bare route. No fallback: an undefined sample
    // renders as nothing, which is correct when there is nothing measuring.
    return host?.onHardwareTelemetry?.((next) => setSample(next));
  }, []);

  return sample;
}

/** `0.16` → `"16%"`, `null` → `"—"`. Never `"0%"` for something that was not measured. */
export function formatLoad(fraction: number | null): string {
  if (fraction === null) return "—";
  return `${Math.round(fraction * 100)}%`;
}

/** `13699` → `"13.4 GB"`. Matches `formatVram`'s style so the bar reads consistently. */
export function formatGB(megabytes: number): string {
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/**
 * Used over total as a fraction, or null when either half is unknown.
 *
 * Separate from the formatters because a gauge needs the number and a label needs the words,
 * and computing it in two places is how they come to disagree.
 */
export function usedFraction(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, used / total));
}
