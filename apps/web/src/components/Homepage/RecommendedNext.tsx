"use client";

import Link from "next/link";
import { Badge, Surface } from "@/components/app";
import {
  recommendationHeading,
  type Recommendations,
} from "@/lib/api/recommendations";

interface RecommendedNextProps {
  recs: Recommendations | null;
  /** Distinguishes "still loading" from "loaded and empty" — they look identical otherwise. */
  isLoading: boolean;
}

/**
 * What to work on next, and why.
 *
 * THE HEADING IS NOT DECORATION
 *
 * The API ranks either with a trained model or with a mastery heuristic and
 * reports which. Both produce well-formed, plausible lists. Today the model
 * declines to fit — it needs more learners than this platform has — so every
 * list served is the heuristic, and the copy says "Based on your progress"
 * rather than "Recommended for you".
 *
 * That distinction is the whole reason `ranked_by` travels through three layers
 * to reach this component. A section that claims personalisation over heuristic
 * output is making a claim nobody measured, and the person most likely to be
 * misled by it is the one building the product.
 *
 * EVERY ROW CARRIES ITS REASON
 *
 * "You have been struggling with backpropagation" is written by the API from the
 * candidate source, so the explanation cannot drift from the ranking that
 * produced it. A recommendation nobody can explain is one nobody can debug, and
 * a learner deserves to know why they are being sent somewhere.
 */
export default function RecommendedNext({
  recs,
  isLoading,
}: RecommendedNextProps) {
  if (isLoading) {
    return (
      <Surface
        radius="panel"
        aria-busy="true"
        aria-live="polite"
        className="animate-pulse p-6 motion-reduce:animate-none"
      >
        <span className="sr-only">Working out what to suggest next…</span>
        <div className="h-5 w-48 rounded bg-void-3" />
        <div className="mt-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-card bg-void-2" />
          ))}
        </div>
      </Surface>
    );
  }

  // Not an error. An empty list means the catalog has nothing untagged-and-
  // unsolved left to offer, which is a real state and reads as a bug if the
  // section simply vanishes.
  if (!recs || recs.items.length === 0) {
    return null;
  }

  const { title, subtitle } = recommendationHeading(recs);

  return (
    <Surface radius="panel" className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium text-ink">{title}</h2>
        {/* Shown only when a model actually ranked. Absent is the honest default:
            "heuristic" is the norm here, and labelling every list with how it was
            built would make the badge noise rather than information. */}
        {recs.rankedBy === "model" && <Badge tone="quiet">Ranked</Badge>}
      </div>
      <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-ink-2">
        {subtitle}
      </p>

      <ul className="mt-5 space-y-2">
        {recs.items.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/problems/${item.slug}`}
              className="group flex items-center justify-between gap-4 rounded-card border border-line bg-void-2 px-4 py-3 transition-colors hover:border-line-strong hover:bg-void-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">
                  {/* The slug rather than "null": a missing title is a data
                      problem worth seeing, not one worth hiding behind an em dash. */}
                  {item.title ?? item.slug}
                </span>
                <span className="mt-0.5 block truncate text-xs leading-relaxed text-ink-3">
                  {item.explanation}
                </span>
              </span>
              {/* Mastery is shown only where it was measured. A never-attempted
                  concept has no score, and rendering 0% would say the learner
                  failed at something they have never seen. */}
              {item.mastery !== null && (
                <Badge tone="quiet">{Math.round(item.mastery * 100)}%</Badge>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Surface>
  );
}
