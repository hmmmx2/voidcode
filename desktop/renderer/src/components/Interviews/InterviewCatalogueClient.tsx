"use client";

import { LOCAL_LOAD_FAILURE } from "@/lib/copy";
import { useEffect, useState } from "react";
import { useUserId } from "@/lib/hooks/useUserId";
import { fetchInterviews, type InterviewListData } from "@/lib/api/interviews";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import InterviewCatalogue from "./InterviewCatalogue";

/** See `ProblemCatalogueClient` for why this is one union and not three booleans. */
type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: InterviewListData }
  | { status: "failed" };

export default function InterviewCatalogueClient() {
  const userId = useUserId();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    fetchInterviews(userId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err) => {
        console.error("Failed to load interview questions:", err);
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="page-grid animate-pulse space-y-6 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading questions…</span>
        <div className="h-[120px] rounded-panel border border-line bg-void-2" />
        <div className="h-[240px] rounded-panel border border-line bg-void-2" />
        <div className="h-[420px] rounded-panel border border-line bg-void-2" />
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="page-grid">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            We couldn&rsquo;t load the questions
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

  return (
    <div className="page-grid space-y-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
          Elite Interview
        </p>
        <h1 className="mt-4 max-w-[24ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
          Every question has an answer you can check.
        </h1>
        <p className="mt-5 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          No &ldquo;walk me through your thinking&rdquo;. Each one asks you to
          derive something, compute something, or write the fifteen lines you
          would put on a whiteboard &mdash; and hides its answer until you ask.
          Full implementations, run against test cases, live in{" "}
          <span className="text-ink">Problems</span> instead.
        </p>
      </header>

      <InterviewCatalogue data={state.data} />
    </div>
  );
}
