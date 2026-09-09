/**
 * The dashboard, assembled locally.
 *
 * First router migrated off FastAPI. It is a pure join of two things main already owns —
 * the problem store and the progress table — so nothing new had to be stored to make it
 * work.
 *
 * **The wire shape is snake_case on purpose.** `renderer/src/lib/api/dashboard.ts` parses
 * `order_index`, `is_solved`, `description_preview` and `problem_slug` into camelCase. The
 * transport swap is meant to be invisible to the UI, so this matches what FastAPI emitted
 * rather than what would be natural to write in TypeScript. Changing the case here would
 * mean editing the parser too, and the point of the seam is that callers do not move.
 */
import { listProblems } from "./problems.js";
import { QUESTIONS } from "./interview-bank.js";
import { recommend, conceptProgress, type LearnerState } from "./selection.js";
import { allProgress, recentSubmissions } from "../store/submissions.js";
import { allAttempts } from "../store/interviews.js";
import { cachedKeyFor } from "../exec/grader.js";
import { derivePlot } from "./shapes.js";

export interface DashboardPayload {
  problems: Array<{
    id: string;
    slug: string;
    title: string;
    difficulty: string;
    categories: string[];
    order_index: number;
    is_solved: boolean;
    /** Runs recorded against this problem, solved or not. */
    attempt_count: number;
    /** The furthest any submission got. Absent when nothing has been run. */
    best_passed?: number;
    best_total?: number;
    last_attempted_at?: string;
  }>;
  categories: Array<{ name: string; total: number; solved: number }>;
  /**
   * What to do next, chosen by `selection.ts` and carrying the reason it was chosen.
   *
   * Replaces `current_question`, which was the first unsolved problem in array order and had no
   * `why` to give. It also spans **both** catalogues now: 38 of the 52 things a learner can do are
   * interview questions, and a resume card that could only ever offer the other 14 was throwing
   * away most of what the recommender knows. `kind` is what the UI routes on.
   */
  next_item: {
    item_id: string;
    kind: "problem" | "question";
    title: string;
    reason: "finish" | "repair" | "ready" | "blocked";
    /** One sentence. Shown to the learner verbatim. */
    why: string;
    concept_ids: string[];
    description_preview: string;
    /** Catalogue position, for problems only — questions are not in that list. */
    order_index?: number;
  } | null;
  /**
   * Per-concept progress, alongside the category counts rather than instead of them.
   *
   * They answer different questions. `categories` says how much DL there is, overlaps on purpose
   * and does not sum. These say what has been demonstrated and what is open, which is the only
   * view that lines up with how the next item is chosen.
   */
  concepts: Array<{
    id: string;
    name: string;
    category: string;
    total: number;
    solid: number;
    in_progress: number;
    ready: boolean;
  }>;
  total_problems: number;
  solved_problems: number;
  /** 84 daily counts, oldest first — twelve weeks of activity for the dashboard strip. */
  activity: number[];
  /**
   * The curve for the resume card, when one is available *without executing anything*.
   *
   * Absent on a cold start and that is deliberate: deriving it needs the reference's output,
   * and the sandbox runs one job at a time with a second superseding the first. A dashboard
   * that executed a reference could cancel a submission the learner is waiting on. It fills
   * in once the problem has been opened.
   */
  plot?: { input?: number[]; output: number[] };
  /**
   * The four numerals across the top of the dashboard.
   *
   * Derived here rather than in the renderer so they are testable — the streak in particular
   * has real edge cases, and it previously lived as a private function in a React component
   * where nothing could reach it.
   */
  stats: {
    solved: number;
    streak_days: number;
    attempts: number;
    /** 0–100 across every case reached. Absent until something has been run. */
    case_rate?: number;
  };
}

