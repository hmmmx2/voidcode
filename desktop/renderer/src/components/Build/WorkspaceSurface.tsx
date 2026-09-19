"use client";

import { IconPlan, IconSteps, IconPreview, IconDesign } from "@/components/icons";
import PlanCard from "./PlanCard";
import PreviewPanel from "./PreviewPanel";
import DesignPanel from "./DesignPanel";
import {
  WORKSPACE_TABS,
  WORKSPACE_TAB_LABELS,
  type WorkspaceTab,
} from "@/lib/build/workspace-tabs";
import type { RunView } from "@/lib/build/run-view";
import type { AgentStepPayload } from "@/lib/build/agent-stream";

/**
 * The right pane: the conversation's output, made inspectable.
 *
 * The pane this replaces was a single empty state that said what would eventually live here.
 * Two of those things exist now — the plan the agent wrote, and the steps it is working
 * through — so they get tabs, and the other two do not. A tab that opens onto "coming soon"
 * costs a click to learn nothing; `workspace-tabs.ts` records why Design and Preview are absent
 * and what adding them will take.
 *
 * **Deliberately not a code editor**, and still a decision rather than a gap — but the reason has
 * narrowed and the old wording is no longer true.
 *
 * It used to say Build had no editor at all: a model's change arrives as a diff to review, which
 * is where a change is legible — a reviewed hunk says what is changing and why, and a file open
 * in a pane says neither. That argument is intact and is about *reviewing a model's work*. It was
 * never an argument against reading your own code, and clicking a file in the explorer is the one
 * gesture a file tree promises. So the centre pane now has editor tabs beside Chat.
 *
 * What that leaves for *this* pane is unchanged: a Code tab here would be a second place showing
 * the same file, which is the same objection the paragraph below makes about a second place to act
 * on a run. `workspace-tabs.ts` records it beside the list.
 *
 * Everything here is read-only. Nothing in this pane starts, stops, retries or edits anything —
 * the chat is where you act, and a second place to act on the same run is a second place for the
 * two to disagree about what state it is in.
 */
