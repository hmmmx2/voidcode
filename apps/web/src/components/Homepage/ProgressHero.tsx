"use client";

import { useRouter } from "next/navigation";
import { Badge, GlassSurface, ProgressRing } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import type { DashboardData } from "@/lib/api/dashboard";

interface ProgressHeroProps {
  data: DashboardData | null;
  userName: string;
}

/** Difficulty order, so the breakdown never depends on Object.keys ordering. */
const DIFFICULTIES = ["easy", "medium", "hard"] as const;

/**
 * The dashboard hero: what to do next, and how far in you are.
 *
 * WHAT THIS REPLACED, AND WHY
 *
 * The old hero was a progress ring, a truncated problem description, a
 * "Practice makes perfect" badge and a 150px avatar of the person already
 * logged in. Two of those four elements carried no information — you know who
 * you are, and the badge was decoration — and the avatar was the single largest
 * object on the page.
 *
 * The one genuinely useful thing, "here is the next unsolved problem", was a
 * grey sub-card competing with the ring beside it. It is now the headline, at
 * display size, with the primary action attached to it. Everything else on this
 * card exists to answer "how far in am I", which is the only other question a
 * returning user has.
 *
 * The by-difficulty breakdown is derived from `courses[].problems[]`, which the
 * API has always returned and the old dashboard threw away — it showed one
 * aggregate percentage over everything and nothing about where you were weak.
 *
 * GLASS SURFACE #4. It sits directly under the top of the page where
 * `AppBackdrop`'s bloom is brightest and scrolls through it, which is what makes
 * the blur read as glass rather than as a lighter rectangle.
 */
export default function ProgressHero({ data, userName }: ProgressHeroProps) {
  const router = useRouter();

  const totalProblems = data?.totalProblems ?? 0;
  const solvedProblems = data?.solvedProblems ?? 0;
  const percentage =
    totalProblems > 0 ? (solvedProblems / totalProblems) * 100 : 0;

  const current = data?.currentQuestion;
  const allProblems = data?.problems ?? [];

  // Solved / total per difficulty. Only difficulties that actually exist in the
  // curriculum are rendered, so this does not invent an empty "hard" column.
  const byDifficulty = DIFFICULTIES.map((level) => {
    const inLevel = allProblems.filter(
      (p) => p.difficulty.toLowerCase() === level
    );
    return {
      level,
      total: inLevel.length,
      solved: inLevel.filter((p) => p.isSolved).length,
    };
  }).filter((d) => d.total > 0);

  const isFinished = totalProblems > 0 && solvedProblems === totalProblems;
  const isFresh = solvedProblems === 0;

  const handleStart = () => {
    router.push(`/problems/${current ? current.orderIndex : 1}`);
  };

  return (
    <GlassSurface radius="panel" className="overflow-hidden">
      <div className="grid gap-8 p-6 lg:grid-cols-[1.35fr_auto] lg:gap-12 lg:p-8">
        {/* ── What to do next ─────────────────────────────────── */}
        <div className="flex min-w-0 flex-col justify-between gap-6">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
              {isFinished ? "Complete" : isFresh ? "Start here" : "Continue"}
            </p>

            {current ? (
              <>
                {/* The headline is the problem, not a greeting. A returning
                    user is here to resume, and the fastest possible answer to
                    "what was I doing" is its name at display size. */}
                <h1 className="mt-4 max-w-[18ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
                  {current.title}
                </h1>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Badge>Problem {current.orderIndex}</Badge>
                  {current.categories.map((name) => (
                    <Badge key={name} tone="strong" className="font-mono">
                      {name}
                    </Badge>
                  ))}
                </div>

                <p className="mt-5 line-clamp-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
                  {current.descriptionPreview}
                </p>
              </>
            ) : (
              <>
                <h1 className="mt-4 max-w-[18ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
                  {isFinished
                    ? `Every problem solved, ${userName}.`
                    : `Welcome, ${userName}.`}
                </h1>
                <p className="mt-5 max-w-[54ch] text-sm leading-relaxed text-ink-2">
                  {isFinished
                    ? "You have worked through every problem. Revisit any of them to sharpen the explanation you would give in an interview."
                    : "A twelve-problem sequence through the primitives ML interviews ask you to implement from scratch, and a wider catalogue once you are through it."}
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Pill variant="solid" size="lg" onClick={handleStart}>
              {isFinished ? "Review problems" : isFresh ? "Start the first problem" : "Resume"}
            </Pill>
          </div>
        </div>

        {/* ── How far in ──────────────────────────────────────── */}
        <div className="flex flex-row items-center gap-8 lg:flex-col lg:items-end lg:justify-center lg:gap-6">
          <ProgressRing
            value={percentage}
            size={132}
            strokeWidth={6}
            label="Problems solved overall"
          >
            <span className="text-2xl font-light tabular-nums text-ink">
              {Math.round(percentage)}%
            </span>
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-ink-3">
              {solvedProblems}/{totalProblems} solved
            </span>
          </ProgressRing>

          {/* By difficulty. The API has always returned this; the previous
              dashboard collapsed it into a single number. */}
          {byDifficulty.length > 0 && (
            <dl className="flex flex-col gap-2 lg:w-[132px]">
              {byDifficulty.map((d) => (
                <div
                  key={d.level}
                  className="flex items-center justify-between gap-4 border-t border-line pt-2 first:border-t-0 first:pt-0"
                >
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
                    {d.level}
                  </dt>
                  <dd className="font-mono text-[11px] tabular-nums text-ink-2">
                    {d.solved}
                    <span className="text-ink-3">/{d.total}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </GlassSurface>
  );
}
