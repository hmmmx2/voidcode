"use client";

import { GlassCanvas } from "./GlassCanvas";
import { FacetSphere } from "./FacetSphere";

/**
 * The `dynamic()` target for `/login`. Exists to be a chunk boundary — see
 * `HeroCanvasEntry` for why every route needs its own.
 *
 * Shadows stay on: the sphere is non-convex and its self-shadowed valleys are
 * what separate the facets. See `FacetSphere`.
 */
export function LoginCanvasEntry({
  downgraded,
  onReady,
}: {
  downgraded: boolean;
  onReady: () => void;
}) {
  return (
    <GlassCanvas onReady={onReady}>
      <FacetSphere downgraded={downgraded} />
    </GlassCanvas>
  );
}
