"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Mark } from "@/components/brand/Mark";
import { Pill } from "@/components/ui/Pill";
import { MobileMenu } from "@/components/Layout/MobileMenu";

export const NAV_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#tracks", label: "Tracks" },
  { href: "#faq", label: "FAQ" },
];

/**
 * Transparent over the hero, then contracts into a floating glass pill.
 *
 * THE STRUCTURE IS THE POINT. The glass is a childless absolutely-positioned
 * sibling, not a background on the bar itself. That separation is what keeps
 * this cheap: the content row is `h-16` at every scroll position and never
 * re-measures, so the only layout-animating property on the whole component is
 * `max-width` on one element — and `contain: layout` stops even that from
 * invalidating anything outside the bar.
 *
 * The naive version animates the header's height and background together. That
 * runs ~18 layout passes over a subtree containing text, during exactly the
 * frames when `HeroHandoff`'s rAF loop is writing transforms and calling
 * getBoundingClientRect. The two are guaranteed to overlap — the nav flips at
 * 32px and the handoff plays across the whole hero.
 *
 * The glass never changes size either. It sits at `inset-y-1` and `rounded-full`
 * permanently and is simply invisible at rest, so only opacity crosses the
 * compositor. The apparent shrink comes entirely from the bar's max-width.
 *
 * Scroll state is a `data-` attribute written straight to the node from a
 * rAF-throttled passive listener — no React state, no re-render per scroll
 * event. Same approach as `HeroHandoff`, for the same reason.
 *
 * `will-change` is deliberately absent: `max-width` is not compositable so it
 * would do nothing, and `will-change: transform` would stack a second layer on
 * top of the one `backdrop-filter` already forces, which is the classic cause of
 * blurry text under glass on Windows fractional DPI.
 */
export function MarketingNav() {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    let frame = 0;
    let scrolled = false;

    const read = () => {
      frame = 0;
      const y = window.scrollY;

      // Hysteresis: enter at 32, leave at 8. Oscillation is impossible here — a
      // fixed element cannot change document height — but flicker is not.
      // Momentum and rubber-band settling on macOS/iOS cross a single threshold
      // several times within a few frames, and a trackpad user can park on it.
      const next = scrolled ? y >= 8 : y > 32;
      if (next === scrolled) return;

      scrolled = next;
      bar.dataset.scrolled = String(next);
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    // `pointer-events-none` on the header so the transparent full-width strip
    // does not swallow clicks on the hero beneath it; the bar re-enables them.
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div
        ref={barRef}
        // Rendered in the SSR markup so the attribute selector always has
        // something to match — no hydration mismatch and no first-paint flash.
        data-scrolled="false"
        className={[
          "group pointer-events-auto relative isolate mx-auto flex h-16 items-center gap-6 px-6 lg:px-10",
          "[contain:layout]",
          // max-w-[1240px] and the padding match `Container`, so at rest the
          // logo lines up with the hero's grid. Once contracted it deliberately
          // stops aligning — that is what a floating pill should do.
          "max-w-[1240px] data-[scrolled=true]:max-w-[min(920px,calc(100vw-2rem))]",
          "translate-y-0 data-[scrolled=true]:translate-y-3",
          "transition-[max-width,translate] duration-[400ms] ease-void motion-reduce:transition-none",
        ].join(" ")}
      >
        {/* The glass. Fixed geometry, animated opacity only.

            The @supports order matters: the near-opaque black is the *default*
            and the translucent white film is the enhancement. Reversed, a
            browser without backdrop-filter gets a white haze over scrolling
            content, which is unreadable. Black is clean and looks deliberate. */}
        <div
          aria-hidden
          className={[
            "nav-glass absolute inset-y-1 left-0 right-0 -z-10 rounded-full",
            "opacity-0 group-data-[scrolled=true]:opacity-100",
            "bg-void-0/85 supports-[backdrop-filter]:bg-white/[0.045] supports-[backdrop-filter]:backdrop-blur-xl",
            // Inset top highlight is the single tell that reads as glass; on a
            // pill it follows the curve and lands as a crescent.
            "shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.09),inset_0_-1px_0_0_rgb(255_255_255_/_0.02),0_8px_32px_-12px_rgb(0_0_0_/_0.9)]",
            "transition-opacity duration-300 ease-void motion-reduce:transition-none",
          ].join(" ")}
        />

        <Link
          href="/"
          className="flex flex-none items-center gap-2.5 whitespace-nowrap text-ink transition-opacity hover:opacity-80"
          aria-label="VoidCode AI, home"
        >
          <Mark className="h-[22px] w-[22px]" />
          <span className="text-sm font-medium tracking-tight">VoidCode AI</span>
        </Link>

        <nav className="mx-auto hidden items-center gap-8 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="whitespace-nowrap text-sm text-ink-2 transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-none items-center gap-2">
          <Pill href="#download" variant="solid" size="sm">
            Download
          </Pill>
          {/* Links are passed down rather than imported by MobileMenu, which
              would make the two modules circular. */}
          <MobileMenu
            links={NAV_LINKS}
            actions={
              <>
                <Pill href="#download" variant="solid" size="lg">
                  Download
                </Pill>
              </>
            }
          />
        </div>
      </div>
    </header>
  );
}
