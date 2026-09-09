"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ProblemDescription from "./ProblemDescription";
import SubmissionHistory from "./SubmissionHistory";
import { CURRICULUM } from "@/lib/curriculum";
import { cn } from "@/lib/utils";
import type { Problem, Submission } from "@/lib/mock-data";

/** Display names for the tracks, in curriculum order. */
const TRACKS = [
  { code: "NN-CORE", label: "Neural Network Internals" },
  { code: "LLM-SYS", label: "LLM & VLM Systems" },
  { code: "GPU-FW", label: "GPU & Frameworks" },
] as const;

/** A tab contributed by the route, rendered after the built-in ones. */
export interface ExtraPanel {
  value: string;
  label: string;
  content: React.ReactNode;
}

interface ProblemTabsProps {
  problem: Problem | null;
  submissions: Submission[];
  onLoadSubmission?: (sourceCode: string, language: string) => void;
  /** URL prefix for the problem list links. See WorkspaceClient. */
  basePath?: string;
  /**
   * Extra tabs appended after the built-in three.
   *
   * The interview route puts its Approach and Model answer panels here rather
   * than forking this component. The Problem List tab is hidden whenever these
   * are present: an interview question is not part of the curriculum, so
   * offering a list that would navigate you out of it is worse than offering
   * nothing.
   */
  extraPanels?: ExtraPanel[];
}

export default function ProblemTabs({
  problem,
  submissions,
  onLoadSubmission,
  basePath = "/problems",
  extraPanels,
}: ProblemTabsProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-ide-panel">
      <Tabs defaultValue="description" className="flex flex-col h-full min-h-0">
        {/* Tab Navbar — bg #262626 */}
        <div className="bg-ide-bar border-b border-line flex-shrink-0 px-3 py-2">
          <TabsList>
            <TabsTrigger value="description" className="text-xs">
              Description
            </TabsTrigger>
            {!extraPanels && (
            <TabsTrigger value="problemlist" className="text-xs">
              <span className="flex items-center gap-1">
                Problem List
                <svg
                  width="10"
                  height="7"
                  viewBox="0 0 10 7"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M1 1L5 5L9 1"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </TabsTrigger>
            )}
            <TabsTrigger value="submissions" className="text-xs">
              Submission History
            </TabsTrigger>
            {extraPanels?.map((panel) => (
              <TabsTrigger key={panel.value} value={panel.value} className="text-xs">
                {panel.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* Tab Content — each scrollable independently */}
        <TabsContent value="description" className="flex-1 overflow-y-auto min-h-0">
          {problem ? (
            <ProblemDescription problem={problem} />
          ) : (
            <div className="flex items-center justify-center h-full text-ink-3 text-xs py-8">
              No problem loaded
            </div>
          )}
        </TabsContent>

        <TabsContent value="problemlist" className="flex-1 overflow-y-auto min-h-0">
          {/* Grouped by track, read from `lib/curriculum` rather than re-typed.
              This used to be a second hardcoded copy of the problem set that
              drifted from the route's own mapping. */}
          <div className="space-y-5 p-4">
            {TRACKS.map((track) => (
              <div key={track.code}>
                <p className="mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
                  {track.label}
                </p>
                <div className="space-y-1">
                  {CURRICULUM.map((entry, i) => ({ entry, position: i + 1 }))
                    .filter(({ entry }) => entry.track === track.code)
                    .map(({ entry, position }) => {
                      const isCurrent = problem?.title === entry.title;
                      return (
                        <a
                          key={entry.slug}
                          href={`${basePath}/${position}`}
                          aria-current={isCurrent ? "page" : undefined}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm",
                            "transition-colors duration-150 ease-void",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
                            isCurrent
                              ? "bg-ide-raised font-medium text-ink"
                              : "text-ink-2 hover:bg-void-3 hover:text-ink"
                          )}
                        >
                          <span className="w-4 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">
                            {position}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        </a>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="submissions" className="flex-1 overflow-y-auto min-h-0">
          <SubmissionHistory submissions={submissions} onLoadSubmission={onLoadSubmission} />
        </TabsContent>
        {extraPanels?.map((panel) => (
          <TabsContent
            key={panel.value}
            value={panel.value}
            className="flex-1 overflow-y-auto min-h-0"
          >
            {panel.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
