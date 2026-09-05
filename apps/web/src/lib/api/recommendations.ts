/**
 * Recommendations API client.
 *
 * WHY `rankedBy` IS PART OF THE CONTRACT AND NOT AN IMPLEMENTATION DETAIL
 *
 * The API ranks either with a trained LambdaMART model or with a mastery
 * heuristic, and it says which. Both return a well-formed, plausible list — at
 * this boundary they are indistinguishable.
 *
 * The model refuses to fit below two learners or ten examples, which is the
 * platform's current state, so everything served today comes from the
 * heuristic. A UI that says "picked for you by our model" over heuristic output
 * is making a personalisation claim nobody measured. The field exists so the
 * copy can track the truth, and `RecommendationHeading` below is the only place
 * that decides what to say.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ────────────────────────────────────────────────────────

/** Why a problem surfaced, strongest signal first. Mirrors `SOURCE_RANK`. */
export type RecommendationReason =
  | "weak_concept"
  | "prerequisite"
  | "coverage_gap";

export interface RecommendedProblem {
  slug: string;
  title: string | null;
  conceptId: string;
  reasons: RecommendationReason[];
  /** A sentence written by the API, already matched to the strongest reason. */
  explanation: string;
  /** The learner's mastery of `conceptId`, or null if never attempted. */
  mastery: number | null;
  /** The model's score, or null when no model ranked this. Not zero — zero is a score. */
  score: number | null;
}

export interface Recommendations {
  items: RecommendedProblem[];
  /** `"model"` or `"mastery"`. See the file header — this drives the copy. */
  rankedBy: "model" | "mastery";
  /** True when the learner has no attempts at all, so the list is pure coverage. */
  coldStart: boolean;
  weakConcepts: string[];
  attemptsConsidered: number;
}

// ── Copy ─────────────────────────────────────────────────────────

/**
 * What the section is allowed to claim, given how the list was actually built.
 *
 * Three states, not two. "No attempts yet" and "ranked without a model" are
 * different situations and neither of them is personalisation, but they need
 * different sentences — one is about the learner, the other about us.
 */
export function recommendationHeading(recs: Recommendations): {
  title: string;
  subtitle: string;
} {
  if (recs.coldStart) {
    return {
      title: "Starting points",
      subtitle:
        "You haven't attempted anything yet, so these cover the foundations rather than your progress.",
    };
  }
  if (recs.rankedBy === "model") {
    return {
      title: "Recommended for you",
      subtitle: `Ranked from your ${recs.attemptsConsidered} attempts.`,
    };
  }
  return {
    title: "Based on your progress",
    subtitle: `Drawn from the concepts your ${recs.attemptsConsidered} attempts suggest are weakest.`,
  };
}

// ── Parsers ──────────────────────────────────────────────────────

function parseItem(r: Record<string, unknown>): RecommendedProblem {
  return {
    slug: r.slug as string,
    // Falls back to the slug rather than rendering "null": a recommendation with
    // no title is a data problem worth seeing, not one worth hiding.
    title: (r.title as string) ?? null,
    conceptId: r.concept_id as string,
    reasons: (r.reasons as RecommendationReason[]) ?? [],
    explanation: r.explanation as string,
    mastery: (r.mastery as number | null) ?? null,
    score: (r.score as number | null) ?? null,
  };
}

// ── API Function ─────────────────────────────────────────────────

export async function fetchRecommendations(
  userId?: string,
  limit = 5,
): Promise<Recommendations> {
  const res = await fetch(`${API_BASE}/v1/recommendations?limit=${limit}`, {
    headers: makeHeaders(userId),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch recommendations: ${res.status}`);
  }

  const data = await res.json();

  return {
    items: ((data.items as Record<string, unknown>[]) ?? []).map(parseItem),
    // Defaults to the weaker claim. If the field is ever missing — an older API,
    // a proxy that strips it — the UI should under-claim rather than over-claim.
    rankedBy: data.ranked_by === "model" ? "model" : "mastery",
    coldStart: (data.cold_start as boolean) ?? true,
    weakConcepts: (data.weak_concepts as string[]) ?? [],
    attemptsConsidered: (data.attempts_considered as number) ?? 0,
  };
}
