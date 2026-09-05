"use client";

import dynamic from "next/dynamic";
import { HeroObjectStill } from "./HeroObjectStill";
import { TieredObject } from "./TieredObject";

/**
 * The landing hero's object — a binding, nothing more.
 *
 * All the machinery (reduced-motion gate, idle capability probe, 1.2s crossfade)
 * lives in `TieredObject`; all the expensive code lives behind this `dynamic()`.
 * Everything that remains here is the two things that are actually specific to
 * this route: which still to show, and which canvas to load.
 */
const HeroCanvas = dynamic(
  () => import("./HeroCanvasEntry").then((mod) => mod.HeroCanvasEntry),
  { ssr: false }
);

export function HeroObject() {
  return (
    <TieredObject
      still={<HeroObjectStill />}
      renderLive={(downgraded, onReady) => (
        <HeroCanvas downgraded={downgraded} onReady={onReady} />
      )}
    />
  );
}
