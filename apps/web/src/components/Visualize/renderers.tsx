"use client";

import { cn } from "@/lib/utils";
import type {
  BoxStep,
  Cell,
  CellState,
  MatrixStep,
  TokenStep,
  VectorStep,
} from "@/lib/visualizations/types";

/**
 * The four renderers.
 *
 * Between them they cover the whole curriculum, because the shapes repeat:
 * almost every problem is a row of numbers or a grid of them, and the two that
 * are not — a token sequence and a set of boxes — each earn a renderer.
 *
 * NO ARITHMETIC HAPPENS HERE. Every value arrives pre-formatted from
 * `lib/visualizations`. A renderer that computed softmax would be a second
 * implementation of the thing being taught, free to drift from the reference
 * solution the test cases are built on.
 *
 * STATE IS CARRIED BY BORDER AND FILL, NOT HUE — the same monochrome axis the
 * rest of the product uses. `active` brightens the edge, `changed` inverts to
 * white-on-black, `muted` recedes. That ordering is deliberate: the thing that
 * just changed should be the brightest object on screen.
 */

const CELL_STATE: Record<CellState, string> = {
  idle: "border-line-strong bg-void-2 text-ink-2",
  active: "border-ink-3 bg-void-3 text-ink",
  changed: "border-ink bg-ink text-void-0",
  muted: "border-line bg-void-2 text-ink-3/60",
};

function CellBox({ cell, wide }: { cell: Cell; wide?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={cn(
          "flex h-9 items-center justify-center rounded-md border px-2",
          "font-mono text-[11px] tabular-nums",
          "transition-colors duration-300 ease-void motion-reduce:transition-none",
          wide ? "min-w-[74px]" : "min-w-[46px]",
          CELL_STATE[cell.state ?? "idle"]
        )}
      >
        {cell.value}
      </div>
      {cell.label && (
        <span className="font-mono text-[9px] text-ink-3">{cell.label}</span>
      )}
    </div>
  );
}

/** A stack of labelled rows. Used by most problems. */
export function VectorViz({ step }: { step: VectorStep }) {
  const wide = step.rows.some((r) => r.cells.some((c) => c.value.length > 6));
  return (
    <div className="flex flex-col gap-4">
      {step.rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          {row.title && (
            <span className="w-[86px] flex-shrink-0 pb-3 text-right font-mono text-[10px] text-ink-3">
              {row.title}
            </span>
          )}
          <div className="flex flex-wrap items-end gap-1.5">
            {row.cells.map((cell, j) => (
              <CellBox key={j} cell={cell} wide={wide} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A grid with optional row and column headers. */
export function MatrixViz({ step }: { step: MatrixStep }) {
  const wide = step.grid.some((row) => row.some((c) => c.value.length > 6));
  return (
    <div className="inline-flex flex-col gap-1.5">
      {step.colLabels && (
        <div className="flex gap-1.5 pl-[86px]">
          {step.colLabels.map((label) => (
            <span
              key={label}
              className={cn(
                "text-center font-mono text-[9px] text-ink-3",
                wide ? "min-w-[74px]" : "min-w-[46px]"
              )}
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {step.grid.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-[80px] flex-shrink-0 pr-2 text-right font-mono text-[10px] text-ink-3">
            {step.rowLabels?.[i] ?? ""}
          </span>
          {row.map((cell, j) => (
            <CellBox key={j} cell={cell} wide={wide} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A token sequence, with an optional bracket under a merge candidate. */
export function TokenViz({ step }: { step: TokenStep }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-1.5">
        {step.tokens.map((token, i) => {
          const inBracket =
            step.bracket && i >= step.bracket[0] && i <= step.bracket[1];
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "flex h-10 min-w-[42px] items-center justify-center rounded-md border px-2.5",
                  "font-mono text-xs",
                  "transition-colors duration-300 ease-void motion-reduce:transition-none",
                  CELL_STATE[token.state ?? "idle"]
                )}
              >
                {token.value}
              </div>
              {/* The bracket is drawn per-cell rather than as one absolutely
                  positioned element, so it survives the sequence changing
                  length mid-animation without needing measurement. */}
              <div
                aria-hidden
                className={cn(
                  "h-[3px] w-full rounded-full transition-colors duration-300 ease-void motion-reduce:transition-none",
                  inBracket ? "bg-ink-3" : "bg-transparent"
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Boxes on a plane, scaled to fit. Used by IoU / NMS. */
export function BoxViz({ step }: { step: BoxStep }) {
  const { width, height } = step.extent;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-[340px]"
      role="img"
      aria-label="Detection boxes, showing which are kept and which are suppressed"
    >
      {step.boxes.map((box, i) => {
        const state = box.state ?? "idle";
        const stroke =
          state === "changed"
            ? "var(--color-ink)"
            : state === "active"
              ? "var(--color-ink-3)"
              : state === "muted"
                ? "var(--color-line-strong)"
                : "var(--color-line-strong)";
        return (
          <g key={i}>
            <rect
              x={box.x1}
              y={box.y1}
              width={box.x2 - box.x1}
              height={box.y2 - box.y1}
              fill={state === "changed" ? "rgb(255 255 255 / 0.09)" : "none"}
              stroke={stroke}
              strokeWidth={0.4}
              /* A suppressed box stays visible but dashed — removing it would
                 hide the very thing the step is explaining. */
              strokeDasharray={state === "muted" ? "1 1" : undefined}
              className="transition-all duration-300 ease-void motion-reduce:transition-none"
            />
            <text
              x={box.x1 + 0.6}
              y={box.y1 - 0.8}
              fontSize={1.7}
              className={cn(
                "font-mono",
                state === "muted" ? "fill-ink-3/60" : state === "idle" ? "fill-ink-3" : "fill-ink"
              )}
            >
              {box.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
