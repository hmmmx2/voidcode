import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

/**
 * 404.
 *
 * There was no `not-found.tsx` anywhere in the app, so every bad URL fell through
 * to Next.js's built-in page — a light-themed default in an app that is dark
 * everywhere else. It reads as a different site, which is worse than a plain
 * message, because the first thing a visitor concludes is that something is
 * broken rather than mistyped.
 *
 * A SERVER COMPONENT with no client dependencies. This page has to render when
 * something else has already gone wrong, so it deliberately pulls in no data
 * fetching, no session, and no Three.js — the fewer things it needs, the more
 * reliably it appears.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-void px-6 text-center">
      <Link
        href="/"
        className="inline-flex items-center gap-3 text-ink transition-opacity hover:opacity-80"
      >
        <Mark className="h-8 w-8" />
        <span className="text-base font-medium tracking-tight">VoidCode AI</span>
      </Link>

      <p className="mt-12 text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
        404
      </p>
      <h1 className="mt-4 max-w-[22ch] text-[clamp(1.75rem,4vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
        That page isn&rsquo;t here.
      </h1>
      <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-ink-2">
        The link may be out of date. Problems and interview questions are
        reachable from their catalogues.
      </p>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/problems"
          className="rounded-full border border-line-strong bg-void-3 px-4 py-2 text-sm text-ink transition-colors hover:border-ink-3"
        >
          Browse problems
        </Link>
        <Link
          href="/homepage"
          className="rounded-full border border-line px-4 py-2 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          Your dashboard
        </Link>
      </div>
    </main>
  );
}
