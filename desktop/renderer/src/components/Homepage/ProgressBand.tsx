"use client";

import { Surface, ProgressRing } from "@/components/app";
import type { DashboardData } from "@/lib/api/dashboard";

/**
 * How far in you are — moved off the hero, where it competed with the call to action.
 *
 * Two halves: the ring with its by-difficulty breakdown, and twelve weeks of activity. The
 * breakdown is the useful part of the ring; one aggregate percentage tells you nothing about
 * where you are weak, which was the old dashboard's actual failing.
 */

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export default function ProgressBand({ data }: { data: DashboardData | null }) {
  const problems = data?.problems ?? [];
  const total = data?.totalProblems ?? 0;
  const solved = data?.solvedProblems ?? 0;
  const percentage = total > 0 ? (solved / total) * 100 : 0;

  // From main, alongside the strip's numbers — this was a private function here, which is
  // exactly why its edge cases had no test.
  const streak = data?.stats?.streakDays ?? 0;
  // Only topics with something in them: an all-zero bar for a category that has no problems
  // yet reads as "you have failed at CV", not "CV is coming".
  const categories = (data?.categories ?? []).filter((c) => c.total > 0);

  const byDifficulty = DIFFICULTIES.map((difficulty) => {
    const inTier = problems.filter((p) => p.difficulty?.toLowerCase() === difficulty);
    return {
      difficulty,
      total: inTier.length,
      solved: inTier.filter((p) => p.isSolved).length,
    };
  });

  /**
   * First run, and it is worth handling rather than letting the general case degrade into it.
   *
   * With nothing solved, the general layout renders an empty ring beside an empty 84-cell
   * grid — two dead objects taking a third of the page, which reads as the dashboard being
   * broken rather than as the account being new. There is nothing to show yet, so this says
   * what the space will hold once there is.
   */
  if (solved === 0) {
    return (
      <Surface radius="panel" className="p-6">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Progress</h2>
        <p className="mt-3 max-w-[58ch] text-[13px] leading-relaxed text-ink-2">
          Nothing solved yet. Once you finish your first problem this becomes a breakdown by
          difficulty and twelve weeks of activity — {total} problem
          {total === 1 ? "" : "s"} are waiting.
        </p>
      </Surface>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Surface radius="panel" className="p-6">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
          Progress
        </h2>

        <div className="mt-5 flex items-center gap-6">
          <ProgressRing
            value={percentage}
            size={104}
            label={`${solved} of ${total} problems solved`}
          />

          <dl className="flex-1 space-y-2">
            {byDifficulty.map((tier) => (
              <div key={tier.difficulty} className="flex items-baseline gap-3">
                <dt className="w-16 text-[11px] uppercase tracking-wide text-ink-3">
                  {tier.difficulty}
                </dt>
                {/* `tabular-nums` so the three rows' numerals line up vertically — with
                    proportional figures a 1 is narrower than a 4 and the column wanders. */}
                <dd className="font-mono text-[13px] tabular-nums text-ink-2">
                  {tier.solved}/{tier.total}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Surface>

      <Surface radius="panel" className="p-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
            Last 12 weeks
          </h2>
          {streak > 0 && (
            <span className="font-mono text-[11px] tabular-nums text-ink">
              {streak}-day streak
            </span>
          )}
        </div>
        <ActivityStrip activity={data?.activity ?? []} />
      </Surface>

      {categories.length > 0 && (
        <Surface radius="panel" className="p-6 lg:col-span-2">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
            By topic
          </h2>
          {/* The payload has always returned these and only the filter chips used them —
              a count next to a name says far less than a bar you can compare across rows. */}
          <ul className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {categories.map((category) => (
              <li key={category.name} className="flex items-center gap-3">
                <span className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wide text-ink-3">
                  {category.name}
                </span>
                <span aria-hidden className="h-px flex-1 bg-line">
                  <span
                    className="block h-px bg-ink-3"
                    style={{
                      width: `${
                        category.total > 0 ? (category.solved / category.total) * 100 : 0
                      }%`,
                    }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">
                  {category.solved}/{category.total}
                </span>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}

/**
 * 84 cells, oldest first, in week columns.
 *
 * Monochrome: opacity carries the intensity, because the palette has no accent to ramp and
 * inventing one here would be the exact mistake `globals.css` documents. Four steps only —
 * more would be indistinguishable at 10px.
 */
function ActivityStrip({ activity }: { activity: number[] }) {
  const cells = activity.length === 84 ? activity : new Array<number>(84).fill(0);
  const totalDays = cells.filter((c) => c > 0).length;

  return (
    <div className="mt-5">
      {/* Column-major: seven rows of days, twelve columns of weeks, filled down then across —
          the layout every contribution graph uses, and the one people can already read. */}
      <div className="grid grid-flow-col grid-rows-7 gap-1">
        {cells.map((count, index) => (
          <div
            key={index}
            title={`${count} solved`}
            className={`h-2.5 w-2.5 rounded-[2px] ${
              count === 0
                ? "bg-line"
                : count === 1
                  ? "bg-ink/25"
                  : count === 2
                    ? "bg-ink/55"
                    : "bg-ink/90"
            }`}
          />
        ))}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
        {totalDays === 0
          ? "No problems solved yet in this window."
          : `${totalDays} ${totalDays === 1 ? "day" : "days"} with a problem solved.`}{" "}
        {/* Said plainly, because otherwise an empty strip after an hour of hard work reads
            as the feature being broken. */}
        Counts days you finished something, not days you worked.
      </p>
    </div>
  );
}
