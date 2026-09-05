/**
 * Tier-0 for the facet sphere. Pure CSS, in the server HTML, zero JavaScript.
 *
 * Not a placeholder — this is the final state for reduced motion, for devices
 * with no WebGL2 or a software rasteriser, and for everyone in the seconds
 * before the canvas mounts.
 *
 * WHAT HAS TO MATCH IS THE VALUE STRUCTURE, NOT THE SHAPE.
 *
 * The same rule `HeroObjectStill` documents. A CSS gradient cannot draw 180
 * pyramids and should not try. What sells the crossfade is that both tiers are
 * *mostly black* with two narrow, near-clipped speculars in the same places —
 * key at the upper-left, fill at the lower-right. Get the values right and the
 * 6px blur absorbs every difference in geometry.
 *
 * The one thing that is shape-specific: a *conic* gradient with hard-quantised
 * stops, rather than the smooth sweep the fan uses. Facets are flat, so their
 * shading is piecewise constant, and a smooth ramp reads as a polished ball
 * instead. Ten bands is enough to suggest structure without pretending to
 * resolve individual facets — trying to match the real count would produce a
 * moiré against them during the fade.
 *
 * No JS, no `"use client"`. This ships in the initial HTML.
 */
export function FacetSphereStill() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 blur-[6px]">
      {/* Bloom. Sits outside the silhouette and gives the object somewhere to
          sit, rather than being cut out of the page. */}
      <div className="absolute inset-[-14%] rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.05),transparent_70%)] blur-2xl" />

      {/* Body — the faceted band structure. Quantised conic stops, masked to a
          disc. Values are deliberately low: the brightest band here is 0.30,
          because everything above that belongs to the speculars below. */}
      <div
        className="absolute inset-[12%] rounded-full opacity-[0.66]"
        style={{
          backgroundImage: `conic-gradient(from 200deg,
            rgba(255,255,255,0.05) 0deg 34deg,
            rgba(255,255,255,0.16) 34deg 62deg,
            rgba(255,255,255,0.30) 62deg 88deg,
            rgba(255,255,255,0.12) 88deg 124deg,
            rgba(255,255,255,0.04) 124deg 168deg,
            rgba(255,255,255,0.10) 168deg 206deg,
            rgba(255,255,255,0.22) 206deg 238deg,
            rgba(255,255,255,0.07) 238deg 286deg,
            rgba(255,255,255,0.18) 286deg 320deg,
            rgba(255,255,255,0.05) 320deg 360deg)`,
        }}
      />

      {/* Radial falloff. A conic gradient alone is flat — this is what makes it
          read as a sphere rather than a pinwheel: bright toward the upper-left
          lit side, falling to nothing at the lower-right limb. */}
      <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(circle_at_34%_30%,rgba(255,255,255,0.20),rgba(255,255,255,0.04)_46%,rgba(0,0,0,0.55)_78%,rgba(0,0,0,0.8))]" />

      {/* KEY specular, ~66°. Narrow and near-clipped — this is the one that
          reads as "glass" rather than "grey". Widening it is the fastest way to
          make the whole thing look like resin. */}
      <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(ellipse_18%_13%_at_32%_24%,rgba(255,255,255,0.92),rgba(255,255,255,0.22)_45%,transparent_72%)]" />

      {/* FILL specular, ~297°. Dimmer, and its job is to stop the lower-right
          limb dissolving into the page. */}
      <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(ellipse_13%_9%_at_71%_75%,rgba(255,255,255,0.34),transparent_68%)]" />

      {/* Rim hairline. The facet sphere's silhouette is a ring of points
          catching the environment, which at this blur is indistinguishable from
          a thin bright edge — so draw the edge. */}
      <div
        className="absolute inset-[12%] rounded-full"
        style={{
          background:
            "conic-gradient(from 200deg, transparent 0deg, rgba(255,255,255,0.55) 52deg, transparent 96deg, transparent 250deg, rgba(255,255,255,0.28) 292deg, transparent 330deg)",
          maskImage: "radial-gradient(closest-side, transparent 95%, #000 97.5%)",
          WebkitMaskImage: "radial-gradient(closest-side, transparent 95%, #000 97.5%)",
        }}
      />
    </div>
  );
}
