/**
 * Dashboard API client.
 *
 * The response used to be a course-shaped tree. Courses are gone; problems now
 * carry a `categories` array, so this is a flat problem list plus per-category
 * counts.
 *
 * CATEGORY TOTALS DELIBERATELY OVERLAP. A problem tagged both DL and LLM counts
 * once in each, so summing `categories[].total` exceeds `totalProblems`. They
 * answer different questions — "how much DL is there" versus "how many problems
 * are there" — and any UI adding the category totals together to get a grand
 * total is reading them wrong.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ────────────────────────────────────────────────────────

export interface DashboardProblem {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  categories: string[];
  orderIndex: number;
  isSolved: boolean;
  /** Runs recorded against this problem, solved or not. */
  attemptCount: number;
  /**
   * The furthest any submission got. Absent when nothing has been run — which is a different
   * state from 0 of 4, and the list renders them differently.
   */
  best?: { passed: number; total: number; at: string };
}

export interface DashboardCategory {
  name: string;
  total: number;
  solved: number;
}

/**
 * What to do next, with the reason it was chosen.
 *
 * Replaces `CurrentQuestion`, which described the first unsolved problem in catalogue order and
 * so had nothing to explain. Two differences matter to the UI: `why` is shown verbatim, and
 * `kind` decides the route — the recommender spans interview questions as well as curriculum
 * problems, and those live under a different path.
 */
export interface NextItem {
  itemId: string;
  kind: "problem" | "question";
  title: string;
  reason: "finish" | "repair" | "ready" | "blocked";
  /** One sentence, already written for the learner. Not assembled here. */
  why: string;
  conceptIds: string[];
  descriptionPreview: string;
  /** Catalogue position. Problems only — questions are not in that list. */
  orderIndex?: number;
}

export interface ConceptProgress {
  id: string;
  name: string;
  category: string;
  total: number;
  solid: number;
  inProgress: number;
  ready: boolean;
}

export interface DashboardData {
  problems: DashboardProblem[];
  categories: DashboardCategory[];
  nextItem: NextItem | null;
  concepts: ConceptProgress[];
  totalProblems: number;
  solvedProblems: number;
  /**
   * 84 daily counts, oldest first, for the activity strip.
   *
   * Days something was first *solved* — the only activity timestamp the store keeps — so a
   * day spent failing at a hard problem reads as empty. Stated in the UI rather than left
   * to look like a bug.
   */
  activity: number[];
  /** The resume card's curve, when main had one cached. Absent on a cold start. */
  plot?: { input?: number[]; output: number[] };
  /** The four numerals across the top. Derived in main so the streak logic is testable. */
  stats?: {
    solved: number;
    streakDays: number;
    attempts: number;
    /** 0–100 across every case reached. Absent until something has been run. */
    caseRate?: number;
  };
}

interface RawStats {
  solved: number;
  streak_days: number;
  attempts: number;
  case_rate?: number;
}

/** Narrow before reading — a partial block would render `NaN` in the strip. */
function isStats(value: unknown): value is RawStats {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.solved === "number" &&
    typeof s.streak_days === "number" &&
    typeof s.attempts === "number"
  );
}

// ── Parsers ──────────────────────────────────────────────────────

function parseProblem(p: Record<string, unknown>): DashboardProblem {
  return {
    id: p.id as string,
    slug: p.slug as string,
    title: p.title as string,
    difficulty: p.difficulty as string,
    categories: (p.categories as string[]) ?? [],
    orderIndex: p.order_index as number,
    isSolved: p.is_solved as boolean,
    attemptCount: (p.attempt_count as number) ?? 0,
    // All three or none: a partial record would render "3 of undefined cases".
    ...(typeof p.best_passed === "number" && typeof p.best_total === "number"
      ? {
          best: {
            passed: p.best_passed,
            total: p.best_total,
            at: (p.last_attempted_at as string) ?? "",
          },
        }
      : {}),
  };
}

function parseCategory(c: Record<string, unknown>): DashboardCategory {
  return {
    name: c.name as string,
    total: c.total as number,
    solved: c.solved as number,
  };
}

function parseNextItem(n: Record<string, unknown> | null): NextItem | null {
  if (!n) return null;
  const orderIndex = n.order_index as number | undefined;
  return {
    itemId: n.item_id as string,
    // Defaulted rather than asserted: `kind` drives the route, and a payload missing it should
    // send someone to a problem that may not exist rather than to `/undefined/…`.
    kind: n.kind === "question" ? "question" : "problem",
    title: n.title as string,
    reason: (n.reason as NextItem["reason"]) ?? "ready",
    why: (n.why as string) ?? "",
    conceptIds: (n.concept_ids as string[]) ?? [],
    descriptionPreview: (n.description_preview as string) ?? "",
    ...(orderIndex === undefined ? {} : { orderIndex }),
  };
}

function parseConcept(c: Record<string, unknown>): ConceptProgress {
  return {
    id: c.id as string,
    name: c.name as string,
    category: c.category as string,
    total: (c.total as number) ?? 0,
    solid: (c.solid as number) ?? 0,
    inProgress: (c.in_progress as number) ?? 0,
    ready: c.ready === true,
  };
}

// ── API Function ─────────────────────────────────────────────────

export async function fetchDashboard(
  userId?: string,
): Promise<DashboardData> {
  const res = await fetch(`${API_BASE}/v1/dashboard`, {
    headers: makeHeaders(userId),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch dashboard: ${res.status}`);
  }

  const data = await res.json();

  return {
    problems: ((data.problems as Record<string, unknown>[]) ?? []).map(parseProblem),
    categories: ((data.categories as Record<string, unknown>[]) ?? []).map(parseCategory),
    nextItem: parseNextItem(data.next_item ?? null),
    concepts: ((data.concepts as Record<string, unknown>[]) ?? []).map(parseConcept),
    totalProblems: (data.total_problems as number) ?? 0,
    solvedProblems: (data.solved_problems as number) ?? 0,
    // Length-checked, not just presence-checked: a short array would silently draw a
    // truncated strip that looks like "you have only been here a week".
    activity: Array.isArray(data.activity) && data.activity.length === 84
      ? (data.activity as number[])
      : new Array<number>(84).fill(0),
    ...(data.plot !== undefined && data.plot !== null
      ? { plot: data.plot as DashboardData["plot"] }
      : {}),
    ...(isStats(data.stats)
      ? {
          stats: {
            solved: data.stats.solved,
            streakDays: data.stats.streak_days,
            attempts: data.stats.attempts,
            // Only when main sent one. Defaulting to 0 here would turn "nothing attempted"
            // into "everything failed".
            ...(typeof data.stats.case_rate === "number"
              ? { caseRate: data.stats.case_rate }
              : {}),
          },
        }
      : {}),
  };
}
