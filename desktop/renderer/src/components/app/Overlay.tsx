"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
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
  anchor,
  children,
}: {
  align?: "start" | "end";
  /** A width utility. Callers differ a lot — 208px to 320px. */
  width?: string;
  className?: string;
  /**
   * Escape the host's stacking context by rendering into `document.body`, positioned
   * against this element.
   *
   * NEEDED WHEN ANY ANCESTOR HAS `backdrop-filter`, `filter` OR `transform`. Each of those
   * creates a stacking context, and `z-50` cannot climb out of one — the panel is painted
   * underneath whatever sibling of that ancestor comes later, which in a workbench is the
   * entire editor area.
   *
   * That is not hypothetical. Mounting the notification bell in the workbench menu bar,
   * which is `backdrop-blur-xl` glass, produced a dropdown that was open, visible, correctly
   * sized and completely unseeable: only the strip of it overlapping the sidebar showed,
   * because the main content painted over the rest.
   *
   * Opt-in rather than the default: the three original call sites sit in ordinary bars and
   * work, and a portal is the more complicated thing — it cannot inherit position from the
   * layout, so it has to measure and re-measure.
   */
  anchor?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  if (anchor !== undefined) {
    return (
      <PortalMenu anchor={anchor} align={align} width={width} className={className}>
        {children}
      </PortalMenu>
    );
  }

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

function PortalMenu({
  anchor,
  align,
  width,
  className,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  align: "start" | "end";
  width?: string;
  className?: string;
  children: ReactNode;
}) {
  const [box, setBox] = useState<{ top: number; left?: number; right?: number }>();

  // `useLayoutEffect`, not `useEffect`: the panel must have its coordinates before the
  // browser paints, or it appears at the top-left for one frame and jumps.
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setBox(
        align === "end"
          ? { top: rect.bottom + 8, right: Math.max(0, window.innerWidth - rect.right) }
          : { top: rect.bottom + 8, left: rect.left }
      );
    };

    place();
    // Re-measure rather than assume. A workbench panel toggle moves the anchor without
    // unmounting anything, so a position captured once goes stale while the menu is open.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align]);

  // Nothing until measured. Rendering at 0,0 first would flash the panel in the corner.
  if (box === undefined) return null;

  return createPortal(
    <GlassSurface
      radius="card"
      // `fixed`, because the coordinates come from `getBoundingClientRect`, which is
      // viewport-relative. `absolute` would add the document scroll twice.
      className={cn("fixed z-50 overflow-hidden", width, className)}
      style={{ top: box.top, left: box.left, right: box.right }}
      /**
       * How a click-outside handler recognises this panel.
       *
       * A portalled menu is no longer a descendant of its trigger, so the usual
       * `wrapper.contains(event.target)` test says every click *inside the menu* is outside
       * it — the panel closes the moment you touch it, and "mark all as read" becomes
       * unclickable. Callers test `closest("[data-menu-portal]")` as well.
       */
      data-menu-portal=""
    >
      {children}
    </GlassSurface>,
    document.body
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
