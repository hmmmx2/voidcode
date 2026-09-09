"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardData } from "@/lib/api/dashboard";

/**
 * Four numerals, hairline-divided.
 *
 * The strongest structural idea in the reference this design borrows from: big confident
 * numbers as the anchor, everything else quieter around them. What it does *not* borrow is
 * the orange — emphasis here is size and weight, which is how the rest of this app works.
 *
 * Every value is derived in main (`content/dashboard.ts`) so it can be tested; the streak in
 * particular has edge cases that lived in a React component where nothing could reach them.
 */

interface StatStripProps {
  data: DashboardData | null;
}

export default function StatStrip({ data }: StatStripProps) {
  const stats = data?.stats;
  if (stats === undefined) return null;

  /**
   * Nothing attempted means four zeros in a row, which is the same dead-object problem the
   * empty progress ring had: it reads as broken rather than as new. The strip earns its
   * space once there is something in it.
   */
  if (stats.attempts === 0 && stats.solved === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-4">
      <Stat label="Solved" value={stats.solved} />
      <Stat label="Day streak" value={stats.streakDays} />
      <Stat label="Attempts" value={stats.attempts} />
      {/* Absent until something has run — a 0% on a fresh install would read as failure
          rather than as "not started". */}
      <Stat label="Cases passing" value={stats.caseRate} suffix="%" />
    </dl>
  );
}

function Stat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | undefined;
  suffix?: string;
}) {
  const shown = useCountUp(value);

  return (
    <div className="bg-void-1 px-5 py-4">
      {/* `tabular-nums` is not cosmetic here: without it the digits change width as the
          count-up runs and the whole row jitters. */}
      <dd className="text-2xl font-light tracking-tight text-ink tabular-nums">
        {value === undefined ? "—" : `${shown}${suffix ?? ""}`}
      </dd>
      <dt className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
    </div>
  );
}

/**
 * Count from zero on mount.
 *
 * `requestAnimationFrame` rather than a CSS animation because the *text* changes, not a
 * style — there is nothing for keyframes to interpolate. Cubic ease-out so it decelerates
 * into the real figure instead of stopping dead.
 *
 * Returns the target immediately under `prefers-reduced-motion`: this is decoration on a
 * number that is already legible, so it is the first thing to drop.
 */
function useCountUp(target: number | undefined, durationMs = 900): number {
  const [shown, setShown] = useState(0);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (target === undefined) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(target);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / durationMs, 1);
      setShown(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);

    // Cancelled on unmount and on a changed target, so a navigation mid-count does not leave
    // a frame callback writing into an unmounted component.
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [target, durationMs]);

  return shown;
}
