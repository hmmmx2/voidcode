"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

/**
 * The route-level error boundary.
 *
 * There was none, so an unhandled throw inside any client component escaped to
 * Next.js's built-in overlay — a light-themed default in an all-dark app, and in
 * production a bare "Application error: a client-side exception has occurred"
 * with no way forward except the back button.
 *
 * MUST be a client component and MUST accept `reset`: that is the contract Next
 * defines for `error.tsx`. `reset` re-renders the segment without a full page
 * load, which recovers a transient failure while keeping the user where they were.
 *
 * DELIBERATELY DOES NOT SHOW `error.message`. A thrown error can carry a database
 * string, an internal URL or a stack fragment, and a user-facing page is not the
 * place to publish it. `digest` is Next's own hash of the server-side error, safe
 * to display, and it is the only thing that lets a support conversation match a
 * report to a log line.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The console is where the detail belongs. Swap for a real reporter when one
    // exists — this is the single place every client-side throw passes through.
    console.error("Unhandled error:", error);
  }, [error]);

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
        Something broke
      </p>
      <h1 className="mt-4 max-w-[22ch] text-[clamp(1.75rem,4vw,2.5rem)] font-light leading-[1.1] tracking-tight text-ink">
        That didn&rsquo;t work.
      </h1>
      <p className="mt-5 max-w-[48ch] text-sm leading-relaxed text-ink-2">
        An unexpected error stopped this page from rendering. Trying again often
        works — the failure may have been momentary.
      </p>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-full border border-line-strong bg-void-3 px-4 py-2 text-sm text-ink transition-colors hover:border-ink-3"
        >
          Try again
        </button>
        <Link
          href="/homepage"
          className="rounded-full border border-line px-4 py-2 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          Your dashboard
        </Link>
      </div>

      {error.digest && (
        <p className="mt-10 font-mono text-xs text-ink-3">
          Reference {error.digest}
        </p>
      )}
    </main>
  );
}
