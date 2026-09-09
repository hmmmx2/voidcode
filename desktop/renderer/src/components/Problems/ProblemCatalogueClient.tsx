"use client";

import { LOCAL_LOAD_FAILURE } from "@/lib/copy";
import { useEffect, useState } from "react";
import { useUserId } from "@/lib/hooks/useUserId";
import { fetchDashboard, type DashboardData } from "@/lib/api/dashboard";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import ProblemCatalogue from "./ProblemCatalogue";

/**
 * Data shell for `/problems`.
 *
 * Reuses `/v1/dashboard` rather than adding a `/v1/problems` list endpoint: it
 * already returns every published problem with its categories, difficulty and
 * per-user solved state, which is exactly the catalogue's input. A second
 * endpoint returning the same rows would be a second thing to keep in step.
 */
/**
 * One state machine rather than three booleans.
 *
 * `isLoading` / `failed` / `data` as separate `useState` calls means the effect
 * has to reset two of them synchronously on every run — which the React
 * compiler flags, correctly: a synchronous `setState` in an effect body is an
 * extra render pass before paint. A single union has no invalid combination to
 * reset, so nothing is set until the fetch actually resolves.
 */
type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: DashboardData }
  | { status: "failed" };

export default function ProblemCatalogueClient() {
  const userId = useUserId();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    fetchDashboard(userId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err) => {
        console.error("Failed to load problems:", err);
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
        className="page-list animate-pulse space-y-6 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading problems…</span>
        <div className="h-[220px] rounded-panel border border-line bg-void-2" />
        <div className="h-[520px] rounded-panel border border-line bg-void-2" />
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="page-list">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            We couldn&rsquo;t load the problems
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
    <div className="page-list space-y-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
          Problems
        </p>
        <h1 className="mt-4 max-w-[22ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
          Implement the primitives from scratch.
        </h1>
        <p className="mt-5 max-w-[58ch] text-sm leading-relaxed text-ink-2">
          Every problem is pure Python with no framework imports &mdash; because
          &ldquo;implement attention without a library&rdquo; is the question, and
          reaching for <span className="font-mono text-ink-3">torch.softmax</span>{" "}
          is the failure mode being tested for.
        </p>
      </header>

      <ProblemCatalogue
        problems={state.data.problems}
        categories={state.data.categories}
      />
    </div>
  );
}
