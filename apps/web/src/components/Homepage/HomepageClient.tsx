"use client";

import { useState, useEffect } from "react";
import { useSessionUser } from "@/lib/hooks/useUserId";
import { useUserProfile } from "@/lib/context/UserProfileContext";
import { fetchDashboard, type DashboardData } from "@/lib/api/dashboard";
import {
  fetchRecommendations,
  type Recommendations,
} from "@/lib/api/recommendations";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import ProgressHero from "./ProgressHero";
import ProblemBrowser from "./ProblemBrowser";
import RecommendedNext from "./RecommendedNext";

/**
 * The dashboard.
 *
 * Three bands, in the order a returning user asks the questions: what was I
 * doing, how far in am I, and what is in each track. The previous version was a
 * progress ring beside an avatar, then a flat list of course brochures — it
 * answered the second question and neither of the others.
 *
 * The first three bands come from one `/v1/dashboard` call that already
 * returned all of it. No API change was needed; the data was being discarded
 * client-side.
 *
 * `/v1/recommendations` is fetched SEPARATELY AND ALLOWED TO FAIL ALONE. It is
 * the newest and most fragile path — it reads the concept join, the taxonomy and
 * optionally a trained ranker — and folding it into the dashboard's error state
 * would let a missing model artefact blank a page that otherwise works fine.
 */
export default function HomepageClient() {
  const { userId, ready } = useSessionUser();
  const { profile } = useUserProfile();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [recsLoading, setRecsLoading] = useState(true);

  useEffect(() => {
    // Guard on `ready`, not on `userId`. `useUserId` returns undefined both while the
    // session resolves AND when there is no id at all, so `if (!userId) return` with
    // isLoading initialised true hangs on the skeleton forever for a signed-out reader.
    // The API serves the public catalogue to an anonymous caller, so fetch either way.
    if (!ready) return;
    let cancelled = false;

    setIsLoading(true);
    setFailed(false);
    fetchDashboard(userId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        console.error("Failed to load dashboard:", err);
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    // Deliberately not chained onto the dashboard fetch: these are independent
    // reads and serialising them would add a round trip to first paint for no
    // reason. A failure here logs and renders nothing — see the header.
    setRecsLoading(true);
    fetchRecommendations(userId)
      .then((result) => {
        if (!cancelled) setRecs(result);
      })
      .catch((err) => {
        console.error("Failed to load recommendations:", err);
        if (!cancelled) setRecs(null);
      })
      .finally(() => {
        if (!cancelled) setRecsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, ready]);

  if (isLoading) {
    return (
      /* The skeleton mirrors the real layout's radii and hairlines, so the swap
         does not shift anything. `aria-busy` plus a live region is what tells a
         screen reader something is coming — a pulsing grey box says nothing. */
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto max-w-6xl animate-pulse space-y-10 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading your dashboard…</span>
        <div className="h-[300px] rounded-panel border border-line bg-void-2" />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="h-[380px] rounded-panel border border-line bg-void-2" />
          <div className="h-[380px] rounded-panel border border-line bg-void-2" />
        </div>
      </div>
    );
  }

  // The API being unreachable used to surface as an empty dashboard that looked
  // like an account with no courses. Say which it is.
  if (failed) {
    return (
      <div className="mx-auto max-w-6xl">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            We couldn&rsquo;t load your dashboard
          </h2>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            The API didn&rsquo;t respond. If you&rsquo;re running this locally,
            check that the API server is up on port 8000.
          </p>
          <Pill
            variant="outline"
            size="md"
            className="mt-6"
            onClick={() => window.location.reload()}
          >
            Try again
          </Pill>
        </Surface>
      </div>
    );
  }

  const userName = (profile?.name ?? "there").split(" ")[0];

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      {/* Not wrapped in Reveal: this is above the fold, and fading in the
          primary content on load is what makes a page feel slow rather than
          considered. */}
      <ProgressHero data={data} userName={userName} />

      <RecommendedNext recs={recs} isLoading={recsLoading} />

      <ProblemBrowser
        problems={data?.problems ?? []}
        categories={data?.categories ?? []}
      />
    </div>
  );

}
