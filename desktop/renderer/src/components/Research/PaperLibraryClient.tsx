"use client";

/**
 * The paper library.
 *
 * A SHELF, NOT A GRID — and that is the third shape this application uses on purpose. Problems are
 * a queue (flat, curriculum order); interviews are a map (domain-grouped cards); this is a shelf:
 * a few substantial items whose useful metadata is provenance — who wrote it, when, where it was
 * published — and how far through it you are. Wide rows, because a title and an author list do not
 * fit a card without truncation, and truncating an author list loses the name somebody was
 * scanning for.
 *
 * NOTHING IS FETCHED UNTIL THIS PAGE IS OPENED. The library is a network feature, disclosed in the
 * Privacy Policy alongside the VoidCode model and the credit balance; the section rail deliberately
 * shows no paper count, because a count in the sidebar would mean fetching the index to draw the
 * chrome of every other page.
 *
 * THE LIBRARY READS SIGNED OUT. Progress is the only part that needs an account, so the page is
 * whole without one and says what signing in would add — rather than gating a public catalogue
 * behind a form.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, EmptyState, GlassSurface, ProgressBar, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { useAccount } from "@/lib/account/AccountProvider";
import { cn } from "@/lib/utils";
import type { PaperLibrary, PaperSummary } from "@shared/research";

type State =
  | { status: "loading" }
  | { status: "ready"; library: PaperLibrary }
  | { status: "failed"; message: string };

export default function PaperLibraryClient() {
  const { state: account, available, openSignIn } = useAccount();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async (): Promise<void> => {
    const research = window.host?.research;
    if (research === undefined) {
      setState({
        status: "failed",
        message: "The research library is part of the desktop app.",
      });
      return;
    }
    const result = await research.list();
    setState(
      result.ok
        ? { status: "ready", library: result.library }
        : { status: "failed", message: result.message },
    );
  }, []);

  useEffect(() => {
    void load();
    // Re-read when a session starts or ends: the ticks belong to whoever is signed in, and a
    // library still showing the previous reader's progress is the wrong kind of wrong.
  }, [load, account?.signedIn]);

  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="page-content">
        <span className="sr-only">Loading the library…</span>
        <div className="animate-pulse space-y-6 motion-reduce:animate-none">
          <div className="h-[120px] rounded-xl border border-line bg-void-2" />
          <div className="h-[400px] rounded-xl border border-line bg-void-2" />
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="page-content">
        <Surface bordered radius="card" className="py-14">
          <EmptyState
            title="The research library needs a connection"
            body={state.message}
            action={
              <Pill variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Pill>
            }
          />
        </Surface>
      </div>
    );
  }

  const { papers, progress } = state.library;
  const signedIn = account?.signedIn === true;

  return (
    <div className="page-content flex flex-col gap-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">Research</p>
        <h1 className="mt-4 max-w-[24ch] text-[clamp(1.75rem,3.2vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
          The papers, and what they actually say.
        </h1>
        <p className="mt-5 max-w-[60ch] text-sm leading-relaxed text-ink-2">
          Each one comes with four breakdowns — what it is, what you would type, what it costs to
          run, and why the maths works. Where a paper describes something you can implement, it
          links straight to the problem that grades it.
        </p>
      </header>

      {papers.length > 0 && (
        <GlassSurface radius="card" className="p-6">
          {signedIn ? (
            <>
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
                  <p className="mt-2 text-xs text-ink-3">
                    {progress.finished} of {progress.papers}{" "}
                    {progress.papers === 1 ? "paper" : "papers"} finished
                  </p>
                </div>
                <p className="max-w-[40ch] text-xs leading-relaxed text-ink-3">
                  {/* Said plainly, because a reading percentage invites the assumption that it
                      measures understanding. It does not, and it cannot. */}
                  This counts sections opened, not sections understood — it is the only part of
                  reading a paper this can honestly measure.
                </p>
              </div>
              <ProgressBar
                label="Sections read"
                size="sm"
                className="mt-5"
                value={
                  progress.sectionsTotal === 0
                    ? 0
                    : (progress.sectionsRead / progress.sectionsTotal) * 100
                }
              />
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-[54ch] text-sm leading-relaxed text-ink-2">
                Every paper and every breakdown is here without an account. Signing in only adds a
                record of which sections you have read, kept on our server.
              </p>
              {available && (
                <Pill variant="outline" size="sm" onClick={() => openSignIn("signIn")}>
                  Sign in to track your reading
                </Pill>
              )}
            </div>
          )}
        </GlassSurface>
      )}

      <Surface bordered radius="card" className="divide-y divide-line-strong overflow-hidden">
        {papers.map((paper) => (
          <PaperRow key={paper.slug} paper={paper} showProgress={signedIn} />
        ))}

        {papers.length === 0 && (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-2">No papers yet.</p>
            <p className="mx-auto mt-1 max-w-[44ch] text-xs leading-relaxed text-ink-3">
              A paper is only useful here once its four breakdowns are written, so the library grows
              slowly on purpose.
            </p>
          </div>
        )}
      </Surface>
    </div>
  );
}

function PaperRow({ paper, showProgress }: { paper: PaperSummary; showProgress: boolean }) {
  const readCount = paper.sectionsRead.length;
  const pct = paper.sectionCount === 0 ? 0 : (readCount / paper.sectionCount) * 100;

  return (
    <Link
      href={`/research/${paper.slug}`}
      className={cn(
        "group block px-5 py-5",
        "transition-colors duration-150 ease-void hover:bg-void-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium leading-snug text-ink-2 transition-colors group-hover:text-ink">
            {paper.title}
          </h2>
          <p className="mt-1 truncate text-xs text-ink-3">
            {paper.authors} · {paper.year}
            {paper.venue !== null && <> · {paper.venue}</>}
          </p>
          <p className="mt-3 line-clamp-2 max-w-[70ch] text-xs leading-relaxed text-ink-3">
            {paper.abstract}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          <Badge tone={paper.difficulty === "hard" ? "strong" : "quiet"}>{paper.difficulty}</Badge>
          {paper.completedAt !== null && <Badge tone="strong">Finished</Badge>}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {/* The bar and the count are omitted rather than zeroed when signed out: a 0/4 beside every
            paper looks like a reader who has read nothing, not like a feature that needs an
            account. */}
        {showProgress && (
          <>
            <div className="h-[3px] w-24 overflow-hidden rounded-full bg-void-3">
              <div
                className="h-full rounded-full bg-ink transition-[width] duration-500 ease-void"
                style={{ width: `${String(pct)}%` }}
              />
            </div>
            <span className="font-mono text-[10px] tabular-nums text-ink-3">
              {readCount}/{paper.sectionCount} sections
            </span>
          </>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {paper.categories.map((category) => (
            <span
              key={category}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3"
            >
              {category}
            </span>
          ))}
        </span>
      </div>
    </Link>
  );
}
