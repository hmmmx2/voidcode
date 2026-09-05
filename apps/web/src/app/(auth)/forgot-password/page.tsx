import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { LoginObject } from "@/components/marketing/three/LoginObject";
import { AuthShell } from "@/components/auth/AuthShell";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Reset your password — VoidCode AI",
  description: "Recover access to your VoidCode AI account.",
};

/**
 * `/forgot-password`.
 *
 * This page used to state plainly that password reset was not available, because
 * it wasn't: no mail provider, no `auth_tokens` table, nothing that could deliver
 * or verify a link. Its docblock said that when delivery existed, the page should
 * become the real form and the explanation should be the first thing deleted.
 * That is what happened here.
 *
 * It also used to tell users they could change their password from their profile.
 * There was no such feature — `routers/profile.py` had only GET and PUT. That
 * sentence is gone; there is now a real control on the profile page instead.
 *
 * STILL A SERVER COMPONENT. Only `ForgotPasswordForm` crosses the client
 * boundary, so the heading — the intended LCP element — is server-rendered text
 * with no JavaScript in front of it. No `Suspense` needed: unlike `LoginForm`,
 * nothing here reads `useSearchParams()`.
 */
export default function ForgotPasswordPage() {
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
        Reset your password.
      </h1>

      <p className="mt-6 max-w-[46ch] text-base leading-relaxed text-ink-2">
        Enter the address on your account and we&rsquo;ll send you a link to set a
        new password. Signing in with Google or Microsoft doesn&rsquo;t use a
        password, so there would be nothing to reset.
      </p>

      <ForgotPasswordForm />
    </AuthShell>
  );
}
