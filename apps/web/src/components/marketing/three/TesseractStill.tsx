/**
 * Tier-0 for the tesseract. Pure CSS, in the server HTML, zero JavaScript.
 *
 * This one can be near-literal where the other stills could only approximate,
 * because a projected hypercube at rest is two nested squares plus four
 * diagonals — all straight lines, which CSS borders draw exactly. No gradient
 * masking, no conic tricks.
 *
 * The diagonals are the load-bearing part. Two nested squares alone read as a
 * picture frame; it is the four struts joining their corners that make the eye
 * read depth and see a cube inside a cube. Drawn as rotated 1px rules whose
 * length is the box diagonal ratio.
 *
 * Values follow the same rule as every other still: mostly dark, with the edges
 * carrying the brightness, because on the live object the beams are the only
 * thing catching light and the interior is empty.
 */
export function TesseractStill() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 blur-[4px]">
      {/* Bloom, so the frame sits in the page rather than being cut out of it. */}
      <div className="absolute inset-[-10%] rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.04),transparent_72%)] blur-2xl" />

      <div className="absolute inset-[24%]">
        {/* The four struts joining outer corners to inner corners. Rendered
            first so the squares' edges sit on top of them at the joints. */}
        {[
          "left-0 top-0 origin-top-left rotate-45",
          "right-0 top-0 origin-top-right -rotate-45",
          "left-0 bottom-0 origin-bottom-left -rotate-45",
          "right-0 bottom-0 origin-bottom-right rotate-45",
        ].map((position) => (
          <div
            key={position}
            className={`absolute h-px w-[31%] bg-[linear-gradient(to_right,rgba(255,255,255,0.42),rgba(255,255,255,0.14))] ${position}`}
          />
        ))}

        {/* Outer cell — the nearer cube, so the brighter frame. */}
        <div className="absolute inset-0 border border-white/45" />

        {/* Inner cell. Dimmer, because in the live projection it is further
            along w and its beams are correspondingly smaller and darker. 22%
            inset matches the ~0.35 inner/outer ratio the real projection sits
            at for most of its cycle. */}
        <div className="absolute inset-[22%] border border-white/22" />

        {/* A faint wash inside the inner cell — the live object refracts the
            page through its far beams, which reads as a soft interior glow
            rather than empty black. */}
        <div className="absolute inset-[22%] bg-[radial-gradient(closest-side,rgba(255,255,255,0.045),transparent)]" />

        {/* One clipped specular on the upper-left outer edge, matching where the
            key lightformer sits. Thin and bright is what separates glass from
            plastic — this is the only near-white value in the whole still. */}
        <div className="absolute left-0 top-0 h-px w-[55%] bg-[linear-gradient(to_right,rgba(255,255,255,0.9),transparent)]" />
        <div className="absolute left-0 top-0 h-[55%] w-px bg-[linear-gradient(to_bottom,rgba(255,255,255,0.9),transparent)]" />
      </div>
    </div>
  );
}
