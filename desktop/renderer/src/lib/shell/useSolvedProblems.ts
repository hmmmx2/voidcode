"use client";

import { useEffect, useState } from "react";
import { fetchDashboard } from "@/lib/api/dashboard";
import { LOCAL_USER_ID } from "@/lib/hooks/useUserId";

/**
 * Which problems the learner has actually solved.
 *
 * Exists so the projects surfaces can *measure* progress instead of reading a literal. Their
 * milestones each name the problems they need and `dashboard:get` already reports `isSolved` per
 * problem; nothing was joining the two, so a fresh install rendered "In progress — 2/4".
 *
 * `dashboard:get` rather than a new channel, deliberately. It already returns exactly this, and
 * `progress:list` was deleted for being a second way to ask the same question — adding one back for
 * a third surface would undo that.
 *
 * **The empty set is the honest default, and the loading flag matters because of it.** Before the
 * first response `solved` is empty, which is indistinguishable from "nothing solved" — so a caller
 * that ignores `loading` shows "Not started" for a moment on every load. Callers render the count
 * only once this settles.
 *
 * A failure leaves the set empty rather than throwing: a projects page that will not render because
 * the store hiccuped is worse than one that under-reports for a moment, and the count is not the
 * reason someone opened it.
 */
export function useSolvedProblems(): { solved: ReadonlySet<string>; loading: boolean } {
  const [solved, setSolved] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void fetchDashboard(LOCAL_USER_ID)
      .then((data) => {
        if (!live) return;
        setSolved(new Set(data.problems.filter((p) => p.isSolved).map((p) => p.slug)));
      })
      .catch(() => {
        // Deliberately silent. See the header: an empty set is the safe answer.
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, []);

  return { solved, loading };
}
