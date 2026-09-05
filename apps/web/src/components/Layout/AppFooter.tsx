"use client";

import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

// ── Link groups ────────────────────────────────────────────────────────────

const FOOTER_LINKS = [
  {
    heading: "Platform",
    links: [
      { label: "Dashboard", href: "/homepage" },
      { label: "Problems", href: "/problems" },
      { label: "Interviews", href: "/interviews" },
      { label: "Research", href: "/research" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Profile", href: "/profile" },
      { label: "Settings", href: "/profile" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Terms of Use", href: "/terms" },
      { label: "Privacy Policy", href: "/privacy" },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function AppFooter() {
  const year = new Date().getFullYear();

  return (
    /* No background fill. The old `bg-[#040407]` was a second, slightly
       different black sitting on the page's own — which cut the footer out of
       the backdrop's gradient and left a visible seam on wide screens. A
       hairline is the separator here, as everywhere else. */
    <footer className="mt-auto border-t border-line">
      {/* ── Main content row ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-8 px-6 pb-6 pt-8 sm:flex-row sm:justify-between sm:gap-0 lg:px-10">

        {/* Brand column.

            This was a 110×110 <Image> of the old two-square logo — the last
            place the red #ed1c2e survived. It is now a lockup rather than a
            bare mark, deliberately: the mark's stroke is tuned to stay legible
            at 16px, so at 110px it renders a ~20px-thick ring, which is a black
            hole in the corner of a footer. Pairing a small mark with the
            wordmark says the same thing and never needs a giant standalone
            glyph. */}
        <div className="flex min-w-[160px] flex-col gap-3">
          <div className="flex items-center gap-2.5 text-ink">
            <Mark className="h-6 w-6" />
            <span className="text-sm font-medium tracking-tight">VoidCode AI</span>
          </div>
          <p className="max-w-[220px] text-[11px] leading-relaxed text-ink-3">
            Guided preparation for machine learning and systems interviews.
          </p>
        </div>

        {/* Link columns */}
        <div className="flex gap-10 sm:gap-14">
          {FOOTER_LINKS.map((group) => (
            <div key={group.heading} className="flex flex-col gap-2.5">
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                {group.heading}
              </p>
              {group.links.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  className="text-[12px] text-ink-2 transition-colors duration-150 ease-void hover:text-ink"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────── */}
      <div className="flex flex-col items-center justify-between gap-2 border-t border-line px-6 py-3 sm:flex-row lg:px-10">
        <p className="font-mono text-[10px] tracking-[0.02em] text-ink-3/60">
          &copy; {year} VoidCode AI. All rights reserved.
        </p>
        {/* The stack line, matching the marketing footer's — it is the same
            claim, and repeating it here is what makes the app feel like the
            same product rather than a portal bolted onto one. */}
        <p className="font-mono text-[10px] tracking-[0.02em] text-ink-3/60">
          Qwen2.5-7B · SGLang · AWQ
        </p>
      </div>
    </footer>
  );
}
