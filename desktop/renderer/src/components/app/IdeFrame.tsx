import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The workspace's panel frame and toolbar.
 *
 * Four files each drew these by hand — `ProblemTabs`, `CodeColumn`,
 * `TestConsole` and `VoidCodeAIPanel` — with up to two toolbars apiece, all
 * repeating `bg-[#212121]` / `bg-[#262626]` / `border-[#333333]` and drifting
 * by a pixel or a shade wherever someone had adjusted one and not the others.
 *
 * NO GLASS IN HERE, AND THAT IS THE DELIBERATE PART.
 *
 * Glass is approved for the app's chrome and its hero cards, not for these.
 * Two reasons, and the first is simply physical: the IDE panels tile the
 * viewport with 4px gutters between them, so there is nothing behind a panel
 * except the panel next to it. A `backdrop-filter` with nothing to sample
 * produces a flat grey rectangle — the exact failure mode the auth pages
 * documented. The second is that this is a dense tool surface where someone
 * reads code for an hour; translucency here costs legibility and buys a look.
 *
 * WHY THE PANELS GAINED A BORDER THEY DID NOT HAVE
 *
 * They used to separate from the page by fill alone: `#212121` on `#0A0A0A`.
 * Under the new ramp `ide-panel` is `#0d0d0f` on a near-black page, a delta of
 * about 5%, which is not enough to read as an edge on its own. The hairline is
 * what defines the panel now — the same rule the rest of the product follows.
 */

export function IdePanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl",
        "border border-line bg-ide-panel",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A panel's toolbar. `h-9` is load-bearing: `ResizableLayout` computes the
 * editor's available height by subtracting fixed chrome, so a taller bar
 * silently overflows Monaco rather than resizing it.
 */
export function IdeBar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-9 flex-shrink-0 items-center justify-between gap-3",
        "border-b border-line bg-ide-bar px-3",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A square icon button for the toolbars.
 *
 * `title` is required and doubles as `aria-label`, because every one of these
 * is icon-only. The versions this replaces were unlabelled `<button>`s wrapping
 * an `<Image>` — announced as "button" with no further information.
 */
export function IdeIconButton({
  title,
  active = false,
  className,
  children,
  ...rest
}: {
  title: string;
  active?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "className" | "children">) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md",
        "transition-colors duration-150 ease-void",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-ide-panel",
        active
          ? "bg-ide-raised text-ink"
          : "text-ink-3 hover:bg-ide-raised hover:text-ink",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
