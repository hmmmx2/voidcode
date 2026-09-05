import Link from "next/link";
import { Container, MonoLabel } from "@/components/marketing/primitives/SectionShell";
import { Mark } from "@/components/brand/Mark";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "#how", label: "How it works" },
      { href: "#tracks", label: "Tracks" },
      { href: "#faq", label: "FAQ" },
      { href: "/login", label: "Sign in" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

/**
 * Footer.
 *
 * The wordmark animates on a native CSS scroll-driven timeline — no JS, no
 * observer, no motion-library subscription. `animation-timeline: view()` is
 * exactly the case scroll-driven animations were specified for, and browsers
 * without it simply get the static end state, which is a perfectly good footer.
 * See `.wordmark` in `globals.css`.
 */
export function MarketingFooter() {
  // `.footer-shell` clips the wordmark with `overflow: clip` rather than
  // `hidden` — see globals.css. Not interchangeable here: `hidden` makes this a
  // scroll container and silently freezes the wordmark's view timeline.
  return (
    <footer className="footer-shell relative border-t border-line">
      <Container className="pt-16 lg:pt-20">
        {/*
          TWO BLOCKS, NOT THREE COLUMNS.

          `justify-between` across brand + Product + Legal distributes the free
          space evenly, which sounds right and looks wrong: the three blocks are
          207px, 80px and 43px wide, so evenly spacing them strands two thin
          stacks of links in the middle of a 1160px row with 415px of nothing on
          either side of them. Grouping the link columns and pushing the group
          right gives the row two masses instead of three specks, and the gap
          inside the group is a fixed measure rather than whatever is left over
          — so it no longer changes when a link is added.
        */}
        <div className="flex flex-col gap-12 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-[28ch]">
            <p className="flex items-center gap-2.5 text-sm font-medium text-ink">
              <Mark className="h-5 w-5" />
              VoidCode AI
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Guided preparation for machine learning and systems interviews.
            </p>
          </div>

          <div className="flex gap-x-16 lg:gap-x-24">
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <p className="text-[10px] uppercase tracking-[0.18em] text-ink-3">
                  {column.heading}
                </p>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.href + link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-ink-2 transition-colors hover:text-ink"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
          <MonoLabel>© {new Date().getFullYear()} VoidCode AI</MonoLabel>
          <MonoLabel>Qwen2.5-7B · SGLang · AWQ</MonoLabel>
        </div>
      </Container>

      {/*
        THE WORDMARK SITS IN A `Container` LIKE EVERYTHING ELSE.

        It used to be full-bleed with its own `px-6 lg:px-10`, which is the
        same padding but measured from the viewport rather than from the 1240px
        column, so the two only agreed on a screen narrow enough for the
        container to be full width. Measured at 3440 the word ran 40 → 1494
        while the footer content above it ran 1093 → 2333: the largest element
        on the page did not overlap the block it belongs to at all.

        `.wordmark-frame` makes this `Container` an inline-size query container
        so the type scales from *its* width. See `--text-wordmark` in
        globals.css for the measured coefficient.
      */}
      <Container className="wordmark-frame">
        <p aria-hidden className="wordmark select-none text-wordmark">
          VOIDCODE
        </p>
      </Container>
    </footer>
  );
}
