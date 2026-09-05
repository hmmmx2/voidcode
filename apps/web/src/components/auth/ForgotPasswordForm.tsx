"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { FormError } from "./FormError";
import { GlassPanel } from "./GlassPanel";
import { Field } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { validateEmail } from "@/lib/validation/auth";

/**
 * Request a password reset link.
 *
 * WHY THE CONFIRMATION NEVER SAYS WHETHER THE ACCOUNT EXISTS
 *
 * The API returns one identical message for every case — unknown address,
 * OAuth-only account, deactivated account, mail provider down. This screen must
 * not undo that. "No account with that email" would turn the form into a
 * membership oracle for any email list someone cares to paste in, which is the
 * same reason sign-in returns one error for every kind of failure.
 *
 * So the success panel is shown for ANY 200, and the wording is careful: "if
 * that address has a password account". It reads as slightly evasive because it
 * has to.
 *
 * Only two things produce a visible error: a malformed email, caught here before
 * the request, and the request itself failing to complete.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const invalid = validateEmail(email);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/proxy/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (response.status === 429) {
        // The one failure worth distinguishing: retrying immediately cannot help,
        // and without this the form looks broken rather than throttled.
        setFormError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      if (!response.ok) {
        setFormError("Something went wrong. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setFormError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <GlassPanel className="mt-9">
        <h2 className="text-base font-medium text-ink">Check your inbox</h2>
        <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
          If that address has a password account, a reset link is on its way. The
          link works once and expires within the hour.
        </p>
        <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-3">
          Nothing arrived? It may not be a password account — signing in with
          Google or Microsoft doesn&rsquo;t use one, so there is nothing to reset.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Pill href="/login" variant="solid" size="md">
            Back to sign in
          </Pill>
          <Pill
            variant="ghost"
            size="md"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            Use a different address
          </Pill>
        </div>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className="mt-9">
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <Field
          id="forgot-email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={error ?? undefined}
          disabled={pending}
        />

        {formError && <FormError>{formError}</FormError>}

        <Pill type="submit" variant="solid" size="md" disabled={pending}>
          {pending ? "Sending…" : "Send reset link"}
        </Pill>
      </form>

      <p className="mt-6 text-sm leading-relaxed text-ink-3">
        Remembered it?{" "}
        <Link href="/login" className="text-ink underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </GlassPanel>
  );
}
