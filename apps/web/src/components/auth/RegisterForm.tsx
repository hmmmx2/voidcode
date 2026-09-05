"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { GoogleIcon, MicrosoftIcon } from "./ProviderIcons";
import { ProviderButton } from "./ProviderButton";
import { FormError } from "./FormError";
import { GlassPanel } from "./GlassPanel";
import { Checkbox } from "./Checkbox";
import { StrengthMeter } from "./StrengthMeter";
import { Field, PasswordField } from "@/components/ui/Field";
import {
  validateEmail,
  validateName,
  validatePassword,
} from "@/lib/validation/auth";
import { cn } from "@/lib/utils";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

type Provider = "google" | "microsoft-entra-id";

/**
 * Account creation.
 *
 * ONE PASSWORD FIELD, NOT TWO. The "confirm password" convention predates
 * reveal toggles: it exists because you could not see what you typed. With a
 * reveal control the second field adds a step, a failure mode and a place to
 * paste the wrong thing, and it catches nothing a reveal does not. If the
 * password is wrong anyway, reset exists.
 *
 * The terms checkbox lives here and NOT on `/login`. Consent belongs at the
 * point the account is created; asking a returning user to re-accept terms they
 * agreed to at signup is both meaningless and, on the old login page, actively
 * broken — it disabled both sign-in buttons with nothing explaining why.
 */
export function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validated, not trusted: this value comes from the query string, and
  // it ends up in `router.push`. See `safeCallbackUrl`.
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);

  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
    terms?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<Provider | "credentials" | null>(null);

  const handleOAuth = (provider: Provider) => {
    setPending(provider);
    void signIn(provider, { callbackUrl });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    // The password rules take the email and name, because a password containing
    // either is guessable by anyone who can see the account.
    const next = {
      name: validateName(name) ?? undefined,
      email: validateEmail(email) ?? undefined,
      password: validatePassword(password, { email, name }) ?? undefined,
      terms: accepted ? undefined : "You need to accept the terms to continue.",
    };

    if (Object.values(next).some(Boolean)) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending("credentials");

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          terms_accepted: accepted,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setPending(null);
        // 422 carries a field; anything else is a form-level problem.
        if (response.status === 422 && body.field) {
          setErrors({ [body.field]: body.detail });
        } else if (response.status === 429) {
          setFormError(
            body.detail ?? "Too many attempts. Wait a few minutes and try again."
          );
        } else {
          setFormError(body.detail ?? "We couldn't create your account. Try again.");
        }
        return;
      }

      /**
       * Registration succeeded — sign the new account straight in.
       *
       * THIS USED TO REDIRECT TO `/verify-email`, WHICH IS A 404.
       *
       * That page was never built, so every successful registration ended on
       * Next's default "This page could not be found" — with the account
       * silently created. The worst possible outcome: it looks like the signup
       * failed, so you try again and get "An account with that email already
       * exists", which reads like the form is broken twice over.
       *
       * Rebuilding it as a "check your inbox" screen would have been worse than
       * the 404, because it would be untrue. There is no mail provider
       * configured anywhere in this repo, and `email_verified_at` is never read
       * or written outside the model — verification currently gates nothing. A
       * page telling you to wait for an email that cannot be sent is a dead end
       * dressed up as a step.
       *
       * So: sign in, land on the app. When email delivery does exist, the
       * verification step belongs *after* this — as a banner on the dashboard
       * that can be dismissed and re-sent — rather than as a wall in front of
       * an account that already works.
       */
      const result = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });

      if (!result || result.error) {
        // The account exists; only the automatic sign-in failed. Say exactly
        // that, because "try again" would hit the duplicate-email error.
        setPending(null);
        setFormError(
          "Your account was created, but we couldn't sign you in automatically. Please sign in."
        );
        return;
      }

      // `refresh()` before navigating: middleware reads the session cookie, and
      // without it the very next navigation can still be evaluated against the
      // pre-sign-in state and bounce straight back to /login.
      router.refresh();
      router.push(callbackUrl);
    } catch {
      setPending(null);
      setFormError("We couldn't reach the server. Check your connection and try again.");
    }
  };

  const busy = pending !== null;

  return (
    <GlassPanel className="mt-9">
      {formError && <FormError>{formError}</FormError>}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Name"
          name="name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          disabled={busy}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />

        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          disabled={busy}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <div>
          <PasswordField
            label="Password"
            name="password"
            autoComplete="new-password"
            placeholder="At least 12 characters"
            value={password}
            disabled={busy}
            error={errors.password}
            onChange={(e) => setPassword(e.target.value)}
            hint="A few unrelated words beats a short complicated one."
          />
          {password && <StrengthMeter password={password} />}
        </div>

        <Checkbox
          checked={accepted}
          onChange={setAccepted}
          disabled={busy}
          error={errors.terms}
          label={
            <>
              I agree to the{" "}
              <Link href="/terms" className="text-ink underline underline-offset-2">
                Terms of Use
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-ink underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </>
          }
        />

        <button
          type="submit"
          disabled={busy}
          aria-busy={pending === "credentials"}
          className={cn(
            "mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-full",
            "bg-ink px-6 text-sm font-medium text-void-0",
            "transition-[transform,opacity,background-color] duration-200 ease-void",
            "hover:bg-ink/90 active:translate-y-px",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
            "disabled:cursor-not-allowed disabled:opacity-45"
          )}
        >
          {pending === "credentials" ? (
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-void-0/25 border-t-void-0"
            />
          ) : (
            "Create account"
          )}
        </button>
      </form>

      <div className="my-7 flex items-center gap-4" aria-hidden>
        <div className="h-px flex-1 bg-line-strong" />
        <span className="text-xs text-ink-3">or</span>
        <div className="h-px flex-1 bg-line-strong" />
      </div>

      <div className="flex flex-col gap-3">
        <ProviderButton
          icon={<MicrosoftIcon />}
          onClick={() => handleOAuth("microsoft-entra-id")}
          pending={pending === "microsoft-entra-id"}
          disabled={busy}
        >
          Sign up with Microsoft
        </ProviderButton>

        <ProviderButton
          icon={<GoogleIcon />}
          onClick={() => handleOAuth("google")}
          pending={pending === "google"}
          disabled={busy}
        >
          Sign up with Google
        </ProviderButton>
      </div>

      <p className="mt-8 text-sm text-ink-3">
        Already have an account?{" "}
        <Link
          href="/login"
          className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink-3"
        >
          Sign in
        </Link>
      </p>
    </GlassPanel>
  );
}
