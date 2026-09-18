"use client";

/**
 * One paper: the four breakdowns, the key equations, and the problems that implement it.
 *
 * NO PDF PANE, AND THAT IS A DESKTOP CONSTRAINT RATHER THAN A CHANGE OF MIND. The web version put
 * arXiv's PDF in an iframe beside the text — which worked there because arXiv sets no
 * `X-Frame-Options`. This renderer is served from `app://` under a content policy that allows no
 * cross-origin frame at all, deliberately: a frame is a live page from someone else's server
 * running inside a window that holds an IDE. So the PDF opens in the reader's own browser, which is
 * also where their PDF tools, annotations and printing already are. The button says where it goes.
 *
 * MARKED ON OPEN, NOT ON SCROLL. A scroll-depth check sounds more honest and is worse: it never
 * fires for a short section that does not scroll, and it fires for somebody who flicks to the
 * bottom. Neither measures reading, so the simpler rule is the one that does not pretend — and the
 * library says outright that this counts sections opened.
 *
 * SIGNED OUT, NOTHING IS MARKED AND NOTHING IS BROKEN. `research:markRead` refuses without a
 * session before making a request, so a signed-out reader gets the whole paper and no ticks. The
 * refusal is expected here, so it is not shown as an error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, EmptyState, Math, Surface, useToast } from "@/components/app";
import Markdown from "@/components/markdown/Markdown";
import { Pill } from "@/components/ui/Pill";
import { useAccount } from "@/lib/account/AccountProvider";
import { CURRICULUM } from "@/lib/curriculum";
import { cn } from "@/lib/utils";
import { isSectionKey, type PaperDetail } from "@shared/research";

type State =
  | { status: "loading" }
  | { status: "ready"; paper: PaperDetail }
  | { status: "failed"; message: string };

/** Called as `host().research.method(…)`, the shape `tests/ipc-callers.test.ts` recognises. */
function host(): VoidCodeHost {
  return window.host as VoidCodeHost;
}

