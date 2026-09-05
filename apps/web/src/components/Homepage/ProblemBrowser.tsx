"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Surface } from "@/components/app";
import { cn } from "@/lib/utils";
import type { DashboardCategory, DashboardProblem } from "@/lib/api/dashboard";

/**
 * The problem list, filtered by category.
 *
 * WHAT THIS REPLACED
 *
 * A course catalogue at `/courses`, a course detail page, a module accordion
 * and a content-item row — four screens of navigation in front of twelve
 * problems, expressing a hierarchy where each problem had exactly one parent.
 *
 * That hierarchy could not describe the material. Attention is genuinely both
 * DL and LLM; LayerNorm is both DL and PyTorch. Filter chips over a flat list
 * let one problem appear under every lens it belongs to, and someone preparing
 * for a specific interview can narrow to it in one click rather than guessing
 * which course it was filed under.
 *
 * EMPTY CATEGORIES ARE SHOWN AND DISABLED, NOT HIDDEN. The chip row is a map of
 * what the platform covers; a category vanishing because it happens to have no
 * problems yet makes the curriculum look smaller than it is and makes the row
 * reflow as content is seeded.
 */
export default function ProblemBrowser({
  problems,
  categories,
}: {
  problems: DashboardProblem[];
  categories: DashboardCategory[];
}) {
  const [active, setActive] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      active
        ? problems.filter((p) => p.categories.includes(active))
        : problems,
    [problems, active]
  );

  const solvedInView = visible.filter((p) => p.isSolved).length;

  return (
    <section>
      <div className="mb-5 flex items-baseline gap-4">
        <h2 className="text-xl font-medium text-ink">Problems</h2>
        <div aria-hidden className="h-px flex-1 bg-line" />
        <span className="font-mono text-[11px] tabular-nums text-ink-3">
          {solvedInView}/{visible.length} solved
        </span>
      </div>

      {/* ── Category filter ──────────────────────────────────── */}
      <div
        role="group"
        aria-label="Filter problems by category"
        className="mb-6 flex flex-wrap items-center gap-2"
      >
        <Chip
          label="All"
          count={problems.length}
          selected={active === null}
          onClick={() => setActive(null)}
        />
        {categories.map((category) => (
          <Chip
            key={category.name}
            label={category.name}
            count={category.total}
            selected={active === category.name}
            disabled={category.total === 0}
            onClick={() => setActive(category.name)}
          />
        ))}
      </div>

      {/* ── The problems ─────────────────────────────────────── */}
      <Surface radius="panel" className="divide-y divide-line overflow-hidden">
        {visible.map((problem) => (
          <Link
            key={problem.id}
            href={`/problems/${problem.orderIndex}`}
            className={cn(
              "group flex items-center gap-4 px-5 py-3.5",
              "transition-colors duration-150 ease-void hover:bg-void-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
            )}
          >
            {/* Solved state as fill, not colour — the product's one emphasis axis. */}
            <span
              aria-hidden
              className={cn(
                "flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full border",
                problem.isSolved
                  ? "border-ink bg-ink text-void-0"
                  : "border-line-strong text-ink-3"
              )}
            >
              {problem.isSolved ? (
                <svg width="10" height="10" viewBox="0 0 9 9" fill="none">
                  <path
                    d="M1 4.5L3.5 7L8 2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span className="font-mono text-[10px] tabular-nums">
                  {problem.orderIndex}
                </span>
              )}
            </span>
            <span className="sr-only">
              {problem.isSolved ? "Solved" : "Not solved"}
            </span>

            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-sm transition-colors",
                  problem.isSolved
                    ? "text-ink-3"
                    : "text-ink-2 group-hover:text-ink"
                )}
              >
                {problem.title}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {problem.categories.map((name) => (
                  <span
                    key={name}
                    className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3"
                  >
                    {name}
                  </span>
                ))}
              </span>
            </span>

            <Badge tone={problem.difficulty === "hard" ? "strong" : "quiet"}>
              {problem.difficulty}
            </Badge>
          </Link>
        ))}

        {visible.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ink-3">
            No problems tagged {active} yet.
          </p>
        )}
      </Surface>
    </section>
  );
}

function Chip({
  label,
  count,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={disabled ? `No ${label} problems yet` : undefined}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
        "transition-colors duration-200 ease-void",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
        selected
          ? "border-ink bg-ink text-void-0"
          : "border-line bg-void-2 text-ink-2 hover:border-line-strong hover:text-ink",
        disabled && "cursor-not-allowed opacity-40 hover:border-line hover:text-ink-2"
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1 text-[10px] tabular-nums",
          selected ? "bg-void-0/15 text-void-0" : "bg-void-3 text-ink-3"
        )}
      >
        {count}
      </span>
    </button>
  );
}
