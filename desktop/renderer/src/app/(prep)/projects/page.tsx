"use client";

import Link from "next/link";
import { PROJECTS, STATE_LABELS, projectProgress } from "@/lib/projects";
import { useSolvedProblems } from "@/lib/shell/useSolvedProblems";

/**
 * Projects — the list.
 *
 * No thumbnails, deliberately. There is no honest image for "implement a transformer from
 * scratch", and a placeholder graphic on every card is worse than none: it makes the list
 * look like it is waiting for content rather than showing it.
 *
 * A CLIENT COMPONENT NOW, because the counts are measured. They used to be literals in
 * `lib/projects.ts` — two milestones marked `done: true` and a project marked `in-progress` — so a
 * fresh install with nothing solved reported "In progress — 2/4". The store already knew; nothing
 * was asking it.
 */
export default function ProjectsPage() {
  const { solved, loading } = useSolvedProblems();

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="page-list">
        <header className="mb-8">
          <h1 className="text-2xl font-light tracking-tight text-ink">Projects</h1>
          <p className="mt-1 max-w-prose text-sm text-ink-3">
            Exercises teach one idea each. A project is where they have to work together —
            studied here, built in Code.
          </p>
        </header>

        <ul className="space-y-3">
          {PROJECTS.map((project) => {
            const { done, total, state } = projectProgress(project, solved);

            return (
              <li key={project.slug}>
                <Link
                  href={`/projects/${project.slug}`}
                  className="block rounded-2xl border border-line bg-ide-panel p-5 transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                >
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base text-ink">{project.title}</h2>
                      <p className="mt-1 text-sm text-ink-3">{project.premise}</p>

                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {project.stack.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs text-ink-3"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      {/* Nothing until the store has answered. An empty solved set is
                          indistinguishable from "nothing solved", so rendering through the first
                          frame would flash "Not started" on a project that is complete. */}
                      {!loading && (
                        <>
                          <p className="text-xs text-ink-3">{STATE_LABELS[state]}</p>
                          <p className="mt-1 font-mono text-xs text-ink-3">
                            {done}/{total}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