export default function PaperReader({ slug }: { slug: string }) {
  const notify = useToast();
  const { state: account } = useAccount();
  const signedIn = account?.signedIn === true;

  const [state, setState] = useState<State>({ status: "loading" });
  const [active, setActive] = useState<string | null>(null);
  const [read, setRead] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const research = window.host?.research;
    if (research === undefined) {
      setState({ status: "failed", message: "The research library is part of the desktop app." });
      return;
    }
    const result = await research.get({ slug });
    if (!result.ok) {
      setState({ status: "failed", message: result.message });
      return;
    }
    setState({ status: "ready", paper: result.paper });
    setRead(result.paper.sectionsRead);
    setActive((current) => current ?? result.paper.sections[0]?.key ?? null);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load, account?.signedIn]);

  /**
   * Fire-and-forget, deduped in the renderer so flicking through four tabs is at most four
   * requests and never one per click.
   *
   * The pending set is a ref rather than state: it must be consulted and updated within one event,
   * and a state update would not be visible until the next render — which is exactly long enough
   * for a double click to send two.
   */
  const pending = useRef(new Set<string>());
  const mark = useCallback(
    (key: string) => {
      if (!signedIn) return;
      if (read.includes(key) || pending.current.has(key)) return;
      /**
       * Narrowed rather than cast. The tab keys arrive from the server as strings and the channel
       * accepts only the four this build knows; a fifth added server-side would be refused at the
       * boundary with "Invalid payload", which says nothing. Ignoring it here means a new
       * breakdown renders and simply is not tracked until this build learns about it.
       */
      if (!isSectionKey(key)) return;
      pending.current.add(key);
      void host()
        .research.markRead({ slug, section: key })
        .then((result) => {
          if (result.ok) setRead(result.sectionsRead);
          // A failure is not worth interrupting reading for: the section is on screen either way,
          // and the tick reappears on the next visit if the request simply did not land.
          else pending.current.delete(key);
        });
    },
    [signedIn, read, slug],
  );

  useEffect(() => {
    if (active !== null) mark(active);
  }, [active, mark]);

  async function openPdf(): Promise<void> {
    setOpening(true);
    try {
      const result = await host().research.openPdf({ slug });
      // Main opens the browser itself, after checking the address our API gave it. The only thing
      // to report here is a refusal.
      if (!result.ok) notify(result.message, { tone: "warn" });
    } finally {
      setOpening(false);
    }
  }

  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="page-content">
        <span className="sr-only">Loading the paper…</span>
        <div className="animate-pulse space-y-6 motion-reduce:animate-none">
          <div className="h-24 rounded-xl border border-line bg-void-2" />
          <div className="h-[420px] rounded-xl border border-line bg-void-2" />
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="page-content">
        <Surface radius="card" className="py-14">
          <EmptyState
            title="That paper is not open"
            body={state.message}
            action={
              <div className="flex items-center gap-2">
                <Pill variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Pill>
                <Pill variant="ghost" size="sm" href="/research">
                  Back to the library
                </Pill>
              </div>
            }
          />
        </Surface>
      </div>
    );
  }

  const { paper } = state;
  const current = paper.sections.find((section) => section.key === active);
  const finished = read.length >= paper.sections.length;

  return (
    <div className="page-content flex flex-col gap-6">
      <header>
        <Link
          href="/research"
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
        >
          <span aria-hidden>←</span> Library
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="max-w-[46ch] text-2xl font-medium leading-tight tracking-tight text-ink">
              {paper.title}
            </h1>
            <p className="mt-2 text-xs text-ink-3">
              {paper.authors} · {paper.year}
              {paper.venue !== null && <> · {paper.venue}</>}
              {paper.arxivId !== null && <> · arXiv:{paper.arxivId}</>}
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-3">
            {signedIn && (
              <span className="font-mono text-[11px] tabular-nums text-ink-3">
                {read.length}/{paper.sections.length} read
              </span>
            )}
            {finished && signedIn && <Badge tone="strong">Finished</Badge>}
            <Pill size="sm" disabled={opening} onClick={() => void openPdf()}>
              {opening ? "Opening…" : "Open PDF"}
            </Pill>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          The PDF opens in your browser — that is where your reader, annotations and printing are.
        </p>
      </header>

      {/* Tabs rather than four headings: the four breakdowns are alternative views of one paper,
          not a sequence to read top to bottom, and a reader usually wants one of them. */}
      <div className="overflow-x-auto border-b border-line">
        <div role="tablist" aria-label="Breakdowns" className="flex gap-1 pb-2">
          {paper.sections.map((section) => {
            const isRead = read.includes(section.key);
            const isActive = section.key === active;
            return (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(section.key)}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium",
                  "transition-colors duration-150 ease-void",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                  isActive ? "bg-ide-raised text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {section.label}
                {isRead && (
                  <span aria-label="read" className="h-1.5 w-1.5 rounded-full bg-ink-3" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-w-[72ch]">
        {current === undefined || current.body.trim() === "" ? (
          <p className="text-sm text-ink-3">
            This breakdown has not been written yet. The other tabs may have been.
          </p>
        ) : (
          <Markdown source={current.body} />
        )}
      </div>

      {/* Equations and cross-links sit under every section rather than in a tab of their own: they
          are reference material you glance at while reading, not a fifth thing to read. */}
      {paper.keyEquations.length > 0 && (
        <Surface radius="card" className="p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
            Key equations
          </p>
          <div className="mt-4 space-y-5">
            {paper.keyEquations.map((equation) => (
              <div key={equation.label}>
                <p className="text-xs font-medium text-ink-2">{equation.label}</p>
                {/* Typeset, and copying gives back the LaTeX — see `Math`. A `<pre>` of source
                    was what the web version showed, which is the specification in the wrong
                    notation on a page whose whole premise is reading the maths. */}
                <Math latex={equation.latex} className="mt-2" />
                {equation.note !== undefined && equation.note !== "" && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{equation.note}</p>
                )}
              </div>
            ))}
          </div>
        </Surface>
      )}

      <RelatedProblems slugs={paper.relatedProblemSlugs} />
    </div>
  );
}

/**
 * Links into the problems that implement this paper's ideas.
 *
 * This is what makes the library part of an application rather than a PDF shelf: reading about
 * scaled dot-product attention and then implementing it, executed and graded, is one click.
 *
 * BY SLUG, NEVER BY POSITION — and `curriculum-parity.test.ts` enforces it, which is how the first
 * version of this component was caught. The web original linked `/problems/{index + 1}`; inserting
 * a problem in the middle of the curriculum then silently re-points every link after it at the
 * wrong exercise. `resolveProblemSlug` accepts both forms, so a slug costs nothing and keeps
 * meaning the same problem.
 *
 * Resolved against `CURRICULUM` so a slug that does not exist is omitted rather than rendered as a
 * dead link — paper content is authored with slugs rather than foreign keys precisely so a paper
 * can name a problem that has not been written yet.
 */
function RelatedProblems({ slugs }: { slugs: string[] }) {
  const resolved = slugs
    .map((slug) => CURRICULUM.find((entry) => entry.slug === slug))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  if (resolved.length === 0) return null;

  return (
    <Surface radius="card" className="p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">Implement it</p>
      <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-3">
        These problems build what this paper describes, and they are executed and graded.
      </p>
      <div className="mt-4 space-y-1">
        {resolved.map((entry) => (
          <Link
            key={entry.slug}
            href={`/problems/${entry.slug}`}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm",
              "transition-colors duration-150 ease-void",
              "text-ink-2 hover:bg-void-3 hover:text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
            )}
          >
            {/* The track, not an ordinal. A number in this gutter would be the position the link
                itself deliberately avoids, printed where a reader could rely on it. */}
            <span className="w-16 flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
              {entry.track}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <span aria-hidden className="text-ink-3">
              →
            </span>
          </Link>
        ))}
      </div>
    </Surface>
  );
}
