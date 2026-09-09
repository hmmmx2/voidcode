"use client";

import { LOCAL_LOAD_FAILURE } from "@/lib/copy";
import { useState, useEffect } from "react";
import { useUserId } from "@/lib/hooks/useUserId";
import { useUserProfile } from "@/lib/context/UserProfileContext";
import { fetchDashboard, type DashboardData } from "@/lib/api/dashboard";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import ResumeBlock from "./ResumeBlock";
import ProgressBand from "./ProgressBand";
import StatStrip from "./StatStrip";
import ProblemBrowser from "./ProblemBrowser";

/**
 * The dashboard.
 *
 * Three bands, in the order a returning user asks the questions: what was I
 * doing, how far in am I, and what is in each track. The previous version was a
 * progress ring beside an avatar, then a flat list of course brochures — it
 * answered the second question and neither of the others.
 *
 * Everything here comes from one `/v1/dashboard` call that already returned all
 * of it. No API change was needed; the data was being discarded client-side.
 */
export default function HomepageClient() {
  const userId = useUserId();
  const { profile } = useUserProfile();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!userId) return;
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

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (isLoading) {
    return (
      /* The skeleton mirrors the real layout's radii and hairlines, so the swap
         does not shift anything. `aria-busy` plus a live region is what tells a
         screen reader something is coming — a pulsing grey box says nothing. */
      <div
        aria-busy="true"
        aria-live="polite"
        className="page-list animate-pulse space-y-10 motion-reduce:animate-none"
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
      <div className="page-list">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            We couldn&rsquo;t load your dashboard
          </h2>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            {LOCAL_LOAD_FAILURE}
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
    <div className="page-list space-y-10">
      {/* Not wrapped in Reveal: this is above the fold, and fading in the
          primary content on load is what makes a page feel slow rather than
          considered. */}
      {/* One decision above the fold, then how far in you are, then the catalogue. The
          order a returning user asks the questions in — the old dashboard led with the
          progress ring, which answers the question nobody opens a dashboard to ask. */}
      <ResumeBlock data={data} userName={userName} />

      {/* Between the decision and the detail: the numbers are context for what you just
          read, not a thing to act on. Renders nothing until there is something in it. */}
      <StatStrip data={data} />

      <ProgressBand data={data} />

      <ProblemBrowser
        problems={data?.problems ?? []}
        categories={data?.categories ?? []}
      />
    </div>
  );

}