/** First ~160 characters, cut on a word boundary so the card does not end mid-word. */
function preview(summary: string): string {
  if (summary.length <= 160) return summary;
  const cut = summary.slice(0, 160);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 100 ? cut.slice(0, lastSpace) : cut}…`;
}

export function buildDashboard(): DashboardPayload {
  const problems = listProblems();
  const progress = allProgress();
  const solved = new Set(progress.filter((p) => p.solved).map((p) => p.problemId));
  const attempts = new Map(progress.map((p) => [p.problemId, p.attemptCount]));

  const rows = problems.map((p, index) => {
    // The best any submission got, for a problem not yet solved.
    //
    // "Not solved" throws away the most motivating thing the store knows. Someone who got 3
    // of 4 cases is one edge case from done and should be told so; someone who got 0 of 4 is
    // somewhere else entirely, and the list currently renders both identically.
    const best = bestAttempt(p.id);

    return {
      id: p.id,
      slug: p.id,
      title: p.title,
      difficulty: p.difficulty,
      categories: p.categories,
      // Position in the catalogue, 1-based, matching how the UI's prev/next chevrons and
      // "Question: n/N" counter read it.
      order_index: index + 1,
      is_solved: solved.has(p.id),
      attempt_count: attempts.get(p.id) ?? 0,
      ...(best === undefined
        ? {}
        : {
            best_passed: best.passedCount,
            best_total: best.totalCount,
            last_attempted_at: best.submittedAt,
          }),
    };
  });

  /**
   * Category totals deliberately overlap.
   *
   * A problem tagged both DL and LLM counts once in each, so summing `total` exceeds the
   * problem count. That is the same behaviour the FastAPI version had and the same thing
   * the client's own header documents — they answer "how much DL is there", not "how many
   * problems are there".
   */
  const byCategory = new Map<string, { total: number; solved: number }>();
  for (const row of rows) {
    for (const name of row.categories) {
      const entry = byCategory.get(name) ?? { total: 0, solved: 0 };
      entry.total += 1;
      if (row.is_solved) entry.solved += 1;
      byCategory.set(name, entry);
    }
  }

  /**
   * What to do next, and why.
   *
   * The learner state is assembled here rather than read inside `selection.ts`, which takes it as
   * an argument and touches no store at all. That is what lets the whole recommender be tested
   * against hand-built states — including states the app cannot reach yet — without a database.
   */
  const learner: LearnerState = {
    problems: new Map(
      problems.map((p) => {
        const best = bestAttempt(p.id);
        return [
          p.id,
          {
            solved: solved.has(p.id),
            attempts: attempts.get(p.id) ?? 0,
            ...(best === undefined
              ? {}
              : { bestPassed: best.passedCount, bestTotal: best.totalCount }),
          },
        ];
      })
    ),
    questions: new Map(
      [...allAttempts()].map(([slug, attempt]) => [
        slug,
        {
          verdict: attempt.assessedVerdict,
          selfRating: attempt.selfRating,
          revealedAnswer: attempt.revealedAnswer,
        },
      ])
    ),
  };

  const recommendation = recommend(learner);
  const nextProblem =
    recommendation?.kind === "problem"
      ? problems.find((p) => p.id === recommendation.itemId)
      : undefined;
  const nextQuestion =
    recommendation?.kind === "question"
      ? QUESTIONS.find((q) => q.slug === recommendation.itemId)
      : undefined;

  // Cached only — see `cachedKeyFor`. The index is the first visible case's, matching how
  // `detail.ts` picks its sample.
  const resumePlot = (() => {
    if (nextProblem === undefined) return undefined;
    const key = cachedKeyFor(nextProblem);
    if (key === undefined) return undefined;
    const sampleIndex = nextProblem.cases.findIndex((c) => c.visible);
    return derivePlot(nextProblem, sampleIndex === -1 ? undefined : key[sampleIndex]);
  })();

  // Computed once: `recentActivity` walks the whole progress table and the streak reads the
  // same array, so calling it twice would do the work twice for one number.
  const activityCounts = recentActivity();

  // Of every case you have reached, how many pass. Solved problems count as complete, which
  // is correct — this is "how much of what I have attempted works", not "how hard is it".
  let passed = 0;
  let reached = 0;
  for (const row of rows) {
    if (row.best_total === undefined || row.best_passed === undefined) continue;
    passed += row.best_passed;
    reached += row.best_total;
  }

  return {
    problems: rows,
    categories: [...byCategory.entries()]
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    next_item:
      recommendation === null
        ? null
        : {
            item_id: recommendation.itemId,
            kind: recommendation.kind,
            title: recommendation.title,
            reason: recommendation.reason,
            why: recommendation.why,
            concept_ids: recommendation.concepts,
            // The problem's summary, or the question itself — which is safe to show, unlike the
            // approach and the model answer.
            description_preview: preview(
              nextProblem?.summary ?? nextQuestion?.prompt ?? recommendation.title
            ),
            ...(nextProblem === undefined
              ? {}
              : { order_index: rows.findIndex((r) => r.id === nextProblem.id) + 1 }),
          },
    concepts: conceptProgress(learner).map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      total: c.total,
      solid: c.solid,
      in_progress: c.inProgress,
      ready: c.ready,
    })),
    total_problems: rows.length,
    solved_problems: rows.filter((r) => r.is_solved).length,
    activity: activityCounts,
    ...(resumePlot === undefined ? {} : { plot: resumePlot }),
    stats: {
      solved: rows.filter((r) => r.is_solved).length,
      streak_days: currentStreak(activityCounts),
      attempts: rows.reduce((sum, r) => sum + r.attempt_count, 0),
      ...(reached === 0 ? {} : { case_rate: Math.round((passed / reached) * 100) }),
    },
  };
}

/**
 * The furthest any submission for a problem got.
 *
 * Best rather than latest: a learner who reached 3/4 and then broke it while refactoring has
 * still demonstrated 3/4, and showing the regression instead would be both discouraging and
 * less informative. Ties go to the more recent attempt, so `last_attempted_at` tracks the run
 * the count actually came from.
 */
function bestAttempt(
  problemId: string
): { passedCount: number; totalCount: number; submittedAt: string } | undefined {
  // 200, matching the count guard in the store smoke: enough to be the real maximum for any
  // realistic history, bounded so a pathological one cannot stall the dashboard.
  const rows = recentSubmissions(problemId, 200);
  if (rows.length === 0) return undefined;

  let best = rows[0]!;
  for (const row of rows) {
    if (row.passedCount > best.passedCount) best = row;
  }

  return {
    passedCount: best.passedCount,
    totalCount: best.totalCount,
    submittedAt: best.submittedAt,
  };
}

/**
 * Consecutive days with a solve, counting back from today.
 *
 * Today being empty does not break a streak — someone who solved something last night and has
 * not started yet this morning still has theirs, and zeroing it at midnight would be both
 * wrong and demoralising. So the walk starts at yesterday when today is empty.
 */
function currentStreak(activity: number[]): number {
  if (activity.length === 0) return 0;

  let index = activity.length - 1;
  if (activity[index] === 0) index -= 1;

  let days = 0;
  while (index >= 0 && (activity[index] ?? 0) > 0) {
    days += 1;
    index -= 1;
  }
  return days;
}

/**
 * Parse a timestamp written by SQLite's `datetime('now')`.
 *
 * **The `Z` is the whole function.** SQLite writes UTC in the form `2026-07-30 19:03:37` —
 * space-separated, no zone marker — and JavaScript parses that shape as *local* time. On
 * UTC+8 that reads a moment from this morning as yesterday evening, so a problem solved
 * today lands on yesterday's cell in the activity strip.
 *
 * Nothing errors and the strip still renders; it is simply shifted by a day for everyone not
 * on UTC, which is the kind of bug that survives a long time because it looks plausible. A
 * test caught it by solving a problem and asserting today's cell.
 */
function parseStoredTimestamp(value: string): Date | undefined {
  // Tolerate a value that already carries a zone, so this stays correct if the store ever
  // switches to real ISO output.
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;

  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Days on which something was first solved, over the last twelve weeks.
 *
 * Derived from `progress.first_solved_at`, which is the only activity timestamp the store
 * keeps. That makes this "days you finished something", not "days you worked" — a day spent
 * failing at a hard problem shows as empty, which undersells it. Worth stating rather than
 * papering over: the honest fix is a submission-level activity query, not a fudge here.
 *
 * Emitted as a dense array of 84 counts, oldest first, so the renderer draws cells without
 * doing date arithmetic — and so an empty day is a real zero rather than a gap it has to
 * infer.
 */
function recentActivity(): number[] {
  const DAYS = 84;
  const counts = new Array<number>(DAYS).fill(0);

  // Midnight local, so "today" is the last cell regardless of the current time.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const entry of allProgress()) {
    if (entry.firstSolvedAt === null) continue;
    const solved = parseStoredTimestamp(entry.firstSolvedAt);
    if (solved === undefined) continue;
    // Local midnight of the day that instant falls in — "which day did I solve this on"
    // is a question about the user's calendar, not about UTC's.
    solved.setHours(0, 0, 0, 0);

    const daysAgo = Math.round((today.getTime() - solved.getTime()) / 86_400_000);
    if (daysAgo < 0 || daysAgo >= DAYS) continue;
    counts[DAYS - 1 - daysAgo]! += 1;
  }

  return counts;
}
