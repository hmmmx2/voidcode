"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { HardwareProfile } from "@shared/hardware-types";
import { formatGB, formatLoad, usedFraction, useTelemetry } from "@/lib/shell/useTelemetry";

/**
 * This machine: what it is and what it is doing, in one place.
 *
 * These were two cards, and most of the second was the first restated. "Live load" drew four
 * rings whose captions already named the CPU, the GPU, RAM used against total and VRAM used
 * against total; "This machine" then listed GPU, VRAM, free VRAM, system memory and CPU as a
 * definition list underneath. Four of its six fields were the ring captions with different
 * wording, and the two that were not — free disk and which backends are running — were
 * buried among them.
 *
 * So: the rings carry the measurements, and below them sit only the facts no ring shows.
 * Nothing was dropped; the duplication was.
 *
 * **Shapes are hand-written SVG; Framer moves them.** An arc is a `path` with a
 * `strokeDasharray`, and a charting library would draw the same geometry after taking a
 * scale-and-axis abstraction nothing here needs. What Framer is for is the transition:
 * samples land once a second and a spring reaches the new value in about that time.
 *
 * **`prefers-reduced-motion` is honoured.** Four animated rings on a page someone opens to
 * read a table is exactly what that setting is for. Reduced motion keeps every number and
 * drops every animation.
 *
 * **A null reading is drawn as absent, not as zero.** On a machine with no NVIDIA adapter the
 * GPU and VRAM rings have no value, and a ring at 0% claims an idle GPU. The ring stays as
 * its unfilled track and the caption says why.
 */

interface MachinePanelProps {
  profile: HardwareProfile;
  /** Re-read the hardware. Lives here because this is what it refreshes. */
  onRescan: () => void;
  scanning: boolean;
}

