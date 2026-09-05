import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { RegisterObject } from "@/components/marketing/three/RegisterObject";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { AuthShell } from "@/components/auth/AuthShell";

export const metadata: Metadata = {
  title: "Create an account — VoidCode AI",
  description: "Create a VoidCode AI account.",
};

/**
 * `/register`.
 *
 * `reverse` mirrors the columns against `/login` — object left, form right. The
 * two pages are otherwise the same shell, and without the mirror they read as
 * the same page failing to navigate.
 *
 * `Suspense` is required, not stylistic: `RegisterForm` reads `useSearchParams`
 * for `callbackUrl`, and Next throws at build time if that is not suspended.
 */
export default function RegisterPage() {
  return (
    <AuthShell
      reverse
      object={<RegisterObject />}
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
        COPY: "Start asking better questions." was the weakest line on either
        page. It is an aphorism, not a value proposition — it never says what
        the product is, so a visitor arriving cold from the landing CTA learns
        nothing, and it reads as a slogan rather than as a page heading.

        The replacement states the product category outright, which is what an
        account-creation screen is for. The supporting line is deliberately
        concrete about what an account *does*, and deliberately silent on
        curriculum scope — `docs/OPEN_QUESTIONS.md` Q-010 records that the ML
        content does not exist yet, and this page must not claim it.
      */}
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-3">
        Create account
      </p>

      <h1 className="mt-5 max-w-[16ch] text-[clamp(2.25rem,4.5vw,3.25rem)] font-light leading-[1.05] tracking-tight text-ink">
        Interview preparation, guided.
      </h1>

      <p className="mt-6 max-w-[44ch] text-base leading-relaxed text-ink-2">
        Create an account to track your progress, review every submission and
        return to any tutor conversation from any device.
      </p>

      <Suspense fallback={<div className="mt-9 h-[520px]" />}>
        <RegisterForm />
      </Suspense>
    </AuthShell>
  );
}
