"use client";

import { GlassCanvas } from "./GlassCanvas";
import { MobiusFan } from "./MobiusFan";

/**
 * The `dynamic()` target for the landing hero.
 *
 * This module exists only to be a chunk boundary. `next/dynamic` needs a static
 * import specifier, so every route that renders a 3D object needs its own tiny
 * entry module like this one — the alternative, passing a component down as a
 * prop, would force the caller to import it eagerly and defeat the whole thing.
 *
 * Everything expensive is reachable only from here and its siblings, which is
 * what lets Turbopack hoist `three` + drei into a single shared vendor chunk
 * rather than three copies. See `TieredObject` for the invariant that keeps it
 * that way, and §13 of the brief for the grep that proves it.
 *
 * `shadows` is left at its default `true`: the fan's blades cannot refract each
 * other, so the shadow pass is the only thing separating one pleat from the next.
 */
export function HeroCanvasEntry({
  downgraded,
  onReady,
}: {
  downgraded: boolean;
  onReady: () => void;
}) {
  return (
    <GlassCanvas onReady={onReady}>
      <MobiusFan downgraded={downgraded} />
    </GlassCanvas>
  );
}
