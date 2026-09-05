"use client";

import { useEffect, useRef, useState } from "react";
import { getVisualization } from "@/lib/visualizations";
import { useShouldReduceMotion } from "@/lib/hooks/useShouldReduceMotion";
import { cn } from "@/lib/utils";
import { BoxViz, MatrixViz, TokenViz, VectorViz } from "./renderers";

const STEP_MS = 2600;

/**
 * The Visualize tab.
 *
 * WHAT IT REPLACED
 *
 * A tab labelled "Slide" that rendered "No slides available" on every problem —
 * a permanently empty placeholder occupying a third of the most valuable panel
 * in the workspace.
 *
 * WHY IT IS THE DEFAULT TAB
 *
 * You arrive at a problem before you have run anything, so Test Case and
 * Execution both open empty. This is the only one of the three with something
 * to say on arrival, and what it says — what the transformation actually does
 * to the numbers — is precisely what a paragraph of description is worst at.
 *
 * IT DOES NOT AUTOPLAY BY DEFAULT.
 *
 * A panel that starts moving the moment a page loads competes with the problem
 * statement someone is trying to read. Play is one click, and the step controls
 * work without it. Under `prefers-reduced-motion` autoplay is refused outright:
 * `useShouldReduceMotion` gates the timer, so pressing play advances nothing and
 * the prev/next controls remain the way through.
 */
export default function VisualizationPanel({
  problemSlug,
}: {
  problemSlug?: string;
}) {
  /* KEYED BY SLUG so navigating between problems remounts this and resets the
     step index. An effect that reset it instead could run a render late,
     leaving the index past the end of a shorter problem's steps — which
     renders nothing at all. A key cannot get out of step. */
  return <Stepper key={problemSlug ?? "none"} problemSlug={problemSlug} />;
}

function Stepper({ problemSlug }: { problemSlug?: string }) {
  const visualization = getVisualization(problemSlug);
  const reduceMotion = useShouldReduceMotion();

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const total = visualization?.steps.length ?? 0;

  useEffect(() => {
    if (!playing || reduceMotion || total === 0) return;

    timer.current = setInterval(() => {
      setIndex((prev) => {
        // Stop at the end rather than looping. A loop makes it impossible to
        // sit on the final state, which is usually the answer.
        if (prev >= total - 1) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, STEP_MS);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, reduceMotion, total]);

  const go = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(total - 1, next)));
  };

  if (!visualization) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-8 text-center">
        <p className="text-xs text-ink-2">No walkthrough for this problem yet</p>
        <p className="max-w-[40ch] text-[11px] leading-relaxed text-ink-3">
          The description and examples cover it. Ask the tutor for the approach
          if you want it worked through.
        </p>
      </div>
    );
  }

  const step = visualization.steps[index];
  const atEnd = index >= total - 1;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-baseline justify-between gap-4 px-4 pb-3 pt-4">
        <p className="text-[11px] font-medium text-ink">{visualization.title}</p>
        <span className="flex-shrink-0 font-mono text-[10px] tabular-nums text-ink-3">
          {index + 1}/{total}
        </span>
      </div>

      {/* ── Stage ────────────────────────────────────────────── */}
      {/* Indexed inside each branch rather than once above, so the discriminant
          on `visualization` narrows `steps` to the matching step type. Pulling
          `steps[index]` out first leaves it as the full union and every
          renderer rejects it. */}
      <div className="min-h-0 flex-1 overflow-auto px-4">
        <div className="flex min-h-full items-center">
          {visualization.kind === "vector" && (
            <VectorViz step={visualization.steps[index]} />
          )}
          {visualization.kind === "matrix" && (
            <MatrixViz step={visualization.steps[index]} />
          )}
          {visualization.kind === "tokens" && (
            <TokenViz step={visualization.steps[index]} />
          )}
          {visualization.kind === "boxes" && (
            <BoxViz step={visualization.steps[index]} />
          )}
        </div>
      </div>

      {/* ── Caption ──────────────────────────────────────────── */}
      {/* `aria-live` because the visual change is meaningless without it — the
          caption IS the content for anyone not watching the cells move. */}
      <div
        aria-live="polite"
        className="flex-shrink-0 border-t border-line px-4 py-3"
      >
        <p className="text-xs leading-relaxed text-ink">{step.caption}</p>
        {step.detail && (
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-3">
            {step.detail}
          </p>
        )}
      </div>

      {/* ── Controls ─────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-line bg-ide-bar px-3 py-2">
        <button
          type="button"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          title="Previous step"
          aria-label="Previous step"
          className={CONTROL}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => {
            if (atEnd) {
              // Replay from the start rather than doing nothing at the end.
              setIndex(0);
              setPlaying(!reduceMotion);
            } else {
              setPlaying((p) => !p);
            }
          }}
          disabled={reduceMotion && !atEnd}
          title={
            reduceMotion
              ? "Autoplay is off because your system prefers reduced motion — use the step controls"
              : atEnd
                ? "Replay"
                : playing
                  ? "Pause"
                  : "Play"
          }
          aria-label={atEnd ? "Replay" : playing ? "Pause" : "Play"}
          className={CONTROL}
        >
          {atEnd ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M10 6a4 4 0 1 1-1.2-2.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M9.2 1.2v2.4H6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : playing ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <rect x="3" y="2.5" width="2" height="7" rx="0.6" fill="currentColor" />
              <rect x="7" y="2.5" width="2" height="7" rx="0.6" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M3.5 2.4l6 3.6-6 3.6V2.4z" fill="currentColor" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={() => go(index + 1)}
          disabled={atEnd}
          title="Next step"
          aria-label="Next step"
          className={CONTROL}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Scrubber. Each step is a button rather than a range input so the
            steps stay individually reachable by keyboard and announce their
            position, which a slider over five discrete states does not. */}
        <div className="ml-1 flex flex-1 items-center gap-1">
          {visualization.steps.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => go(i)}
              aria-label={`Step ${i + 1} of ${total}`}
              aria-current={i === index ? "step" : undefined}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors duration-200 ease-void",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-ide-bar",
                i === index
                  ? "bg-ink"
                  : i < index
                    ? "bg-ink-3"
                    : "bg-line-strong hover:bg-ink-3"
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const CONTROL = cn(
  "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md",
  "text-ink-2 transition-colors duration-150 ease-void",
  "hover:bg-ide-raised hover:text-ink",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
  "focus-visible:ring-offset-2 focus-visible:ring-offset-ide-bar",
  "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-2"
);
