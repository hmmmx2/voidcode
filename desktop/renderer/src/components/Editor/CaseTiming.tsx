/**
 * A case's elapsed time, drawn against the budget it was allowed.
 *
 * "Passed" and "passed using 3ms of a 200ms budget" render identically as a tick, and they
 * are not the same result — the second one is a solution about to fail the moment the input
 * grows. The number alone does not fix that either: 0.032ms means nothing until you know what
 * it was measured against, which is why the bar and the denominator travel together.
 *
 * Both values are real. `elapsedMs` is measured in the sandbox per case and `timeLimitMs` is
 * the problem's own budget, carried on the grade so the two cannot disagree.
 */
export default function CaseTiming({
  elapsedMs,
  timeLimitMs,
}: {
  elapsedMs: number;
  timeLimitMs: number;
}) {
  if (timeLimitMs <= 0) return null;

  const fraction = Math.min(elapsedMs / timeLimitMs, 1);
  // Anything under a few percent is invisible as a bar, and an empty track reads as "not
  // measured" rather than "very fast". A floor keeps the fast case legible as a fast case.
  const width = Math.max(fraction * 100, 1.5);
  // Sub-millisecond timings are the common case in Pyodide, so a whole-number ms would show
  // every case as "0ms" and say nothing.
  const shown = elapsedMs < 1 ? elapsedMs.toFixed(3) : elapsedMs.toFixed(1);

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span
        aria-hidden
        className="h-px flex-1 bg-line"
        title={`${shown}ms of a ${timeLimitMs}ms budget`}
      >
        <span
          className="block h-px bg-ink-3"
          style={{ width: `${width}%` }}
        />
      </span>
      {/* The budget is stated, not implied. Without it the reader has to remember what the
          constraint was, and the whole point is that they should not have to. */}
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">
        {shown} / {timeLimitMs}ms
      </span>
    </div>
  );
}
