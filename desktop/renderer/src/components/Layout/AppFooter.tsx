"use client";

import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

// ── Link groups ────────────────────────────────────────────────────────────

const FOOTER_LINKS = [
  {
    // "Platform" until the Terms rewrite, which spent its length explaining that there is no
    // platform here — and then this column sat on the same page calling it one. The links are all
    // study surfaces, so the heading may as well say what they are.
    heading: "Study",
    links: [
      { label: "Dashboard", href: "/homepage" },
      { label: "Problems", href: "/problems" },
      { label: "Interviews", href: "/interviews" },
    ],
  },
  /*
    NO "Account" COLUMN. It held "Profile" and "Settings", both pointing at `/profile` — two labels
    for one destination, headed by a word for something this application does not have. There is no
    account: no sign-in, no credentials, and the `profile` table has no email column, which
    `tests/honest-copy.test.ts` now asserts the legal pages agree with.

    `/profile` itself is real and stays reachable from the workbench; what is gone is the column
    implying it is an account portal.
  */
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
        {/*
          "All rights reserved" was the wrong sentence on an Apache-2.0 distribution — the licence
          reserves very little, and the whole point of shipping under it is that the reader has
          rights. Naming the licence and linking the page that explains it is both true and more
          useful than a formula.
        */}
        <p className="font-mono text-[10px] tracking-[0.02em] text-ink-3/60">
          &copy; {year} VoidCode AI &middot;{" "}
          <Link href="/terms" className="hover:text-ink-2 transition-colors">
            Apache-2.0 licensed
          </Link>
        </p>
        {/*
          The stack line. It said "Qwen2.5-7B · SGLang · AWQ", to match a marketing footer in the
          web repository — a cross-repo invariant with nothing on the other end, and the only one
          of them a user could actually read: this footer renders on /privacy and /terms.

          All three were wrong. There is no SGLang provider (`inference/registry.ts` serves Ollama,
          llama.cpp and OpenRouter); nothing serves AWQ, and `lib/models/describe.ts` says as much
          by treating AWQ as the thing that would matter *if* a provider ever did; and the app ships
          no model at all — the user installs one, and the catalogue notes that the bare
          `qwen2.5-coder:7b` tag 404s, so it named a model you cannot even pull by that name.

          What replaces it is the part of the claim that is true and that does not go stale when
          someone pulls a different model: the two local backends. The intent of the original — make
          this feel like one product — is worth keeping; naming someone else's stack is not.
        */}
        <p className="font-mono text-[10px] tracking-[0.02em] text-ink-3/60">
          Local models · Ollama or llama.cpp
        </p>
      </div>
    </footer>
  );
}
