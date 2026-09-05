"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSessionUser } from "@/lib/hooks/useUserId";
import { Badge, GlassSurface, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import { fetchPapers, type PaperLibrary, type PaperSummary } from "@/lib/api/papers";

/**
 * The paper library.
 *
 * Deliberately a third shape again. Problems are a queue (flat list, curriculum
 * order); interviews are a map (domain-grouped cards); this is a shelf — a few
 * items, each substantial, where the useful metadata is provenance (who, when,
 * where published) and how far through it you are.
 *
 * So: wide rows rather than a grid. A paper's title and author list do not fit
 * a card without truncation, and truncating an author list is how you lose the
 * name someone was scanning for.
 */

type State =
  | { status: "loading" }
  | { status: "ready"; data: PaperLibrary }
  | { status: "failed" };

export default function PaperLibraryClient() {
  const { userId, ready } = useSessionUser();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    // Guard on `ready`, not on `userId`. `useUserId` returns undefined both while the
    // session resolves AND when there is no id at all, so `if (!userId) return` with
    // isLoading initialised true hangs on the skeleton forever for a signed-out reader.
    // The API serves the public catalogue to an anonymous caller, so fetch either way.
    if (!ready) return;
    let cancelled = false;

    fetchPapers(userId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err) => {
        console.error("Failed to load papers:", err);
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [userId, ready]);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto max-w-4xl animate-pulse space-y-6 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading papers…</span>
        <div className="h-[120px] rounded-panel border border-line bg-void-2" />
        <div className="h-[400px] rounded-panel border border-line bg-void-2" />
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="mx-auto max-w-4xl">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            We couldn&rsquo;t load the library
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

  const { papers, progress } = state.data;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
          Research
        </p>
        <h1 className="mt-4 max-w-[24ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
          The papers, and what they actually say.
        </h1>
        <p className="mt-5 max-w-[60ch] text-sm leading-relaxed text-ink-2">
          Each one comes with four breakdowns &mdash; what it is, what you would
          type, what it costs to run, and why the maths works &mdash; sitting
          beside the PDF. Where a paper describes something you can implement,
          it links straight to the problem that grades it.
        </p>
      </header>

      {papers.length > 0 && (
        <GlassSurface radius="panel" className="p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
                Sections read
              </p>
              <p className="mt-2 flex items-baseline gap-2 text-ink">
                <span className="text-[2rem] font-light leading-none tabular-nums tracking-tight">
                  {progress.sectionsRead}
                </span>
                <span className="text-base font-light text-ink-3">
                  / {progress.sectionsTotal}
                </span>
              </p>
            </div>
            <p className="max-w-[40ch] text-xs leading-relaxed text-ink-3">
              {/* Said plainly, because a reading percentage invites the
                  assumption that it measures understanding. It does not. */}
              This counts sections opened, not sections understood &mdash; it is
              the only part of reading a paper this can honestly measure.
            </p>
          </div>
          <div className="mt-5 h-px w-full overflow-hidden bg-line">
            <div
              className="h-full bg-ink transition-[width] duration-500 ease-void"
              style={{
                width: `${
                  progress.sectionsTotal
                    ? (progress.sectionsRead / progress.sectionsTotal) * 100
                    : 0
                }%`,
              }}
            />
          </div>
        </GlassSurface>
      )}

      <Surface radius="panel" className="divide-y divide-line overflow-hidden">
        {papers.map((paper) => (
          <PaperRow key={paper.slug} paper={paper} />
        ))}

        {papers.length === 0 && (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-2">No papers yet.</p>
            <p className="mx-auto mt-1 max-w-[44ch] text-xs leading-relaxed text-ink-3">
              A paper is only useful here once its four breakdowns are written,
              so the library grows slowly on purpose.
            </p>
          </div>
        )}
      </Surface>
    </div>
  );
}

function PaperRow({ paper }: { paper: PaperSummary }) {
  const readCount = paper.sectionsRead.length;
  const pct = paper.sectionCount ? (readCount / paper.sectionCount) * 100 : 0;

  return (
    <Link
      href={`/research/${paper.slug}`}
      className={cn(
        "group block px-5 py-5",
        "transition-colors duration-150 ease-void hover:bg-void-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium leading-snug text-ink-2 transition-colors group-hover:text-ink">
            {paper.title}
          </h2>
          <p className="mt-1 truncate text-xs text-ink-3">
            {paper.authors} &middot; {paper.year}
            {paper.venue && <> &middot; {paper.venue}</>}
          </p>
          <p className="mt-3 line-clamp-2 max-w-[70ch] text-xs leading-relaxed text-ink-3">
            {paper.abstract}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          <Badge tone={paper.difficulty === "hard" ? "strong" : "quiet"}>
            {paper.difficulty}
          </Badge>
          {paper.completedAt && <Badge tone="strong">Finished</Badge>}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="h-[3px] w-24 overflow-hidden rounded-full bg-void-3">
          <div
            className="h-full rounded-full bg-ink transition-[width] duration-500 ease-void"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[10px] tabular-nums text-ink-3">
          {readCount}/{paper.sectionCount} sections
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {paper.categories.map((c) => (
            <span
              key={c}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3"
            >
              {c}
            </span>
          ))}
        </span>
      </div>
    </Link>
  );
}
