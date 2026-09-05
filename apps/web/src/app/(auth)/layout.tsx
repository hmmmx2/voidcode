import type { ReactNode } from "react";

/**
 * Shared shell for `/login` and `/register`.
 *
 * A route group, so it does not appear in the URL — both paths are unchanged
 * and `middleware.ts` needs no adjustment for the grouping itself.
 *
 * `min-h-screen`, never `h-screen` with `overflow-y-auto`. A nested scroll
 * container silently breaks anything scroll-linked and the failure is baffling
 * when it happens, because the page looks fine and only the motion is dead.
 * Nothing here is scroll-linked today; this is about not laying the trap.
 *
 * The backdrop is the landing hero's, verbatim: a soft vertical gradient plus
 * one wide drifting bloom. That is not decoration — §5 move 5 of the design
 * brief — the glass needs something to refract, and over flat black the object
 * has no interior at all. It replaces `bg-login.svg`, which was a `priority`
 * `next/image` sitting in the LCP path for a decorative blur.
 *
 * `isolate` is load-bearing. The backdrop sits at negative z so content can
 * occlude it; without a stacking context here it paints behind the root
 * layout's black background and disappears entirely.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-screen overflow-hidden bg-void-0 text-ink-2">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[900px] bg-[linear-gradient(to_bottom,#111114_0%,#050506_45%,#000000_100%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-10%] -z-20 h-[720px] w-[1100px] -translate-x-1/2 animate-drift rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.045),transparent)]"
      />
      {/* Monochrome gradients band on 8-bit displays; 3% noise removes it. */}
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-0" />

      {children}
    </div>
  );
}
