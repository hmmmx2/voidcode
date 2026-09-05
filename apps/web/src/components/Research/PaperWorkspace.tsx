"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Surface } from "@/components/app";
import { Prose } from "@/components/ui/Prose";
import { cn } from "@/lib/utils";
import { markSectionRead, type PaperDetail } from "@/lib/api/papers";
import { CURRICULUM } from "@/lib/curriculum";

/**
 * One paper: the PDF on the left, the breakdown on the right.
 *
 * WHY AN IFRAME AND NOT `react-pdf`.
 *
 * Checked rather than assumed: arXiv responds with `access-control-allow-origin:
 * *` and sets no `X-Frame-Options`, so the file both fetches cross-origin and
 * frames cleanly. Given that, `react-pdf` would add `pdfjs-dist` — around a
 * megabyte, plus a worker file that has to be served and version-matched — to
 * reimplement scrolling, zoom, search, text selection and printing that the
 * browser's own viewer already does better.
 *
 * The case for `react-pdf` is control: highlighting a passage, or scrolling the
 * PDF to the page a section refers to. Neither exists yet. When one does, this
 * component is the only thing that changes.
 *
 * THE SPLIT IS THE POINT. A paper and its explanation are read together —
 * you look at Figure 1 while reading what the architecture section says about
 * it. Stacked, that is a scroll each way, and the explanation stops being
 * anchored to the thing it explains.
 */

export default function PaperWorkspace({
  paper,
  userId,
}: {
  paper: PaperDetail;
  userId?: string;
}) {
  const [active, setActive] = useState(paper.sections[0]?.key ?? "architecture");
  const [read, setRead] = useState<string[]>(paper.sectionsRead);
  const [showPdf, setShowPdf] = useState(true);

  // Marking is fire-and-forget and deduped client-side, so switching tabs
  // quickly does not fire a request per tab.
  const pending = useRef(new Set<string>());

  const mark = useCallback(
    (key: string) => {
      if (read.includes(key) || pending.current.has(key)) return;
      pending.current.add(key);
      markSectionRead(paper.slug, key, userId)
        .then((r) => setRead(r.sectionsRead))
        .catch((err) => {
          pending.current.delete(key);
          console.error("Failed to mark section read:", err);
        });
    },
    [paper.slug, userId, read]
  );

  /* Marked on open, not on scroll-to-bottom.
     A scroll-depth check sounds more honest but is worse: it fails for a short
     section that never scrolls, and it fires for someone who flicks to the end.
     Neither measures reading, so the simpler rule is the one that does not
     pretend. */
  useEffect(() => {
    mark(active);
  }, [active, mark]);

  const current = paper.sections.find((s) => s.key === active);
  const done = read.length >= paper.sections.length;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-line px-6 py-4 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href="/research"
              className="inline-flex items-center gap-1.5 text-xs text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
            >
              <span aria-hidden>&larr;</span> Library
            </Link>
            <h1 className="mt-2 max-w-[60ch] truncate text-lg font-medium tracking-tight text-ink">
              {paper.title}
            </h1>
            <p className="mt-1 text-xs text-ink-3">
              {paper.authors} &middot; {paper.year}
              {paper.venue && <> &middot; {paper.venue}</>}
              {paper.arxivId && <> &middot; arXiv:{paper.arxivId}</>}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] tabular-nums text-ink-3">
              {read.length}/{paper.sections.length} read
            </span>
            {done && <Badge tone="strong">Finished</Badge>}
            <button
              type="button"
              onClick={() => setShowPdf((v) => !v)}
              aria-pressed={showPdf}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                "transition-colors duration-150 ease-void",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                showPdf
                  ? "border-line bg-void-2 text-ink-2 hover:text-ink"
                  : "border-ink bg-ink text-void-0"
              )}
            >
              {showPdf ? "Hide PDF" : "Show PDF"}
            </button>
          </div>
        </div>
      </header>

      {/* ── Split ────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {showPdf && (
          <div className="min-h-[45vh] flex-1 border-b border-line lg:min-h-0 lg:border-b-0 lg:border-r">
            {/* `title` is required: an unlabelled iframe is announced as
                "frame" and nothing else. */}
            <iframe
              src={`${paper.pdfUrl}#view=FitH`}
              title={`${paper.title} (PDF)`}
              className="h-full w-full bg-void-2"
            />
            <noscript>
              <a href={paper.pdfUrl}>Open the PDF</a>
            </noscript>
          </div>
        )}

        {/* Right — the breakdown */}
        <div
          className={cn(
            "flex min-h-0 flex-col",
            showPdf ? "flex-1" : "mx-auto w-full max-w-4xl"
          )}
        >
          <div className="flex-shrink-0 overflow-x-auto border-b border-line bg-ide-bar px-4">
            <div role="tablist" className="flex gap-1 py-2">
              {paper.sections.map((section) => {
                const isRead = read.includes(section.key);
                const isActive = section.key === active;
                return (
                  <button
                    key={section.key}
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActive(section.key)}
                    className={cn(
                      "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium",
                      "transition-colors duration-150 ease-void",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                      isActive
                        ? "bg-ide-raised text-ink"
                        : "text-ink-3 hover:text-ink-2"
                    )}
                  >
                    {section.label}
                    {isRead && (
                      <span
                        aria-label="read"
                        className="h-1.5 w-1.5 rounded-full bg-ink-3"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-8">
            <div className="mx-auto max-w-[68ch]">
              {current && <Prose markdown={current.body} />}

              {/* Equations and cross-links sit under every section rather than
                  in a tab of their own: they are reference material you glance
                  at while reading, not a fifth thing to read. */}
              {paper.keyEquations.length > 0 && (
                <Surface radius="panel" className="mt-10 p-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
                    Key equations
                  </p>
                  <div className="mt-4 space-y-4">
                    {paper.keyEquations.map((eq) => (
                      <div key={eq.label}>
                        <p className="text-xs font-medium text-ink-2">
                          {eq.label}
                        </p>
                        <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line bg-void-2 p-3 text-center font-mono text-[13px] text-ink">
                          <code>{eq.latex}</code>
                        </pre>
                        {eq.note && (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                            {eq.note}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </Surface>
              )}

              <RelatedProblems slugs={paper.relatedProblemSlugs} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Links into the problems that implement this paper's ideas.
 *
 * This is the thing that makes the module part of a platform rather than a PDF
 * reader: reading about scaled dot-product attention and then implementing it,
 * graded, is one click. Resolved against `CURRICULUM` so a slug that does not
 * exist is silently omitted rather than rendered as a dead link.
 */
function RelatedProblems({ slugs }: { slugs: string[] }) {
  const resolved = slugs
    .map((slug) => {
      const index = CURRICULUM.findIndex((entry) => entry.slug === slug);
      return index >= 0 ? { ...CURRICULUM[index], position: index + 1 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (resolved.length === 0) return null;

  return (
    <Surface radius="panel" className="mt-6 p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
        Implement it
      </p>
      <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-3">
        These problems build what this paper describes, and they are executed
        and graded.
      </p>
      <div className="mt-4 space-y-1">
        {resolved.map((entry) => (
          <Link
            key={entry.slug}
            href={`/problems/${entry.position}`}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm",
              "transition-colors duration-150 ease-void",
              "text-ink-2 hover:bg-void-3 hover:text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
            )}
          >
            <span className="w-4 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">
              {entry.position}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <span aria-hidden className="text-ink-3">
              &rarr;
            </span>
          </Link>
        ))}
      </div>
    </Surface>
  );
}
