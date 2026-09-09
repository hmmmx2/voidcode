"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STATE_LABELS, milestoneDone, projectProgress, type Project } from "@/lib/projects";
import { useSolvedProblems } from "@/lib/shell/useSolvedProblems";

/**
 * A project: brief, milestones, workspace.
 *
 * The third tab is the point. "Open in Code" is the moment the two halves of the product
 * become one product — the thing you have been reading about becomes a folder you are
 * editing, without leaving the app or managing a second window.
 */

type Tab = "brief" | "milestones" | "workspace";

const TABS: { id: Tab; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "milestones", label: "Milestones" },
  { id: "workspace", label: "Workspace" },
];

export default function ProjectDetail({ project }: { project: Project }) {
  const [tab, setTab] = useState<Tab>("brief");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const router = useRouter();

  /**
   * Measured, not authored. See `projectProgress` — the counts here used to be literals, so this
   * page reported milestones complete on a machine where nothing had been solved.
   */
  const { solved, loading } = useSolvedProblems();
  const { done, total, state } = projectProgress(project, solved);

  /**
   * Pick the folder, then go to the IDE.
   *
   * The native dialog is deliberate and cannot be skipped: choosing the folder *is* the
   * grant that gives the app filesystem access at all. A one-click "just make me a project
   * folder somewhere" would be a nicer demo and would mean the app writing to a location the
   * user never named.
   */
  const openInCode = async () => {
    if (window.host?.fs === undefined) {
      setError("Working on files needs the desktop app.");
      return;
    }
    setOpening(true);
    setError(undefined);
    try {
      const result = await window.host.fs.openProject();
      if (result.opened) router.push("/build");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="page-content">
        <Link
          href="/projects"
          className="text-xs text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          ← Projects
        </Link>

        <header className="mt-3">
          <h1 className="text-2xl font-light tracking-tight text-ink">{project.title}</h1>
          <p className="mt-1 text-sm text-ink-3">
            {loading ? project.premise : `${STATE_LABELS[state]} · ${done}/${total} milestones`}
          </p>
        </header>

        <div
          role="tablist"
          className="mt-6 flex gap-1 border-b border-line"
        >
          {TABS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
                tab === entry.id
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="py-6">
          {tab === "brief" && (
            <div className="space-y-4">
              <p className="max-w-prose text-sm leading-relaxed text-ink-2">{project.brief}</p>
              {project.source !== undefined && (
                <p className="text-xs text-ink-3">
                  Source: {project.source.label}
                  {project.source.arxiv !== undefined && (
                    <span className="ml-1 font-mono">arXiv:{project.source.arxiv}</span>
                  )}
                </p>
              )}
            </div>
          )}

          {tab === "milestones" && (
            <ul className="space-y-2">
              {project.milestones.map((milestone) => (
                <li
                  key={milestone.label}
                  className="rounded-lg border border-line bg-ide-panel p-3"
                >
                  <div className="flex items-center gap-2">
                    {/* Colour is never the only carrier — the glyph says it too. */}
                    <span
                      aria-hidden
                      className={milestoneDone(milestone, solved) ? "text-ink" : "text-ink-3"}
                    >
                      {milestoneDone(milestone, solved) ? "●" : "○"}
                    </span>
                    <span
                      className={
                        milestoneDone(milestone, solved)
                          ? "text-sm text-ink-3 line-through"
                          : "text-sm text-ink-2"
                      }
                    >
                      {milestone.label}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                    {milestone.teaches.map((slug) => (
                      <Link
                        key={slug}
                        href={`/problems/${slug}`}
                        className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                      >
                        {slug}
                      </Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tab === "workspace" && (
            <div className="space-y-4">
              <p className="max-w-prose text-sm leading-relaxed text-ink-2">
                Choose a folder for this project. It opens in Code with the assistant and
                inline completion available, and every edit the assistant proposes is shown
                as a diff before anything is written.
              </p>
              <button
                type="button"
                onClick={() => void openInCode()}
                disabled={opening}
                className="rounded-lg bg-ink px-4 py-2 text-sm text-void-0 transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
              >
                {opening ? "Opening…" : "Open in Code"}
              </button>
              {error !== undefined && (
                <p className="text-xs text-diff-remove-ink">{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
