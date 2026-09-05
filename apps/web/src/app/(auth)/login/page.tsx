import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { LoginObject } from "@/components/marketing/three/LoginObject";
import { LoginForm } from "@/components/auth/LoginForm";
import { AuthShell } from "@/components/auth/AuthShell";

export const metadata: Metadata = {
  title: "Sign in — VoidCode AI",
  description: "Sign in to VoidCode AI.",
};

/**
 * `/login`.
 *
 * A SERVER COMPONENT, deliberately. The whole page used to be `"use client"`
 * for the sake of one checkbox. Now only `LoginForm` crosses the boundary, so
 * the heading — the intended LCP element — is plain server-rendered text with
 * no JavaScript in front of it.
 *
 * `Suspense` around the form is required, not stylistic: `LoginForm` reads
 * `useSearchParams()` to surface NextAuth's `?error=`, and Next throws at build
 * time if that is not suspended.
 */
export default function LoginPage() {
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
      {/*
        COPY: enterprise convention is a plain action headline plus one concrete
        supporting line. The previous pair — "Pick up where you left off." over
        "...exactly where you left them." — failed on three counts: it said the
        same thing twice, it was written in a consumer-app register that does
        not match a technical interview-prep product, and it named internal
        vocabulary ("drafts", "tutor history") that means nothing to someone who
        has not used the product yet.

        What replaces it names the product on the sign-in screen (the page a
        returning user lands on from a bookmark, often without context) and
        states what the account holds in plain terms.
      */}
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
        Sign in
      </p>

      {/* Weight 300 at display size, matching the landing headline. The old page
          used `text-5xl font-bold`, which is the opposite end of the scale and
          the single loudest reason it read as a different product. */}
      <h1 className="mt-5 max-w-[16ch] text-[clamp(2.25rem,4.5vw,3.25rem)] font-light leading-[1.05] tracking-tight text-ink">
        Welcome back to VoidCode&nbsp;AI.
      </h1>

      <p className="mt-6 max-w-[44ch] text-base leading-relaxed text-ink-2">
        Sign in to continue your interview preparation. Your workspace, saved
        solutions and tutor conversations are restored automatically.
      </p>

      <Suspense fallback={<div className="mt-10 h-[168px]" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
