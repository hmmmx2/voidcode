"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mark } from "@/components/brand/Mark";
import { cn } from "@/lib/utils";

/**
 * The breakpoint below which the sheet exists.
 *
 * Two things have to agree — the trigger's `hidden` utility and the media query
 * that force-closes the sheet on rotation — and they are written in different
 * languages (a Tailwind class and a `matchMedia` string). Pairing them in one
 * table is the only way they cannot drift; when they do drift, the result is a
 * sheet left open with its trigger `display:none`, which the user cannot
 * recover from.
 *
 * Full literal class strings, because Tailwind scans source text — a computed
 * `${bp}:hidden` generates no CSS at all.
 */
const BREAKPOINTS = {
  md: { hide: "md:hidden", query: "(min-width: 768px)" },
  lg: { hide: "lg:hidden", query: "(min-width: 1024px)" },
} as const;

/**
 * The narrow-viewport nav sheet.
 *
 * BUILT ON <dialog> + showModal(). That gives a focus trap, Escape-to-close,
 * `inert` on the rest of the page, top-layer stacking (no z-index war with the
 * nav's z-50) and a ::backdrop — all correct, all free. Hand-rolled focus traps
 * are the thing everyone gets subtly wrong. What it does *not* give, and is
 * handled below: closing on backdrop click, and background scroll locking on
 * iOS.
 *
 * **It was "shared by the marketing page and the app", and it is not.** The
 * marketing page is in the web repository, which is retired and is not a sibling
 * of this one — so "shared" described a relationship that no build here can have,
 * and the parameterisation it justified had one caller passing one set of values.
 *
 * The `actions` prop (marketing's sign-in pills) is gone: nothing passed it, and
 * this app has no sign-in to put there. `breakpoint` stays a prop and lost its
 * `md` default, which was marketing's value and unreachable here — `TopNavigation`
 * passes `lg`. It stays a prop rather than becoming a constant because the pairing
 * in `BREAKPOINTS` is the point: a caller has to pick a row, not invent a class
 * and a media query that can drift apart.
 */
