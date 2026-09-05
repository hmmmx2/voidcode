"use client";

import { useEffect, useState, type ReactNode } from "react";
import { probeCapability, type Capability } from "./capability";
import { useShouldReduceMotion } from "@/lib/hooks/useShouldReduceMotion";
import { cn } from "@/lib/utils";

/**
 * The two-tier shell every 3D object on this site is rendered through.
 *
 * TIER 0 — `still`. Pure CSS, in the server HTML, zero JavaScript. It is not a
 * placeholder: it is the final state for reduced motion, for devices with no
 * WebGL2 or a software rasteriser, and for everyone during the seconds before
 * the canvas mounts.
 *
 * TIER 1 — `renderLive`. Real transmission glass, loaded as its own chunk after
 * the browser reports itself idle, then cross-faded in over 1.2s once the first
 * frame has rendered. Fading on `onReady` rather than on mount is what prevents
 * the one-frame black flash you get from swapping immediately.
 *
 * Both tiers occupy the same box, so the swap never shifts layout and never
 * draws attention to itself.
 *
 * WHY `renderLive` IS A RENDER PROP AND NOT A COMPONENT
 *
 * `next/dynamic` needs a **statically analysable import specifier** to create a
 * chunk. Passing a component down as a prop would defeat that — the caller would
 * have to import it eagerly, which is precisely what we are avoiding. So each
 * route owns its own `dynamic()` call and hands the result down as a closure.
 * That also keeps this file free of any `three` import, which the payload
 * contract depends on:
 *
 *   **No module reachable from this one may import `three`,
 *   `@react-three/fiber` or `@react-three/drei`.**
 *
 * Today that holds: React, `capability.ts` (zero imports), the reduced-motion
 * hook, and `cn`. Break it and the lazy chunk silently becomes part of the
 * initial bundle — the page still works and the only symptom is the payload
 * budget moving, which is why §13's chunk grep exists.
 *
 * THE PROBE RUNS HERE, NOT IN THE CANVAS. It used to live inside the lazy
 * chunk, so an incapable device paid 256 KB gz to be told it was incapable.
 * `renderLive` is never called — and therefore the chunk is never fetched —
 * unless the device can actually use it.
 */
export function TieredObject({
  still,
  renderLive,
  className,
}: {
  still: ReactNode;
  renderLive: (downgraded: boolean, onReady: () => void) => ReactNode;
  className?: string;
}) {
  const shouldReduceMotion = useShouldReduceMotion();
  const [tier, setTier] = useState<Capability | "pending">("pending");
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Reduced motion never probes. Creating a WebGL context to then throw it
    // away is work nobody asked for, and this is the one visitor guaranteed
    // not to see the result.
    if (shouldReduceMotion) return;

    const schedule =
      window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 900));
    const handle = schedule(() => setTier(probeCapability()));
    return () => {
      if (window.cancelIdleCallback && typeof handle === "number") {
        window.cancelIdleCallback(handle);
      }
    };
  }, [shouldReduceMotion]);

  const wantsLive = !shouldReduceMotion && (tier === "full" || tier === "downgraded");

  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      <div
        className={cn(
          "absolute inset-0 transition-opacity duration-[1200ms] ease-void",
          live ? "opacity-0" : "opacity-100"
        )}
      >
        {still}
      </div>

      {wantsLive && (
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-[1200ms] ease-void",
            live ? "opacity-100" : "opacity-0"
          )}
        >
          {renderLive(tier === "downgraded", () => setLive(true))}
        </div>
      )}
    </div>
  );
}