export default function MachinePanel({ profile, onRescan, scanning }: MachinePanelProps) {
  const sample = useTelemetry();

  // The largest, not the first: a machine with an integrated adapter beside a discrete card
  // lists both, and the discrete one is what will run the model.
  const gpu = [...profile.gpus].sort((a, b) => b.vramTotalMB - a.vramTotalMB)[0];

  const vramFree =
    sample?.vramUsedMB != null && sample.vramTotalMB != null
      ? sample.vramTotalMB - sample.vramUsedMB
      : null;

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-line bg-ide-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-3">This machine</h2>

        <div className="flex items-center gap-3">
          <p className="font-mono text-[11px] text-ink-3">
            {sample === undefined ? "waiting for the first sample…" : "live, once a second"}
          </p>

          {/*
            Scan sits with the numbers it refreshes rather than in the page hero.
            
            `scanHardware` caches for 30 seconds in main, so this is often not a fresh probe —
            what it is really for is picking up a change you just made: starting Ollama,
            closing a game that was holding VRAM, freeing disk.
          */}
          <button
            type="button"
            onClick={onRescan}
            disabled={scanning}
            title="Re-read this machine's hardware and recompute what fits"
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-60"
          >
            <motion.span
              aria-hidden
              className="inline-flex"
              animate={scanning ? { rotate: 360 } : { rotate: 0 }}
              transition={
                scanning ? { repeat: Infinity, duration: 1.1, ease: "linear" } : { duration: 0.2 }
              }
            >
              {/* Inline SVG rather than `⟳`, which is font-dependent and absent from some. */}
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3 w-3"
              >
                <path d="M13.6 6.8A5.8 5.8 0 1 0 13 10.4" />
                <path d="M13.9 2.9v3.9h-3.9" />
              </svg>
            </motion.span>
            {scanning ? "Scanning…" : "Scan hardware"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Ring
          label="CPU"
          fraction={sample?.cpuBusy ?? null}
          caption={profile.cpu.model}
          waiting={sample === undefined}
        />
        <Ring
          label="RAM"
          fraction={sample && usedFraction(sample.ramUsedMB, sample.ramTotalMB)}
          caption={
            sample === undefined
              ? `${formatGB(profile.ramTotalMB)} total`
              : `${formatGB(sample.ramUsedMB)} of ${formatGB(sample.ramTotalMB)}`
          }
          waiting={sample === undefined}
        />
        <Ring
          label="GPU"
          fraction={sample?.gpuBusy ?? null}
          caption={gpu?.name ?? "no adapter detected"}
          waiting={sample === undefined}
        />
        <Ring
          label="VRAM"
          fraction={sample && usedFraction(sample.vramUsedMB, sample.vramTotalMB)}
          caption={
            sample?.vramUsedMB != null && sample.vramTotalMB != null
              ? `${formatGB(sample.vramUsedMB)} of ${formatGB(sample.vramTotalMB)}`
              : gpu === undefined
                ? "no adapter detected"
                : "not reported by this adapter"
          }
          waiting={sample === undefined}
        />
      </div>

      {/*
        VRAM headroom in words, because it is the number the table below turns on.

        A ring communicates a proportion; "11.6 GB free" is what you compare against a
        download size. Only shown when it was measured.
      */}
      {vramFree !== null && (
        <p className="text-xs text-ink-3">
          <span className="text-ink-2">{formatGB(vramFree)} of VRAM free</span> right now. A model
          needs its weights and its context to fit in that, alongside whatever is already loaded.
        </p>
      )}

      {/*
        What no ring shows. Free disk gates the download rather than the run — a model can fit
        in VRAM perfectly and still not fit on the drive — and the backends decide whether
        anything can be downloaded at all.
      */}
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-line pt-4 text-xs">
        <Fact
          label="Free disk"
          // 0 means `statfs` failed, which is indistinguishable from a genuinely full disk.
          value={profile.diskFreeMB === 0 ? "could not be determined" : formatGB(profile.diskFreeMB)}
        />
        <Fact
          label="Backends"
          value={
            [
              profile.backends.ollama === undefined ? null : `Ollama ${profile.backends.ollama}`,
              profile.backends.llamaCpp === undefined ? null : "llama.cpp",
            ]
              .filter((entry): entry is string => entry !== null)
              .join(" · ") || "none running"
          }
        />
        {profile.unifiedMemory && <Fact label="Memory" value="unified" />}
      </dl>

      {/*
        Shown verbatim. These are the scanner's own sentences, written to be read — and its
        governing rule is that every value is measured or absent, so the absences are part of
        the answer rather than something to tidy away.
      */}
      {profile.unknowns.length > 0 && (
        <ul className="flex flex-col gap-1 text-[11px] text-ink-3">
          {profile.unknowns.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="font-mono text-ink-2">{value}</dd>
    </div>
  );
}

/** Circumference of the r=26 arc, kept beside the geometry it belongs to. */
const RADIUS = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({
  label,
  fraction,
  caption,
  waiting,
}: {
  label: string;
  /** `undefined` while no sample has arrived; `null` when this machine does not report it. */
  fraction: number | null | undefined;
  caption: string;
  waiting: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const value = fraction ?? null;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden>
          {/* The track is always drawn, so an unmeasured ring reads as empty rather than missing. */}
          <circle
            cx="36"
            cy="36"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            className="text-ide-raised"
          />
          {value !== null && (
            <motion.circle
              cx="36"
              cy="36"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="5"
              strokeLinecap="round"
              className="text-ink"
              // From twelve o'clock. The default start is three o'clock, which reads as an
              // arbitrary offset rather than a gauge.
              transform="rotate(-90 36 36)"
              strokeDasharray={CIRCUMFERENCE}
              initial={false}
              animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - value) }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : // Just under the one-second sample interval and critically damped: an
                    // overshoot would still be settling when the next value arrives, which
                    // reads as noise rather than as load.
                    { type: "spring", stiffness: 90, damping: 18, mass: 0.6 }
              }
            />
          )}
        </svg>

        <span className="absolute inset-0 flex items-center justify-center font-mono text-sm text-ink">
          {waiting ? "" : formatLoad(value)}
        </span>
      </div>

      <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">{label}</span>
        <span className="max-w-[12rem] truncate text-[11px] text-ink-3" title={caption}>
          {caption}
        </span>
      </div>
    </div>
  );
}
