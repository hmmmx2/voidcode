/**
 * The hero object — Tier 0.
 *
 * A thick, beveled, hollow ring: a literal void. The brand is VoidCode, and the
 * silhouette also reads as a lens or aperture, which suits the ML framing. It is
 * not a sphere or a plain torus for a specific reason — a monochrome glass object
 * has very low internal contrast, so the *outline* does most of the work and a
 * stock primitive would read as a grey blob.
 *
 * This file is the static tier and it is the one that ships in the server HTML.
 * It is also the final state for three separate cases, which is why it is real
 * artwork rather than a spinner:
 *
 *   - `prefers-reduced-motion: reduce`  — the canvas never mounts
 *   - no WebGL, or a software rasterizer — the canvas never mounts
 *   - before idle on every visit        — the canvas mounts after LCP
 *
 * `HeroObject` cross-fades the live R3F canvas over the top. The two tiers are no
 * longer the same *shape*: the canvas renders a pleated Möbius fan whose hole is
 * a rounded triangle and whose rim pinches three times per lap. A CSS
 * `radial-gradient` cannot produce three lobes at all, so this is deliberately a
 * soft, circular *impression* of that form — blurred enough that the 1200ms
 * cross-fade reads as detail resolving rather than one shape becoming another.
 *
 * What has been kept accurate is the **value structure**: the ring's radii were
 * moved from 62–65% of the half-box to 43–47%, because the fan is a thick
 * annulus (mean hole/rim ≈ 0.45) where the old solid band was a thin one. That
 * mismatch is the kind 6px of blur does not hide. Nothing here may shift layout.
 *
 * The apparent glass is a conic gradient masked into an annulus. The stop
 * positions are not arbitrary: they place one clipped white specular at ~68deg
 * (the grazing key light), a broad satin falloff through the lower body, and a
 * second dimmer highlight at ~300deg for the fill. Full black at 0/200deg keeps
 * the value range at its extremes, which is what stops it reading as plastic.
 */
export function HeroObjectStill() {
  return (
    <div
      aria-hidden
      // Fills the box `HeroObject` positions. Placement lives there, once, so the
      // still and the canvas cannot drift apart from each other.
      //
      // The blur is what lets a ring stand in for a twisted band: it keeps the
      // value structure and the circular void, and gives up the crisp annulus
      // edge that would otherwise announce the swap.
      className="pointer-events-none absolute inset-0 blur-[6px]"
    >
      {/* Bloom the object sheds onto the void behind it. */}
      <div className="absolute inset-[-16%] rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.05),transparent_70%)] blur-2xl" />

      {/* Body.
          The stops are overwhelmingly black on purpose. A monochrome glass
          object that is *mostly bright* reads as polished metal — the thing that
          says "glass" is a dark body interrupted by two narrow, clipped
          speculars, one from the grazing key at ~66deg and a dimmer fill at
          ~297deg. Widening either of them costs the illusion immediately. */}
      <div
        className="absolute inset-0 rounded-full opacity-[0.62]"
        style={{
          background:
            "conic-gradient(from 210deg," +
            "#000000 0deg,#0d0d0f 30deg,#2a2a2a 52deg,#a3a3a3 62deg,#ffffff 66deg,#555555 73deg," +
            "#1a1a1a 92deg,#000000 140deg,#000000 214deg,#141416 252deg,#3a3a3a 286deg," +
            "#848484 297deg,#2a2a2a 306deg,#0d0d0f 332deg,#000000 360deg)",
          maskImage:
            "radial-gradient(closest-side, transparent 43%, #000 47%, #000 100%)",
          WebkitMaskImage:
            "radial-gradient(closest-side, transparent 43%, #000 47%, #000 100%)",
        }}
      />

      {/* Polished outer bevel — a hairline catching the key light. Thin and
          bright is what separates glass from resin. */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 210deg,transparent 0deg,transparent 50deg,rgba(255,255,255,0.85) 66deg,transparent 84deg," +
            "transparent 284deg,rgba(255,255,255,0.32) 299deg,transparent 316deg,transparent 360deg)",
          maskImage: "radial-gradient(closest-side, transparent 96.5%, #000 98%)",
          WebkitMaskImage: "radial-gradient(closest-side, transparent 96.5%, #000 98%)",
        }}
      />

      {/* Inner bevel. Reads as the far wall of the aperture seen through the
          body, which is where the sense of thickness comes from. */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 30deg,transparent 0deg,rgba(255,255,255,0.45) 22deg,transparent 54deg," +
            "transparent 200deg,rgba(255,255,255,0.2) 224deg,transparent 248deg,transparent 360deg)",
          maskImage: "radial-gradient(closest-side, transparent 42%, #000 45%, transparent 48%)",
          WebkitMaskImage:
            "radial-gradient(closest-side, transparent 42%, #000 45%, transparent 48%)",
        }}
      />

      {/* Satin diffusion over the whole body. Uniform polish is invisible in a
          dark scene; a soft blurred copy underneath gives it mass. */}
      <div
        className="absolute inset-0 rounded-full opacity-25 blur-md"
        style={{
          background:
            "conic-gradient(from 210deg,#000000 0deg,#1a1a1a 58deg,#d4d4d4 68deg,#262626 118deg," +
            "#000000 210deg,#555555 298deg,#000000 360deg)",
          maskImage: "radial-gradient(closest-side, transparent 41%, #000 50%, #000 100%)",
          WebkitMaskImage:
            "radial-gradient(closest-side, transparent 41%, #000 50%, #000 100%)",
        }}
      />
    </div>
  );
}