export default function WorkspaceSurface({
  tab,
  onTabChange,
  run,
  hasProject,
  opening,
  onOpenProject,
  contextPath,
  host,
  projectRoot,
}: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  /**
   * Pinned to `AgentStepPayload` here rather than left generic.
   *
   * `runViewOf` is generic so it can be tested from the root program, which does not compile the
   * renderer's ambient types. This is the renderer, so it names the real step type and `StepRow`
   * gets its `kind` union back — which is what makes `labelFor` cover every case rather than
   * switching on a bare string.
   */
  run: RunView<AgentStepPayload>;
  /** Undefined project tree means no folder is open, which the pane answers before its tabs. */
  hasProject: boolean;
  opening: boolean;
  onOpenProject: () => void;
  /** The file the assistant currently has in context, if any. Shown when there is no run yet. */
  contextPath: string | undefined;
  /** Absent in a Study window, which has no preview — hence every call site's `?.`. */
  host: NonNullable<Window["host"]>;
  /** Threaded to the preview so it re-asks main when the project changes. */
  projectRoot: string | undefined;
}) {
  /*
    No project, no tabs.

    A tab strip over two empty panes is a worse answer to "nothing is open" than one sentence
    and the button that fixes it — and the button is the entire point of this state, so it must
    not be a click deeper than the thing it resolves.
  */
  if (!hasProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="max-w-xs">
          <h2 className="text-[15px] font-light tracking-tight text-ink">No project open</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
            {/*
              "By default", because it stopped being unconditional when Auto landed. Still true
              and still worth saying, but it is a default now, not an invariant, and a sentence
              about safety must not imply otherwise.
            */}
            Choose a folder to work in. By default the assistant proposes changes for you to
            review.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenProject}
          disabled={opening}
          className="rounded-lg bg-ink px-4 py-2 text-[13px] text-void-0 transition-opacity duration-150 ease-void hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-ide-code disabled:opacity-40"
        >
          {opening ? "Opening…" : "Open folder"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same metrics as the dock's strip — 36px, uppercase, bottom hairline — because they are
          the same control in two places, and two tab strips that disagree by two pixels is the
          kind of detail that reads as unfinished without anyone being able to say why. */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-ide-bar/60">
        <div role="tablist" aria-label="Workspace" className="flex items-stretch">
          {WORKSPACE_TABS.map((id) => {
            const active = id === tab;
            const Icon =
              id === "plan"
                ? IconPlan
                : id === "steps"
                  ? IconSteps
                  : id === "design"
                    ? IconDesign
                    : IconPreview;
            const count = id === "steps" ? run.steps.length : 0;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(id)}
                className={`flex items-center gap-1.5 border-r border-line px-3 text-[11px] uppercase tracking-wide transition-colors duration-150 ease-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink ${
                  active ? "bg-ide-panel text-ink" : "text-ink-3 hover:bg-ide-raised hover:text-ink-2"
                }`}
              >
                <Icon size={13} />
                {WORKSPACE_TAB_LABELS[id]}
                {/* Only when there are some. A "0" beside a tab reads as a broken counter
                    rather than as an empty list, which the pane itself says better. */}
                {count > 0 && <span className="font-mono text-[10px] text-ink-3">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/*
        `overflow-y-auto` for the two tabs that scroll, and NOT for Preview.

        The preview is a native view positioned in window coordinates. It does not clip to a
        scroll container and does not move when one scrolls — so a scrollable parent would slide
        the placeholder out from under a page that stayed exactly where it was.
      */}
      <div
        className={`min-h-0 flex-1 p-3 ${tab === "preview" ? "overflow-hidden" : "overflow-y-auto"}`}
      >
        {tab === "plan" ? (
          run.plan === null ? (
            <Empty
              title="No plan yet"
              body={
                contextPath === undefined
                  ? "Ask the assistant to plan a change and its steps appear here."
                  : `${contextPath} is in the assistant's context. Ask it to plan a change.`
              }
            />
          ) : (
            <PlanCard plan={run.plan} />
          )
        ) : tab === "steps" ? (
          run.steps.length === 0 ? (
            <Empty title="No steps yet" body="What the assistant does this turn is listed here." />
          ) : (
            <ol className="flex flex-col gap-1.5">
              {run.steps.map((step, index) => (
                // Index as key: this list is derived from one turn's blocks and only ever grows
                // at the end, so there is no identity to preserve across a reorder that cannot
                // happen.
                <StepRow key={index} step={step} />
              ))}
            </ol>
          )
        ) : tab === "design" ? (
          <DesignPanel host={host} spec={run.design} projectRoot={projectRoot} />
        ) : (
          <PreviewPanel host={host} visible={tab === "preview"} projectRoot={projectRoot} />
        )}
      </div>
    </div>
  );
}

/** Shared so both tabs are empty in the same way — two dialects of "nothing here" reads as a bug. */
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="max-w-xs">
        <h2 className="text-[13px] font-medium text-ink-2">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{body}</p>
      </div>
    </div>
  );
}

/**
 * One step, as a row rather than as a log line.
 *
 * Output's Agent channel already has the log form, and it is the right shape there — a scrollback
 * you read after something surprised you. This is the shape for watching: the label is what the
 * agent is doing, and the text under it is only as much as fits.
 */
function StepRow({ step }: { step: AgentStepPayload }) {
  const failed = step.kind === "error";

  return (
    <li className="flex flex-col gap-0.5 border-l-2 border-line pl-2.5">
      <span
        className={`font-mono text-[10px] uppercase tracking-wide ${
          failed ? "text-diff-remove-ink" : "text-ink-3"
        }`}
      >
        {labelFor(step)}
      </span>
      <p
        className={`whitespace-pre-wrap break-words text-xs ${
          failed ? "text-diff-remove-ink" : "text-ink-3"
        }`}
      >
        {/*
          Clipped in the view, not in the data. A `list_files` result is tens of kilobytes, and
          a pane that pastes all of it buries every other step in the run. Shorter than the
          transcript's 400 because this is a list of many, not a block among prose.
        */}
        {step.text.length > 200 ? `${step.text.slice(0, 200)}…` : step.text}
      </p>
    </li>
  );
}

function labelFor(step: AgentStepPayload): string {
  if (step.kind === "tool") return step.toolName ?? "tool";
  if (step.kind === "proposal") return "proposed edit";
  if (step.kind === "command") return "ran a command";
  if (step.kind === "applied") return "wrote";
  if (step.kind === "error") return "problem";
  return "thought";
}
