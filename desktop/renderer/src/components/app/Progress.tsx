import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Progress bars and rings.
 *
 * There were four implementations — `Homepage/CircularProgress`, a local
 * `ProgressRing` inside `CourseCatalogueClient`, and inline bars in
 * `CourseHeader` and `ModuleAccordion`. Between them they used three different
 * greens, a purple (`#5A2CFF`, as `CircularProgress`'s default `color` prop),
 * and four different track greys.
 *
 * NONE OF THE FOUR WAS ANNOUNCED TO ASSISTIVE TECH. Not one carried a `role`,
 * an `aria-valuenow` or a text alternative, so a screen reader got either
 * silence or a bare "45%" with nothing saying what was 45% complete. That is
 * why `label` is required here rather than optional: the accessible name is the
 * one thing a progress indicator cannot be built without, and making it a
 * required prop is what stops the next call site from omitting it.
 */

const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function ProgressBar({
  value,
  size = "md",
  label,
  className,
}: {
  value: number;
  size?: "sm" | "md";
  /** Accessible name, e.g. "Course progress". Required — see above. */
  label: string;
  className?: string;
}) {
  const pct = clamp(value);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "w-full overflow-hidden rounded-full bg-void-3",
        size === "sm" ? "h-1" : "h-1.5",
        className
      )}
    >
      <div
        className="h-full rounded-full bg-ink transition-[width] duration-700 ease-void motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * The donut. `children` renders in the centre — usually the percentage and a
 * `solved / total` count.
 *
 * The arc is drawn with `stroke-dashoffset` on a rotated circle rather than an
 * SVG arc path, because a path would need recomputing per value and this only
 * needs one number to change. `stroke-current` plus a text colour keeps both
 * strokes on the token system instead of hardcoding a hex into an SVG
 * attribute, which is how the old versions ended up unreachable by CSS.
 */
export function ProgressRing({
  value,
  size = 52,
  strokeWidth = 4,
  label,
  className,
  children,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const pct = clamp(value);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className={cn("relative flex-shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        /* -90° so the arc starts at twelve o'clock. Without it progress begins
           at three o'clock, which reads as though it is already part-done. */
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-current text-line-strong"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="stroke-current text-ink transition-[stroke-dashoffset] duration-700 ease-void motion-reduce:transition-none"
        />
      </svg>

      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {children}
        </div>
      )}
    </div>
  );
}
