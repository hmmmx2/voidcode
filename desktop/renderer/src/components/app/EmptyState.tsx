import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one empty state.
 *
 * There were five, all written inline, all a sentence of grey text centred in a box — and two
 * of them sat in adjacent columns telling the user the same thing in slightly different
 * words. An empty state is a real screen someone spends their first minute looking at, and
 * "Open a folder to start." is not a screen.
 *
 * The shape is fixed on purpose: a heading that names the state, one line that says what to
 * do about it, and at most one action. A second action here always means the state is really
 * two states.
 */
export function EmptyState({
  title,
  body,
  action,
  size = "md",
  className,
}: {
  title: string;
  /** One sentence. If it needs two, the state is not understood yet. */
  body?: string;
  action?: ReactNode;
  /** `sm` for a sidebar column, `md` for a full pane. */
  size?: "sm" | "md";
  className?: string;
}) {
  const small = size === "sm";

  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 px-6 text-center",
        className
      )}
    >
      <div className={small ? "max-w-[22ch]" : "max-w-xs"}>
        <h2
          className={cn(
            "font-light tracking-tight text-ink",
            small ? "text-[13px]" : "text-[15px]"
          )}
        >
          {title}
        </h2>
        {body !== undefined && (
          <p
            className={cn(
              "mt-1 leading-relaxed text-ink-3",
              small ? "text-[11px]" : "text-[13px]"
            )}
          >
            {body}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
