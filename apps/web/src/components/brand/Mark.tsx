import { cn } from "@/lib/utils";

/**
 * The VoidCode AI mark — an open aperture ring.
 *
 * r=10 with stroke-width 5 gives an outer Ø of 25 and a hole of 15 — a ratio of
 * 0.600. That number was inherited: the hero object was once a beveled annulus
 * with an outer 1.55 and an inner 0.92, a ratio of 0.594, and the mark was built
 * to echo it within 1%.
 *
 * THAT ECHO IS NOW APPROXIMATE, and it is worth saying so rather than leaving a
 * comment that quietly stops being true. The hero object is a triple-twist
 * pleated Möbius (`fan-geometry.ts`) with no single hole/rim ratio at all: its
 * three-lobed silhouette sweeps from 0.374 at the lobe minima to 0.615 at the
 * pinches. The mark's 0.600 now sits *inside* that range rather than outside it,
 * which is a better defence of the echo than the old single number was.
 *
 * The mark is deliberately left alone. It ships in six call sites, the favicon
 * and the generated OG image, and it still reads as the same family — a circular
 * aperture held open — which is what the echo was ever really for. Do not chase
 * the object's numbers here; if the two are to be reconciled, it should be a
 * decision about the brand, not a side effect of tuning a 3D model.
 *
 * The ring is deliberately not closed, which is also the product's thesis: it
 * withholds the last piece.
 *
 * WHY THE GAP IS AT TOP DEAD CENTRE
 *
 * The first version put the gap on the upper-left diagonal, to line up with the
 * hero object's key specular. Rendered at 16–48px it read unmistakably as a
 * **loading spinner** — an arbitrary diagonal gap is the defining visual cue of
 * one, because spinners rotate. Moving it to a cardinal axis kills that read
 * completely at no cost. Tested against seven alternatives; for the record, a
 * centred bar reads as a power button, concentric rings read as a bullseye, and
 * variable stroke weight is not achievable with `stroke` at all (concentric
 * arcs of differing widths step visibly at the joins).
 *
 * GEOMETRY. 52° gap bisected by 270° (straight up in SVG's y-down space), so
 * the drawn arc is the complementary 308° running clockwise from 296° round to
 * 244°. Endpoints are (16 + 10·cos θ, 16 + 10·sin θ), mirror-symmetric about the
 * vertical as they must be. `large-arc-flag=1` because 308° > 180°;
 * `sweep-flag=1` for clockwise.
 *
 * Drawn as an explicit arc rather than `stroke-dasharray` on a `<circle>`. A
 * dashed circle is the obvious approach and it is a trap: SVG2's equivalent path
 * starts at 3 o'clock and runs clockwise, so the gap lands somewhere unintended
 * and needs an unexplained rotate() that nobody re-derives when reading the
 * diff. Satori, which renders the OG image, also has patchy dasharray support.
 *
 * `butt` caps are not a style preference. Round caps eat stroke-width/2 at each
 * end — at 16px that removes 2.5px from a 4.4px opening and the notch all but
 * closes. Butt caps remove nothing and leave two flat radial cuts.
 *
 * No `shape-rendering`: every feature is a curve, and `crispEdges` would disable
 * anti-aliasing and staircase the ring at favicon sizes.
 *
 * NOTE: `app/icon.svg` carries the same ring at a tighter framing (viewBox 27,
 * ~1 unit of padding instead of 3.5) because a favicon is drawn into a 16px box
 * where padding costs legibility. Genuinely duplicated geometry — change one,
 * change the other.
 */
export function Mark({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      /* An inline <svg> with only a viewBox stretches to fill its containing
         block in Chrome, so a call site that forgets a size class gets a
         600px logo. `1em` makes the failure mode "inherits the font size".
         Classes still win — CSS beats presentation attributes. */
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinecap="butt"
      /* Every call site puts the accessible name on the wrapping link or
         button, so announcing this too would double it up. */
      aria-hidden="true"
      focusable="false"
      className={cn("h-6 w-6", className)}
      {...props}
    >
      <path d="M20.384 7.012A10 10 0 1 1 11.616 7.012" />
    </svg>
  );
}
