import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { LoginObject } from "@/components/marketing/three/LoginObject";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = {
  // `noindex` because the URL carries a single-use credential in its query
  // string. A crawler that indexed it would publish live reset tokens, and a
  // crawler that merely *fetched* it would not burn one — the token is only spent
  // on POST — but the URL itself must not end up in a search result or a referrer.
  robots: { index: false, follow: false },
  title: "Set a new password — VoidCode AI",
  description: "Set a new password for your VoidCode AI account.",
};

/**
 * `/reset-password?token=…`
 *
 * `middleware.ts:32-38` has listed this path in `AUTH_PATHS` all along, and had
 * dedicated logic for it at line 54 — but the page did not exist, so every
 * request 404'd. Dead routing config that looks like a working feature.
 *
 * `Suspense` is required, not stylistic: `ResetPasswordForm` reads
 * `useSearchParams()` to get the token, and Next throws at build time if that is
 * not suspended.
 */
export default function ResetPasswordPage() {
  return (
    <AuthShell
      object={<LoginObject />}
      brand={
        <Link
          href="/"
          className="inline-flex items-center gap-3 text-ink transition-opacity hover:opacity-80"
        >
          <Mark className="h-8 w-8" />
          <span className="text-base font-medium tracking-tight">VoidCode AI</span>
        </Link>
      }
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
        Account recovery
      </p>

      <h1 className="mt-5 max-w-[16ch] text-[clamp(2.25rem,4.5vw,3.25rem)] font-light leading-[1.05] tracking-tight text-ink">
        Set a new password.
      </h1>

      <p className="mt-6 max-w-[46ch] text-base leading-relaxed text-ink-2">
        Choose something you don&rsquo;t use anywhere else. Setting it here signs
        out any other reset links you were sent.
      </p>

      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