export function MobileMenu({
  links,
  breakpoint,
}: {
  links: ReadonlyArray<{ href: string; label: string }>;
  /**
   * Must match wherever the desktop nav appears — the app hides its five links
   * below `lg`. Required, so the caller states it: the default was `md`, which
   * was the other repository's value and no caller here ever wanted.
   */
  breakpoint: keyof typeof BREAKPOINTS;
}) {
  const { hide, query } = BREAKPOINTS[breakpoint];
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restore = useRef({ overflow: "", paddingRight: "" });
  const locked = useRef(false);
  const pathname = usePathname();

  const lock = useCallback(() => {
    // Guarded so a second lock() cannot capture the already-locked values as
    // the "previous" state — that would make every later unlock restore
    // `overflow: hidden` and leave the page permanently unscrollable.
    if (locked.current) return;
    locked.current = true;

    // `overflow: hidden` alone reflows the page by the scrollbar width on any
    // platform with classic scrollbars — the hero visibly jumps sideways on
    // Windows. Reserve the space we are about to remove.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    restore.current = {
      overflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight,
    };
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  }, []);

  /** Idempotent — every close path calls it, and several may call it twice. */
  const unlock = useCallback(() => {
    if (!locked.current) return;
    locked.current = false;
    document.body.style.overflow = restore.current.overflow;
    document.body.style.paddingRight = restore.current.paddingRight;
  }, []);

  const openMenu = useCallback(() => {
    lock();
    dialogRef.current?.showModal();
    setOpen(true);
  }, [lock]);

  /**
   * Closes and releases the scroll lock **synchronously**.
   *
   * This matters more than it looks. The `close` event is queued as a task, not
   * dispatched synchronously, so unlocking in `onClose` runs after the current
   * frame. A hash link that closed the menu and immediately scrolled would be
   * scrolling against a still-locked `<body>` — the jump silently does nothing
   * and the link appears broken.
   */
  const closeMenu = useCallback(() => {
    dialogRef.current?.close();
    unlock();
    setOpen(false);
    triggerRef.current?.focus();
  }, [unlock]);

  // Rotating a phone to landscape with the menu open otherwise leaves an
  // invisible modal holding focus and a locked body, with the trigger now
  // `display:none` — no way out at all. This is the bug that ships.
  //
  // Deliberately belt-and-braces. The `change` event is the semantically correct
  // signal, but it is not dependable everywhere: measured in this project, a
  // viewport resize to 1024px left `mql.matches === true` while no `change`
  // event had been delivered, and the sheet stayed open. `resize` always fires,
  // and the check on mount covers a viewport that was already wide.
  //
  // The listeners only exist while the sheet is open, so the wide case costs
  // nothing.
  useEffect(() => {
    if (!open) return;

    const mql = window.matchMedia(query);
    const check = () => {
      if (mql.matches) closeMenu();
    };

    check();
    mql.addEventListener("change", check);
    window.addEventListener("resize", check, { passive: true });
    return () => {
      mql.removeEventListener("change", check);
      window.removeEventListener("resize", check);
    };
  }, [open, closeMenu, query]);

  // Close on any route change. The comment here named `/login`, a route that does not exist — the
  // effect is not about one destination, it is about the sheet outliving the page it was opened from.
  useEffect(() => {
    if (open) closeMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Never leave the body locked if this unmounts while open.
  useEffect(() => unlock, [unlock]);

  /**
   * Hash links scroll; route links navigate.
   *
   * This used to `preventDefault()` unconditionally and then
   * `getElementById(href.slice(1))`, which is right for `#features` and silently
   * does nothing for `/problems` — it strips the leading `/`, looks for an
   * element with id `problems`, finds none, and swallows the click. Reusing the
   * sheet for app routes without this split would give a menu whose items simply
   * do not respond.
   */
  const onHashClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    // Order is load-bearing: closeMenu() releases the scroll lock synchronously,
    // and only then can the scroll take effect. Default anchor behaviour cannot
    // be used here for exactly that reason.
    closeMenu();
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(href.slice(1))
      ?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
    history.replaceState(null, "", href);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label="Open menu"
        className={cn(
          "-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-ink transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
          hide
        )}
      >
        {/* Two bars, not three — more minimal, and it matches the page. */}
        <span aria-hidden className="flex w-5 flex-col gap-[5px]">
          <span className="h-px w-full bg-current" />
          <span className="h-px w-full bg-current" />
        </span>
      </button>

      <dialog
        ref={dialogRef}
        id="mobile-menu"
        className="nav-sheet"
        // Escape. `cancel` is cancelable, so taking it over and routing through
        // closeMenu() makes the whole Escape path synchronous and deterministic.
        //
        // This is not belt-and-braces for its own sake. `close` is dispatched as
        // a queued task, and a queued task is not a guarantee — measured in this
        // project, a `dialog.close()` flipped `.open` to false while no `close`
        // event was ever delivered. Hanging the release of a body scroll lock on
        // that would mean a dropped event leaves the page permanently
        // unscrollable, with no way for the user to recover.
        onCancel={(event) => {
          event.preventDefault();
          closeMenu();
        }}
        // Retained purely as a safety net for any close path not covered above.
        // Both operations are idempotent.
        onClose={() => {
          unlock();
          setOpen(false);
        }}
        // <dialog> does not close on backdrop click. The backdrop is the dialog
        // element's own box, so a click landing on it directly (not a child) is
        // the signal.
        onClick={(event) => {
          if (event.target === dialogRef.current) closeMenu();
        }}
      >
        {/* Unmounted while closed — an always-present full-viewport element
            sitting over the hero is a real LCP risk and a wasted layer. */}
        {open && (
          <div
            className={cn(
              "sheet-in flex h-full flex-col bg-void-0/95 px-6 pb-10 pt-4",
              "supports-[backdrop-filter]:bg-void-0/70 supports-[backdrop-filter]:backdrop-blur-2xl"
            )}
          >
            <div className="flex h-16 flex-none items-center justify-between">
              <span className="flex items-center gap-2.5 text-ink">
                <Mark className="h-[22px] w-[22px]" />
                <span className="text-sm font-medium tracking-tight">VoidCode AI</span>
              </span>
              <button
                type="button"
                onClick={closeMenu}
                aria-label="Close menu"
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-ink transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                <span aria-hidden className="relative block h-5 w-5">
                  <span className="absolute left-0 top-1/2 h-px w-full rotate-45 bg-current" />
                  <span className="absolute left-0 top-1/2 h-px w-full -rotate-45 bg-current" />
                </span>
              </button>
            </div>

            <nav className="mt-6 flex-1" aria-label="Main">
              <ul className="border-t border-line">
                {links.map((link) => {
                  const isHash = link.href.startsWith("#");
                  const className =
                    "block py-5 text-2xl font-light tracking-tight text-ink";
                  return (
                    <li key={link.href} className="border-b border-line">
                      {isHash ? (
                        <a
                          href={link.href}
                          onClick={(event) => onHashClick(event, link.href)}
                          className={className}
                        >
                          {link.label}
                        </a>
                      ) : (
                        /* No onClick: the `pathname` effect above closes the
                           sheet once the route actually changes. Closing on
                           click instead would dismiss the menu even when the
                           navigation is cancelled or fails. */
                        <Link href={link.href} className={className}>
                          {link.label}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        )}
      </dialog>
    </>
  );
}
