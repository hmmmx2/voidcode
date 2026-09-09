"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { IdeIconButton } from "@/components/app";
import { Mark } from "@/components/brand/Mark";

/**
 * The problem workspace's own toolbar.
 *
 * This replaces `TopNavigation variant="workspace"` on the exercise routes. That component
 * carries the logo, the destination list, settings, notifications and the account menu — all
 * of which the workbench already supplies above it, so rendering it here drew the app's
 * navigation twice, one bar under the other.
 *
 * What is left is genuinely scoped to the exercise: which question you are on, how to reach
 * the next one, and whether the tutor is open. Those do not belong in the app chrome, because
 * they mean nothing anywhere else.
 *
 * `h-9` to match `IdeBar` and every other toolbar in the product — `ResizableLayout` computes
 * the editor's height by subtracting fixed chrome, so a taller bar silently overflows Monaco
 * rather than resizing it.
 */

interface WorkspaceToolbarProps {
  currentProblem: number;
  totalProblems: number;
  /** `/problems` or `/interviews` — the prev/next links are relative to it. */
  basePath?: string;
  isVoidCodeAIOpen?: boolean;
  onToggleVoidCodeAI?: () => void;
}

export default function WorkspaceToolbar({
  currentProblem,
  totalProblems,
  basePath = "/problems",
  isVoidCodeAIOpen = false,
  onToggleVoidCodeAI,
}: WorkspaceToolbarProps) {
  const router = useRouter();
  const canGoPrev = currentProblem > 1;
  const canGoNext = currentProblem < totalProblems;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-ide-bar/60 px-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
        Question
      </span>
      {/* `tabular-nums` so the counter does not shift width between 9/12 and 10/12. */}
      <span className="text-[13px] tabular-nums text-ink-2">
        {currentProblem}/{totalProblems}
      </span>

      <div className="flex items-center gap-0.5">
        <Chevron
          direction="prev"
          enabled={canGoPrev}
          onClick={() => router.push(`${basePath}/${currentProblem - 1}`)}
        />
        <Chevron
          direction="next"
          enabled={canGoNext}
          onClick={() => router.push(`${basePath}/${currentProblem + 1}`)}
        />
      </div>

      {onToggleVoidCodeAI !== undefined && (
        <div className="ml-auto">
          <IdeIconButton
            title={isVoidCodeAIOpen ? "Close the tutor" : "Open the tutor"}
            active={isVoidCodeAIOpen}
            onClick={onToggleVoidCodeAI}
          >
            <Mark className="h-3.5 w-3.5" />
          </IdeIconButton>
        </div>
      )}
    </div>
  );
}

function Chevron({
  direction,
  enabled,
  onClick,
}: {
  direction: "prev" | "next";
  enabled: boolean;
  onClick: () => void;
}) {
  const label = direction === "prev" ? "Previous problem" : "Next problem";

  return (
    <button
      type="button"
      onClick={() => enabled && onClick()}
      disabled={!enabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-colors duration-150 ease-void",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-ide-bar",
        enabled ? "text-ink-3 hover:text-ink" : "cursor-not-allowed text-ink-3/40"
      )}
    >
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden>
        <path
          d={direction === "prev" ? "M6 1L1 6L6 11" : "M1 1L6 6L1 11"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
