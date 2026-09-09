"use client";

/**
 * The curve the exercise computes.
 *
 * The design thesis, made concrete: **the mathematics is the imagery.** The reference this
 * card points at has no honest photograph — there is no stock image for "implement softmax
 * without overflow" — but there *is* the shape of what it computes, and that is a picture
 * only this product could show.
 *
 * Every value is derived in main from the reference's real output for a real case
 * (`content/shapes.ts`). Nothing here is drawn by hand, so the curve cannot quietly stop
 * matching the maths the way an illustration would.
 */

interface FunctionPlotProps {
  output: number[];
  /** Present only when the input is a series of the same length. */
  input?: number[];
  label?: string;
}

const WIDTH = 260;
const HEIGHT = 150;
const PAD = 10;

export default function FunctionPlot({ output, input, label }: FunctionPlotProps) {
  const outputPath = pathFor(output);
  // Drawn faintly behind the output. Softmax's inputs span 1–3 and its outputs 0–1, so they
  // are normalised independently — this is about the *shape* of the mapping, not a shared
  // axis, and pretending otherwise would flatten the output into a straight line.
  const inputPath = input === undefined ? undefined : pathFor(input);

  return (
    <figure className="m-0 shrink-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={
          label ??
          `Reference output: ${output.map((n) => n.toFixed(3)).join(", ")}`
        }
        className="overflow-visible"
      >
        {/* A baseline rather than a grid. One rule is enough to read a curve against, and a
            full grid on a card this size is texture, not information. */}
        <line
          x1={PAD}
          y1={HEIGHT - PAD}
          x2={WIDTH - PAD}
          y2={HEIGHT - PAD}
          className="stroke-line"
          strokeWidth="1"
        />

        {inputPath !== undefined && (
          <path
            d={inputPath}
            fill="none"
            className="stroke-ink-3"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity="0.5"
          />
        )}

        <path
          d={outputPath}
          fill="none"
          className="stroke-ink [stroke-dasharray:600] [stroke-dashoffset:600] motion-safe:animate-plot-draw motion-reduce:[stroke-dashoffset:0]"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* The endpoint, so the eye has somewhere to land. */}
        <circle
          cx={WIDTH - PAD}
          cy={yFor(output[output.length - 1]!, output)}
          r="2.5"
          className="fill-ink opacity-0 motion-safe:animate-plot-dot motion-reduce:opacity-100"
        />
      </svg>

      {label !== undefined && (
        <figcaption className="mt-1 text-center font-mono text-[10px] text-ink-3">
          {label}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * Normalised to its own range, with a flat series pinned to the middle.
 *
 * Without the flat case a constant output — softmax on equal logits returns three identical
 * thirds, which is the *point* of that exercise — divides by a zero range and every point
 * becomes `NaN`, so the path silently renders nothing.
 */
function yFor(value: number, series: number[]): number {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const usable = HEIGHT - PAD * 2;

  if (span === 0) return PAD + usable / 2;
  return PAD + usable - ((value - min) / span) * usable;
}

function pathFor(series: number[]): string {
  const step = (WIDTH - PAD * 2) / Math.max(series.length - 1, 1);

  return series
    .map((value, index) => {
      const x = PAD + index * step;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${yFor(value, series).toFixed(2)}`;
    })
    .join(" ");
}
