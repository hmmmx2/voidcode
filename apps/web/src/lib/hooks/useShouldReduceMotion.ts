"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether motion should be suppressed for this visitor.
 *
 * Two details this exists to get right:
 *
 * It **subscribes** rather than reading once. A visitor who flips the OS
 * setting mid-session gets the new behaviour without a reload, which matters
 * because the people who use this preference are the people most likely to
 * toggle it while a page is misbehaving.
 *
 * It starts `false` on the server and during the first client render, then
 * corrects in an effect. Returning `true` initially would be the safer-looking
 * choice but it causes a hydration mismatch, and worse, it would flash the
 * static fallback for every visitor before settling.
 *
 * Consumers must treat `true` as "render the final state now" — not "animate
 * more slowly". See `docs/LANDING_BRIEF.md` §11 for the per-primitive contract;
 * the case most often missed is that scripted autoplay must not start at all.
 */
export function useShouldReduceMotion(): boolean {
  const [shouldReduce, setShouldReduce] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    setShouldReduce(mql.matches);

    const onChange = (event: MediaQueryListEvent) => setShouldReduce(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return shouldReduce;
}
