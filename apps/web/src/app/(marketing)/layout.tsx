import type { Metadata } from "next";

/**
 * Marketing shell.
 *
 * This route group exists for one structural reason: every other group layout in
 * this app is a fixed-viewport shell — `(homepage)/layout.tsx` is
 * `h-screen` with `overflow-y-auto` on `<main>`, and `(profile)` does the same.
 * That makes `<main>` a *nested scroll container*, so scroll events fire on the
 * element rather than on `window`.
 *
 * The landing page's entire motion system — the hero handoff, the reveal
 * primitive, and the native `animation-timeline: view()` footer — depends on the
 * document being the scroller. Reusing one of those layouts would break all of
 * it silently, with no error to trace. Hence `min-h-screen` here, never
 * `h-screen`, and no `overflow` anywhere in the tree.
 */

const TITLE = "VoidCode AI — Interview preparation for ML engineers";
const DESCRIPTION =
  "Prepare for machine learning and systems interviews with a tutor that guides you to the solution rather than writing it. Real code execution, inspectable reasoning, self-hosted models.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "VoidCode AI",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {/*
        Monaco is fetched from jsDelivr at runtime — `@monaco-editor/react` has no
        `loader.config({ monaco })` call anywhere in this app, so it falls through
        to the CDN. The hero demo mounts it on viewport intersection, well after
        LCP; opening the connection early costs nothing and saves a DNS + TLS
        round-trip at the moment the visitor scrolls to it.
      */}
      <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />

      {/*
        `.reveal` starts at opacity 0 and is only un-hidden by an
        IntersectionObserver. Without this, a visitor with JavaScript disabled
        would get a page of invisible sections — the content is all in the HTML,
        so it would be a purely self-inflicted failure.
      */}
      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>
      <div className="relative min-h-screen bg-void-0 text-ink-2">{children}</div>
    </>
  );
}
