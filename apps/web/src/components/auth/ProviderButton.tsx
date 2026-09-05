"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * An OAuth provider button.
 *
 * This is not `ui/Pill.tsx`: these need an icon slot, a pending
 * state, and full width — and a white-on-dark treatment that reads as a
 * third-party action rather than as this site's own primary CTA.
 *
 * The spinner replaces the icon rather than sitting beside it, so the button's
 * width does not change when it becomes pending. A button that resizes under
 * the cursor at the moment you click it feels broken even when it is not.
 */
export function ProviderButton({
  icon,
  children,
  onClick,
  pending = false,
  disabled = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={pending}
      className={cn(
        "group relative flex w-full items-center justify-center gap-3 rounded-full",
        "border border-white/15 bg-ink px-6 py-3.5",
        "text-sm font-medium text-void-0",
        "transition-[transform,opacity,background-color] duration-200 ease-void",
        "hover:bg-white/90 active:translate-y-px",
        // White ring on a black offset — the monochrome answer to a focus ring.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
        "disabled:cursor-not-allowed disabled:opacity-45"
      )}
    >
      <span className="flex h-[18px] w-[18px] items-center justify-center">
        {pending ? (
          <span
            className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-void-0/25 border-t-void-0"
            aria-hidden
          />
        ) : (
          icon
        )}
      </span>
      {children}
    </button>
  );
}
