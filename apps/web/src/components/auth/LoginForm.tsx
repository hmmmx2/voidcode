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
import { Field, PasswordField } from "@/components/ui/Field";
import { validateEmail } from "@/lib/validation/auth";
import { cn } from "@/lib/utils";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

/**
 * NextAuth failure codes → sentences a human can act on.
 *
 * THIS IS THE FIX FOR A SILENT FAILURE. `auth.ts` sets `pages.error: "/login"`,
 * so every authentication failure redirects back here with `?error=<code>` —
 * and the previous page never read it. A rejected sign-in produced the login
 * screen again, unchanged, indistinguishable from a click that didn't register.
 */
const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: "That email and password don't match an account.",
  OAuthAccountNotLinked:
    "That email is already registered with a different sign-in method. Use the provider you signed up with.",
  OAuthSignin: "We couldn't reach that sign-in provider. Try again in a moment.",
  OAuthCallback: "That sign-in didn't complete. Try again.",
  OAuthCreateAccount: "We couldn't create your account. Try again in a moment.",
  Callback: "That sign-in didn't complete. Try again.",
  AccessDenied: "That account doesn't have access to VoidCode AI.",
  Verification: "That sign-in link has expired. Request a new one.",
  Configuration:
    "Sign-in is misconfigured on our side. This is not something you can fix — please report it.",
};

const FALLBACK_ERROR = "Something went wrong signing you in. Try again.";

type Provider = "google" | "microsoft-entra-id";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validated, not trusted: this value comes from the query string, and
  // it ends up in `router.push`. See `safeCallbackUrl`.
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(
    searchParams.get("error")
      ? (ERROR_MESSAGES[searchParams.get("error")!] ?? FALLBACK_ERROR)
      : null
  );
  const [pending, setPending] = useState<Provider | "credentials" | null>(null);

  const handleOAuth = (provider: Provider) => {
    setPending(provider);
    void signIn(provider, { callbackUrl });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    // Validate before touching the network. The server re-checks everything —
    // this only saves a round trip and stops a password being sent at all when
    // the email is obviously malformed.
    const emailError = validateEmail(email);
    // Deliberately NOT running the full password policy here. On *sign-in* the
    // rules that applied at registration are irrelevant and possibly outdated:
    // telling a returning user their existing password "must be 12 characters"
    // is both useless and alarming. Only emptiness is checked.
    const passwordError = password ? undefined : "Enter your password.";

    if (emailError || passwordError) {
      setFieldErrors({ email: emailError ?? undefined, password: passwordError });
      return;
    }
    setFieldErrors({});
    setPending("credentials");

    // `redirect: false` so failures render in place rather than bouncing
    // through `?error=` and losing everything typed.
    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      remember: String(remember),
      redirect: false,
    });

    if (!result || result.error) {
      setPending(null);
      setFormError(
        result?.code
          ? (ERROR_MESSAGES[result.code] ?? ERROR_MESSAGES.CredentialsSignin)
          : ERROR_MESSAGES.CredentialsSignin
      );
      return;
    }

    // `refresh()` before navigating: middleware reads the session cookie, and
    // without it the very next navigation can still be evaluated against the
    // pre-sign-in state and bounce straight back here.
    router.refresh();
    router.push(callbackUrl);
  };

  const busy = pending !== null;

  return (
    <GlassPanel className="mt-9">
      {formError && <FormError>{formError}</FormError>}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          disabled={busy}
          error={fieldErrors.email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <div>
          <PasswordField
            label="Password"
            name="password"
            autoComplete="current-password"
            placeholder="••••••••••••"
            value={password}
            disabled={busy}
            error={fieldErrors.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="mt-2 flex justify-end">
            <Link
              href="/forgot-password"
              className="text-xs text-ink-3 underline-offset-4 transition-colors hover:text-ink-2 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        <Checkbox
          checked={remember}
          onChange={setRemember}
          disabled={busy}
          label="Keep me signed in for 30 days"
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
            "Sign in"
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
          Continue with Microsoft
        </ProviderButton>

        <ProviderButton
          icon={<GoogleIcon />}
          onClick={() => handleOAuth("google")}
          pending={pending === "google"}
          disabled={busy}
        >
          Continue with Google
        </ProviderButton>
      </div>

      <p className="mt-8 text-sm text-ink-3">
        New here?{" "}
        <Link
          href="/register"
          className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink-3"
        >
          Create an account
        </Link>
      </p>
    </GlassPanel>
  );
}
