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
}

export interface DashboardCategory {
  name: string;
  total: number;
  solved: number;
}

export interface CurrentQuestion {
  orderIndex: number;
  title: string;
  descriptionPreview: string;
  problemSlug: string;
  categories: string[];
}

export interface DashboardData {
  problems: DashboardProblem[];
  categories: DashboardCategory[];
  currentQuestion: CurrentQuestion | null;
  totalProblems: number;
  solvedProblems: number;
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
  };
}

function parseCategory(c: Record<string, unknown>): DashboardCategory {
  return {
    name: c.name as string,
    total: c.total as number,
    solved: c.solved as number,
  };
}

function parseCurrentQuestion(
  q: Record<string, unknown> | null,
): CurrentQuestion | null {
  if (!q) return null;
  return {
    orderIndex: q.order_index as number,
    title: q.title as string,
    descriptionPreview: q.description_preview as string,
    problemSlug: q.problem_slug as string,
    categories: (q.categories as string[]) ?? [],
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
    currentQuestion: parseCurrentQuestion(data.current_question ?? null),
    totalProblems: (data.total_problems as number) ?? 0,
    solvedProblems: (data.solved_problems as number) ?? 0,
  };
}
