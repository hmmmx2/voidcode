/**
 * The icon set, drawn here rather than installed.
 *
 * `ActivityBar` used to argue that two 22px glyphs were not a reason to add a dependency, and
 * that held while there were two. There are now a dozen across the title bar, the rail, the
 * assistant header and the dock — and the cost of not having a set had become visible rather
 * than theoretical: two different gear glyphs shipped at once, at different stroke weights, on
 * different viewBox grids, both routing to the same page. A set fixes that without taking on
 * an icon engine, its tree-shaking story, or its licence.
 *
 * **One grid, one weight.** Every glyph is authored on `0 0 16 16` with `strokeWidth={1.3}`,
 * `fill="none"`, and `stroke="currentColor"` so colour comes from the parent. Callers pick a
 * pixel size; they do not pick a viewBox. That is the whole reason the old icons looked
 * mismatched — a 20px glyph on a 22 grid at weight 1.4 sits next to a 16px glyph on a 24 grid
 * at weight 1.5 and reads as two different families, because it is.
 *
 * Rounded caps and joins throughout. At 16px an unrounded terminus reads as a stray pixel.
 */

export interface IconProps {
  /** Rendered size in px. The viewBox never changes, so weight stays visually constant. */
  size?: number;
  className?: string;
}

/**
 * Shared attributes, spread into every glyph.
 *
 * `aria-hidden` by default: these sit inside buttons that carry their own `aria-label` or
 * visible text, and a labelled icon inside a labelled button is read out twice.
 */
function base(size: number, className: string | undefined) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...(className === undefined ? {} : { className }),
  };
}

/**
 * Settings — a circle with six radial ticks.
 *
 * Replaces two glyphs that both meant "settings": a starburst in the activity rail and a
 * ~700-character Feather cog in the top nav. The cog lost on two counts — its teeth turn to
 * mush below 20px, which is where it was actually used, and a single 700-char path is
 * unmaintainable by hand. Six ticks rather than eight: at 16px, eight closes the gaps and the
 * ring reads as a solid disc.
 */
export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.4v1.6M8 13v1.6M14.6 8h-1.6M3 8H1.4M12.67 3.33l-1.13 1.13M4.46 11.54l-1.13 1.13M12.67 12.67l-1.13-1.13M4.46 4.46 3.33 3.33" />
    </svg>
  );
}

/** The account. Head and shoulders, on the same grid as everything else. */
export function IconAccount({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M2.9 14a5.1 5.1 0 0 1 10.2 0" />
    </svg>
  );
}

/**
 * The bell.
 *
 * Redrawn from the 24-grid original so it sits at the same optical weight as its neighbours in
 * the title bar. The clapper is a separate short arc rather than part of the body outline —
 * joined, it fills in at small sizes.
 */
export function IconBell({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12.2 6.4a4.2 4.2 0 1 0-8.4 0c0 4.4-1.9 5.7-1.9 5.7h12.2s-1.9-1.3-1.9-5.7" />
      <path d="M9.2 14.2a1.4 1.4 0 0 1-2.4 0" />
    </svg>
  );
}

/** Chat. A speech bubble with a tail, for the assistant's Chat view. */
export function IconChat({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M13.8 9.6a1.7 1.7 0 0 1-1.7 1.7H5.3L2.2 14V4.1a1.7 1.7 0 0 1 1.7-1.7h8.2a1.7 1.7 0 0 1 1.7 1.7Z" />
    </svg>
  );
}

/** History. A clock whose hands point up-left, so it is not mistaken for a plain circle. */
export function IconHistory({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 4.5V8l2.4 1.4" />
    </svg>
  );
}

/**
 * A model. A processor die with pins.
 *
 * This was stacked plates, on the theory that it echoed the Interview Prep layers without
 * being the same glyph. It was the same glyph. Both sat in the activity rail at 20px, four
 * slots apart, and were indistinguishable — the kind of thing that is obvious in a screenshot
 * and invisible in a diff.
 *
 * A chip is also the better metaphor: what the model manager is really about is what this
 * machine can hold, which is why the page it opens leads with VRAM.
 */
export function IconModel({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" />
      <path d="M6.4 1.6v2.6M9.6 1.6v2.6M6.4 11.8v2.6M9.6 11.8v2.6M1.6 6.4h2.6M1.6 9.6h2.6M11.8 6.4h2.6M11.8 9.6h2.6" />
    </svg>
  );
}

/** Plus. The composer's attach-context menu. */
export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

/** Terminal. A prompt chevron and a caret line. */
export function IconTerminal({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
      <path d="M4.4 6.4 6.5 8.4l-2.1 2M8.6 10.8h3" />
    </svg>
  );
}

/** A warning triangle, for the Problems tab and diagnostic rows. */
export function IconWarning({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 2.3 1.6 13.3h12.8L8 2.3Z" />
      <path d="M8 6.6v3.1M8 11.7h.01" />
    </svg>
  );
}

/** Output. Lines of text, one short, suggesting a log rather than a document. */
export function IconOutput({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M2.4 4.2h11.2M2.4 8h11.2M2.4 11.8h6.6" />
    </svg>
  );
}

/**
 * Plan — a checklist: a tick against the first line, bullets against the rest.
 *
 * Deliberately distinct from `IconOutput`, which is also horizontal lines. That one is a log
 * and has no marks in the margin; this one does, and at 13px in a tab strip the marks are the
 * only thing separating the two silhouettes.
 */
export function IconPlan({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M1.9 4.1 3 5.2l2-2.2" />
      <path d="M7.4 4.2h6.7" />
      <circle cx="3.1" cy="8" r="0.9" />
      <path d="M7.4 8h6.7" />
      <circle cx="3.1" cy="11.8" r="0.9" />
      <path d="M7.4 11.8h4.2" />
    </svg>
  );
}

/**
 * Steps — a rising stair.
 *
 * A sequence that got somewhere, which is what a run's steps are. Three treads rather than
 * four: at 16px a fourth drops each tread below two pixels and the whole glyph reads as noise.
 */
export function IconSteps({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M1.8 13.2h3.4V9.4h3.4V5.6h3.4V1.8" />
    </svg>
  );
}

/**
 * Preview — a browser frame: a window with a title strip and two dots for its controls.
 *
 * A globe would say "the internet", which is the opposite of what this is: a preview is the
 * user's own project on their own machine, and `preview/url.ts` refuses any address that is not
 * loopback precisely to keep that true.
 */
export function IconPreview({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" />
      <path d="M1.8 6h12.4" />
      <circle cx="3.9" cy="4.4" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="5.9" cy="4.4" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Design — overlapping rectangles, the way a layout is sketched before it is a layout.
 *
 * Not a paintbrush and not a colour wheel: what this surface shows is a specification with token
 * names in it, not a picture, and an icon promising a canvas would misdescribe the tab.
 */
export function IconDesign({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="1.9" y="1.9" width="8" height="8" rx="1.2" />
      <rect x="6.1" y="6.1" width="8" height="8" rx="1.2" />
    </svg>
  );
}

/** Close. A cross, sized to sit inside a 16px button without touching its edges. */
export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
