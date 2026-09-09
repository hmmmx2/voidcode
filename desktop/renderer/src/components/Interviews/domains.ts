/**
 * Per-domain accent colours.
 *
 * WHY THIS PAGE HAS COLOUR AND THE PROBLEMS PAGE DOES NOT
 *
 * Problems are a queue: one flat list, worked in curriculum order, where the
 * only thing that distinguishes a row is whether you have solved it. Colour
 * there would be decoration.
 *
 * Interviews are a map. You arrive knowing you are weak on CUDA and want to
 * find it, so domain is the primary axis and the page is grouped by it rather
 * than filtered. Once domain is structure rather than metadata, giving each one
 * a hue does real work: it makes a section identifiable at a glance, from the
 * scroll position, without reading a heading.
 *
 * Held to a strict budget so it stays a system rather than a rainbow:
 *   - Never a fill. Accents appear as a hairline, a soft glow, and small
 *     glyph-sized marks. Surfaces stay `void`, text stays `ink`.
 *   - Never load-bearing. Every accent pairs with a text label, so the page is
 *     unchanged for anyone who cannot distinguish the hues.
 *   - Never the verdict colours. Pass/fail green and red are spent on test
 *     results and are deliberately absent from this palette, so a green section
 *     header can never be misread as "passing".
 *
 * Plain CSS custom properties applied inline, NOT Tailwind `@theme` tokens.
 * Tailwind v4 tree-shakes theme tokens that no utility references, and these
 * are only ever consumed through arbitrary values — so declaring them in
 * `@theme` would silently emit nothing.
 */

export interface DomainAccent {
  /** The hue itself, as a bare `r g b` triple so it can take an alpha in situ. */
  rgb: string;
  /** One line on what the domain covers, shown under the section heading. */
  blurb: string;
}

export const DOMAIN_ACCENTS: Record<string, DomainAccent> = {
  ml: {
    rgb: "56 189 248", // sky
    blurb: "Gradients, cost-optimal thresholds, rank statistics.",
  },
  dl: {
    rgb: "167 139 250", // violet
    blurb: "Parameter counts, memory budgets, optimiser internals.",
  },
  maths: {
    rgb: "251 191 36", // amber
    blurb: "Derivations you do out loud, with a result you can check.",
  },
  llm: {
    rgb: "45 212 191", // teal
    blurb: "RoPE, FLOP crossovers, sampling, decode throughput.",
  },
  vlm: {
    rgb: "244 114 182", // rose
    blurb: "InfoNCE, token budgets, IoU, embedding geometry.",
  },
  cuda: {
    rgb: "132 204 22", // lime
    blurb: "Roofline, transaction counts, occupancy, KV cache, bubbles.",
  },
};

/** Neutral fallback so an unrecognised domain renders rather than crashing. */
export const FALLBACK_ACCENT: DomainAccent = { rgb: "148 163 184", blurb: "" };

export function accentFor(domain: string): DomainAccent {
  return DOMAIN_ACCENTS[domain] ?? FALLBACK_ACCENT;
}
