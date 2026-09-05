"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import type { DashboardCategory, DashboardProblem } from "@/lib/api/dashboard";

/**
 * The problem catalogue.
 *
 * FILTER STATE LIVES IN THE URL, NOT IN `useState`.
 *
 * This is the detail catalogues usually miss and it costs one hook to get
 * right. A filtered view is then linkable, survives a refresh, survives the
 * back button, and can be shared — "here are the unsolved CUDA problems" is a
 * URL rather than a set of instructions. `router.replace` with `scroll: false`
 * keeps it out of the history stack, so Back leaves the catalogue rather than
 * stepping through every chip the user pressed.
 *
 * Everything is derived from the dashboard payload the app already fetches. No
 * new endpoint: twelve problems fit in one response, and filtering twelve rows
 * on the server would be a round trip to save nothing.
 */

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const STATUSES = [
  { key: "all", label: "All" },
  { key: "unsolved", label: "Unsolved" },
  { key: "solved", label: "Solved" },
] as const;
const SORTS = [
  { key: "order", label: "Curriculum order" },
  { key: "difficulty", label: "Difficulty" },
  { key: "title", label: "Title" },
] as const;

const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

export default function ProblemCatalogue({
  problems,
  categories,
}: {
  problems: DashboardProblem[];
  categories: DashboardCategory[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const difficulty = params.get("difficulty");
  const status = params.get("status") ?? "all";
  const sort = params.get("sort") ?? "order";
  // Multi-select, comma-separated: ?category=DL,LLM
  const activeCategories = useMemo(
    () => (params.get("category")?.split(",").filter(Boolean) ?? []),
    [params]
  );

  /** Write one key, dropping it entirely when it returns to its default. */
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const toggleCategory = (name: string) => {
    const next = activeCategories.includes(name)
      ? activeCategories.filter((c) => c !== name)
      : [...activeCategories, name];
    setParam("category", next.join(","));
  };

  const visible = useMemo(() => {
    let out = problems;

    if (difficulty) {
      out = out.filter((p) => p.difficulty.toLowerCase() === difficulty);
    }
    if (activeCategories.length > 0) {
      // AND, not OR: selecting DL and PyTorch means "problems that are both",
      // which is what someone narrowing a list expects. OR would widen the
      // result as you add filters, which reads as broken.
      out = out.filter((p) =>
        activeCategories.every((c) => p.categories.includes(c))
      );
    }
    if (status === "solved") out = out.filter((p) => p.isSolved);
    if (status === "unsolved") out = out.filter((p) => !p.isSolved);

    const sorted = [...out];
    if (sort === "difficulty") {
      sorted.sort(
        (a, b) =>
          (DIFFICULTY_RANK[a.difficulty] ?? 9) - (DIFFICULTY_RANK[b.difficulty] ?? 9) ||
          a.orderIndex - b.orderIndex
      );
    } else if (sort === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      sorted.sort((a, b) => a.orderIndex - b.orderIndex);
    }
    return sorted;
  }, [problems, difficulty, activeCategories, status, sort]);

  const filtered =
    Boolean(difficulty) || activeCategories.length > 0 || status !== "all";
  const solvedInView = visible.filter((p) => p.isSolved).length;

  return (
    <div className="space-y-6">
      {/* ── Controls ─────────────────────────────────────────── */}
      <Surface radius="panel" className="space-y-5 p-5">
        {/* Difficulty — segmented, single select */}
        <Row label="Difficulty">
          <Segmented
            options={[
              { key: "", label: "Any" },
              ...DIFFICULTIES.map((d) => ({ key: d, label: d })),
            ]}
            value={difficulty ?? ""}
            onChange={(v) => setParam("difficulty", v || null)}
          />
        </Row>

        {/* Category — chips, multi select */}
        <Row label="Category">
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <Chip
                key={category.name}
                label={category.name}
                count={category.total}
                selected={activeCategories.includes(category.name)}
                disabled={category.total === 0}
                onClick={() => toggleCategory(category.name)}
              />
            ))}
          </div>
        </Row>

        <Row label="Status">
          <Segmented
            options={STATUSES.map((s) => ({ key: s.key, label: s.label }))}
            value={status}
            onChange={(v) => setParam("status", v === "all" ? null : v)}
          />
        </Row>

        <Row label="Sort">
          <Segmented
            options={SORTS.map((s) => ({ key: s.key, label: s.label }))}
            value={sort}
            onChange={(v) => setParam("sort", v === "order" ? null : v)}
          />
        </Row>
      </Surface>

      {/* ── Result count + reset ─────────────────────────────── */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] tabular-nums text-ink-3">
          {visible.length} problem{visible.length === 1 ? "" : "s"}
          {visible.length > 0 && <> · {solvedInView} solved</>}
        </p>
        {filtered && (
          <button
            type="button"
            onClick={() => router.replace(pathname, { scroll: false })}
            className="text-xs text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline focus-visible:outline-none"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Results ──────────────────────────────────────────── */}
      <Surface radius="panel" className="divide-y divide-line overflow-hidden">
        {visible.map((problem) => (
          <Link
            key={problem.id}
            href={`/problems/${problem.orderIndex}`}
            className={cn(
              "group flex items-center gap-4 px-5 py-4",
              "transition-colors duration-150 ease-void hover:bg-void-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
            )}
          >
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
                  <path d="M1 4.5L3.5 7L8 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
                  problem.isSolved ? "text-ink-3" : "text-ink-2 group-hover:text-ink"
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

        {/* An empty result is a state, not a blank page — and it says which
            filter to relax rather than leaving the user to guess. */}
        {visible.length === 0 && (
          <div className="px-5 py-14 text-center">
            <p className="text-sm text-ink-2">Nothing matches those filters.</p>
            <p className="mx-auto mt-1 max-w-[42ch] text-xs leading-relaxed text-ink-3">
              {activeCategories.length > 1
                ? "Categories combine with AND, so selecting several narrows quickly. Try removing one."
                : "Try a different difficulty, or clear the filters."}
            </p>
            <Pill
              variant="outline"
              size="sm"
              className="mt-5"
              onClick={() => router.replace(pathname, { scroll: false })}
            >
              Clear filters
            </Pill>
          </div>
        )}
      </Surface>
    </div>
  );
}

// ── Control primitives ──────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
      <span className="w-[74px] flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Single-select, rendered as one connected control rather than loose buttons. */
function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="group"
      className="inline-flex flex-wrap rounded-full border border-line bg-void-2 p-0.5"
    >
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <button
            key={option.key || "any"}
            type="button"
            onClick={() => onChange(option.key)}
            aria-pressed={selected}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium capitalize",
              "transition-colors duration-150 ease-void",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
              selected ? "bg-ink text-void-0" : "text-ink-2 hover:text-ink"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
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
