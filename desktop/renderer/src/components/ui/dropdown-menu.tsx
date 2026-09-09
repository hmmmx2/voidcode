"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A menu that opens from a button.
 *
 * Radix here, hand-rolled elsewhere, and the difference is deliberate. The dock's tab strips and
 * the slash list are hand-rolled because they must *not* take focus — a tab strip is a roving
 * tabindex inside a panel, and the slash list appears while someone is mid-sentence in a
 * textarea. A menu is the opposite: opening one is a decision, focus belongs inside it, and
 * everything that follows — arrow keys, typeahead, Escape, click-outside, focus returning to the
 * button on close, and not rendering underneath the composer — is behaviour worth taking rather
 * than rewriting.
 *
 * Wrapped rather than used directly, following `ui/tabs.tsx`: the styling lives in one place so
 * a second menu cannot drift, and the primitive stays swappable.
 */

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  // Portalled, so the menu is not clipped by the composer's `overflow-hidden` panel and does not
  // inherit its stacking context.
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[11rem] overflow-hidden rounded-md border border-line bg-ide-panel py-1",
        "shadow-[var(--shadow-panel)]",
        // Radix sets these data attributes; the animation is the same 150ms ease-void the rest
        // of the app uses rather than a library default.
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[13px] text-ink-2 outline-none",
      // `data-highlighted` covers hover and keyboard alike, so arrowing to a row looks the same
      // as pointing at it — which is the whole reason not to style `:hover` directly.
      "data-[highlighted]:bg-ide-raised data-[highlighted]:text-ink",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-3 py-1 text-[10px] uppercase tracking-wide text-ink-3", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
};
