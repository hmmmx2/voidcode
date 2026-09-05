import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The frosted surface the auth forms sit on.
 *
 * `.glass-panel` (globals.css) supplies the translucent fill, the backdrop blur
 * and — via a selector it shares with `.nav-glass` — the 1px hairline edge that
 * is brighter along the top. Sharing that rule is deliberate: the nav pill and
 * this panel appear on the same site, and a small difference in edge opacity
 * between them reads as one of the two being broken.
 *
 * WHAT THE PANEL DELIBERATELY DOES NOT CONTAIN
 *
 * The headline and supporting copy stay outside it. Wrapping those too would
 * produce the conventional centred auth card, which is exactly what this layout
 * exists instead of — the display type is meant to sit on the page at the same
 * scale as the landing hero, and boxing it shrinks it into a component. The
 * panel starts at the first input, so it reads as "the thing you interact with"
 * rather than "the content region".
 *
 * WHY IT NEEDS SOMETHING BEHIND IT
 *
 * A backdrop blur over flat black is invisible — there is nothing to blur, and
 * the panel degenerates into a slightly lighter rectangle. It works here only
 * because the `(auth)` layout puts a drifting radial bloom and a film-grain
 * layer behind it. If that backdrop is ever removed, this stops being glass and
 * becomes a grey box, and the fix is to restore the backdrop rather than to
 * raise the fill.
 */
export function GlassPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass-panel overflow-hidden rounded-[1.75rem] p-6 sm:p-8",
        // The blur is a utility, not part of `.glass-panel` — a hand-written
        // `backdrop-filter` in globals.css was measurably dropped by Tailwind
        // v4's CSS pipeline while the neighbouring `background` survived. See
        // the note above `.glass-panel` in globals.css.
        //
        // `backdrop-blur-xl` is 24px, larger than the 14px originally chosen,
        // because the backdrop here is a soft gradient with a drifting bloom —
        // there is nothing sharp for a small radius to act on, so a smaller
        // blur costs the same compositing work for less visible effect.
        "backdrop-blur-xl backdrop-saturate-150",
        // A soft lift so the panel reads as sitting *above* the page rather
        // than being cut into it. Very low opacity — on a black page a
        // conventional drop shadow is invisible, and anything strong enough to
        // see reads as a dark halo.
        "shadow-[0_24px_70px_-40px_rgb(0_0_0/0.9)]",
        className
      )}
    >
      {children}
    </div>
  );
}
