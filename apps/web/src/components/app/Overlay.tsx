"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GlassSurface } from "./Surface";

/**
 * A dropdown panel. Three call sites had hand-rolled this: the user menu in
 * `TopNavigation`, `NotificationBell`, and `ChatHistoryDropdown` — each with its
 * own fill, border, radius and shadow.
 *
 * Positioning only; the trigger, the open state and the click-outside handler
 * stay with the caller, because all three already own them and moving that here
 * would mean rewriting three working popovers to gain nothing.
 *
 * The host must be `relative`.
 */
export function Menu({
  align = "end",
  width = "w-56",
  className,
  children,
}: {
  align?: "start" | "end";
  /** A width utility. Callers differ a lot — 208px to 320px. */
  width?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <GlassSurface
      radius="card"
      className={cn(
        "absolute top-full z-50 mt-2 overflow-hidden",
        align === "end" ? "right-0" : "left-0",
        width,
        className
      )}
    >
      {children}
    </GlassSurface>
  );
}

/**
 * A modal, on `<dialog showModal()>`.
 *
 * WHY THE PLATFORM ELEMENT RATHER THAN THE `fixed inset-0` DIV IT REPLACES
 *
 * The version in `Profile/ProfileClient.tsx` was a plain positioned div, which
 * means it shipped none of the things a modal has to do: focus was not trapped,
 * Escape did nothing, the page behind stayed reachable by Tab and fully visible
 * to a screen reader, and it competed in the same z-index space as the nav.
 * `showModal()` gives all four away for free — the top layer alone removes the
 * z-index question permanently.
 *
 * `dialog.app-modal` in globals.css strips the UA's opaque white fill, fixed
 * max-width and 2px border, and blurs the backdrop. That blur is load-bearing
 * rather than decorative: it is what this panel's own glass has to refract.
 *
 * TWO SUBTLETIES WORTH KNOWING BEFORE EDITING
 *
 * 1. Escape fires the dialog's `close` event without going through `onClose`,
 *    so the listener below is what keeps React state in sync. Without it the
 *    dialog closes, `open` stays `true`, and it can never be reopened.
 * 2. A click on the backdrop targets the `<dialog>` itself — the backdrop is a
 *    pseudo-element and cannot be a target. Comparing `e.target` to the dialog
 *    node is therefore the whole dismiss-on-backdrop implementation, and it
 *    works precisely because the panel inside is a different element.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** `id` of the heading that names this dialog. */
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className="app-modal"
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <GlassSurface
        radius="panel"
        /* `bg-white/[0.06]` rather than the base 4.5%: this refracts a blurred
           page through the scrim rather than a soft gradient, so it can afford
           slightly more fill without becoming a floating grey card. */
        className={cn(
          "supports-[backdrop-filter]:bg-white/[0.06] p-6",
          className
        )}
      >
        {children}
      </GlassSurface>
    </dialog>
  );
}
