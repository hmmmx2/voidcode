"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The product's one reveal primitive, shared by the landing page and the app.
 *
 * NO MOTION LIBRARY. Measured: `motion` costs 49 KB gz and lands in the initial
 * payload. This component appears about twenty times and only ever animates
 * opacity, an 8px translate and a blur — all three of which CSS transitions do
 * natively. Paying a library for that, twenty times over, in front of the hero,
 * is not a trade worth making. Nothing else in the codebase uses one either:
 * `HeroHandoff` is a hand-written rAF loop for exactly the same reason, and
 * `motion` is not in `package.json` at all.
 *
 * The displacement is **8px, not 40**. A big slide reads as a template; a short
 * blur-fade reads as the page settling. This is the single easiest thing to get
 * wrong and the difference is not subtle at full size.
 *
 * Reduced motion is handled entirely in CSS (see `.reveal` in `globals.css`) —
 * an opacity fade with no transform and no blur, not the same animation slowed
 * down. Keeping it in the stylesheet means there is no hook, no hydration branch
 * and no possibility of the JS and the CSS disagreeing.
 *
 * TWO TRAPS WHEN USING THIS OUTSIDE THE MARKETING ROUTE GROUP.
 *
 * 1. `.reveal` starts at `opacity: 0`, so any route group using it MUST carry
 *    the `<noscript>` override that resets it. Otherwise a visitor with JS
 *    disabled gets a blank page rather than a static one.
 *
 * 2. NEVER place this inside a subtree that gets `display: none`. An element
 *    that is not rendered never intersects, so it stays at `opacity: 0`
 *    permanently and comes back blank when the subtree is shown again. That is
 *    live in `ResizableLayout`, which hides the AI panel in expanded mode
 *    rather than unmounting it, to keep an in-flight SSE stream alive.
 */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  children,
}: {
  as?: "div" | "section" | "li";
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (!("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "-60px" }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement & HTMLLIElement>}
      className={cn("reveal", shown && "reveal-shown", className)}
      style={delay ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </Tag>
  );
}
