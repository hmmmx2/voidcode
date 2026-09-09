"use client";

import { useRouter } from "next/navigation";
import { GlassSurface } from "@/components/app";
import FunctionPlot from "./FunctionPlot";
import type { DashboardData } from "@/lib/api/dashboard";

/**
 * One decision, above the fold.
 *
 * The hero this replaces answered "how far in am I" — a progress ring, a percentage, and a
 * by-difficulty breakdown — beside the thing you actually came to do. A percentage next to a
 * call to action competes with it, and the ring won, because a big circle beats a sentence.
 *
 * So the ring moved down to the Progress band where it belongs, and this block does one
 * thing: name the next problem, say why it is worth doing, and offer the single action.
 *
 * Glass is correct here for the same reason it is correct on the chrome and wrong on an IDE
 * panel: this sits at the top of a scrolling page, directly under `AppBackdrop`'s bloom, and
 * scrolls through it. There is real content behind it to refract.
 */
/** What each reason is called, above the title. */
const EYEBROW: Record<NonNullable<DashboardData["nextItem"]>["reason"], string> = {
  finish: "Almost there",
  repair: "Worth another look",
  ready: "Next up",
  blocked: "Groundwork first",
};

export default function ResumeBlock({
  data,
  userName,
}: {
  data: DashboardData | null;
  userName: string;
}) {
  const router = useRouter();
  const current = data?.nextItem;

  /**
   * Where Resume goes.
   *
   * **By id, not by catalogue position.** `resolveProblemSlug` accepts either, and the rest of the
   * app links by position because a list already knows the index it is rendering. This card does
   * not — it would have to translate — and the translation is the part that can be wrong. It also
   * needs no `?? 1` fallback, which would have quietly opened the first problem whenever the
   * position was missing.
   *
   * Clicking this used to land in the Build IDE. Not because of the id form: the `app://` handler
   * finds a route's fallback shell by looking for a sibling directory called `placeholder`, and
   * `/problems/[id]` exported one called `1`. Every problem but the first missed the lookup, fell
   * through to the root `index.html`, and was redirected to `/build`. Fixed in that route and
   * covered by `tests/app-scheme.test.ts`.
   */
  const href =
    current === null || current === undefined
      ? ""
      : `/${current.kind === "question" ? "interviews" : "problems"}/${current.itemId}`;

  /**
   * The curve, from the dashboard payload rather than a fetch.
   *
   * An earlier version fetched the problem detail here, which executes its reference. That
   * was wrong twice over: `runInSandbox` allows one job at a time and a second *supersedes*
   * the first, so simply opening the dashboard could cancel a submission the learner was
   * waiting on — and in the smoke it deadlocked against the exec checks outright.
   *
   * Main now derives it from the already-cached answer key and never executes. So it is
   * absent on a cold start and appears once the problem has been opened, which is the right
   * trade: a missing curve costs nothing, a cancelled run costs work.
   */
  const plot = data?.plot;


  // Everything solved. A completed state, not an empty one — the difference matters to
  // someone who just finished the last problem.
  if (current === null || current === undefined) {
    return (
      <GlassSurface radius="panel" className="p-8">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
          Nothing queued
        </p>
        <h1 className="mt-2 text-2xl font-light tracking-tight text-ink">
          You have solved everything, {userName}.
        </h1>
        <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-2">
          New problems arrive with each paper added to the catalogue. In the meantime, a
          project is the natural next step — it is where these pieces have to work together.
        </p>
        <button
          type="button"
          onClick={() => router.push("/projects")}
          className="mt-6 rounded-lg bg-ink px-4 py-2 text-[13px] text-void-0 transition-opacity duration-150 ease-void hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-void-0"
        >
          Browse projects
        </button>
      </GlassSurface>
    );
  }

  return (
    <GlassSurface radius="panel" className="flex items-center justify-between gap-8 p-8">
      <div className="min-w-0 flex-1">
      {/* Four situations, four labels. "Continue" was true of everything and therefore said
          nothing; the reason is already computed, so the eyebrow may as well carry it. */}
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
        {EYEBROW[current.reason]}
      </p>

      {/* Display weight 300, and the largest type on the page — this is the one thing the
          eye should land on. */}
      <h1 className="mt-2 max-w-[20ch] text-3xl font-light leading-tight tracking-tight text-ink">
        {current.title}
      </h1>

      <p className="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-ink-2">
        {current.descriptionPreview}
      </p>

      {/* The reason, in the recommender's own words.
          This is the difference between a queue and a recommendation: "you passed 3 of 4 tests
          here last time" is something a learner can agree or disagree with, and the first
          unsolved item in array order never had anything to say for itself. */}
      {current.why !== "" && (
        <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-ink-3">{current.why}</p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => router.push(href)}
          className="rounded-lg bg-ink px-4 py-2 text-[13px] text-void-0 transition-opacity duration-150 ease-void hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-void-0"
        >
          Resume
        </button>

        {/* Metadata sits beside the action, not above the headline: it is context for the
            decision, not part of it. */}
        <span className="font-mono text-[11px] text-ink-3">
          {current.orderIndex === undefined
            ? "Interview question"
            : `Problem ${String(current.orderIndex)}`}
        </span>
      </div>
      </div>

      {/* The right half was dead space. It now holds the thing this exercise actually
          computes — and only when there genuinely is a curve, so the layout degrades to the
          original single column rather than showing an empty frame. */}
      {plot !== undefined && (
        <div className="hidden lg:block">
          <FunctionPlot
            output={plot.output}
            {...(plot.input !== undefined ? { input: plot.input } : {})}
            label="reference output"
          />
        </div>
      )}
    </GlassSurface>
  );
}
