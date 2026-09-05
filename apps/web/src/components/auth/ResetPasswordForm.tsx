"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormError } from "./FormError";
import { GlassPanel } from "./GlassPanel";
import { StrengthMeter } from "./StrengthMeter";
import { PasswordField } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { validatePassword } from "@/lib/validation/auth";

/**
 * Set a new password from an emailed link.
 *
 * WHY THE TOKEN IS NOT VALIDATED ON ARRIVAL
 *
 * There is no "check this token" endpoint and there should not be: it would let
 * anyone test tokens without committing to a password, which is a free oracle for
 * guessing. The token is submitted together with the new password, and the API
 * decides in one step.
 *
 * The cost is that an expired or already-used link is only discovered after
 * typing a password. That is why the failure copy names the reason — "this link
 * has expired", "this link has already been used" — and puts a request-a-new-one
 * link directly in the error, rather than leaving the user to guess whether they
 * mistyped.
 *
 * A MISSING TOKEN IS HANDLED SEPARATELY. Landing on /reset-password with no
 * `?token=` means a mangled link or a bare URL, and showing a password form that
 * cannot possibly succeed wastes the effort and reads as broken.
 */
export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <GlassPanel className="mt-9">
        <h2 className="text-base font-medium text-ink">This link is incomplete</h2>
        <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
          The reset link is missing its token, which usually means it was cut
          short by an email client. Request a new one and open it directly.
        </p>
        <div className="mt-7">
          <Pill href="/forgot-password" variant="solid" size="md">
            Request a new link
          </Pill>
        </div>
      </GlassPanel>
    );
  }

  if (done) {
    return (
      <GlassPanel className="mt-9">
        <h2 className="text-base font-medium text-ink">Password changed</h2>
        <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
          You can sign in with your new password now. Any other reset links you
          were sent have stopped working.
        </p>
        <div className="mt-7">
          <Pill href="/login" variant="solid" size="md">
            Sign in
          </Pill>
        </div>
      </GlassPanel>
    );
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    // Mirrors the server rule for immediate feedback. The server checks again —
    // this endpoint is reachable with curl, so the client check is a
    // convenience, never the control.
    const invalid = validatePassword(password);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/proxy/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (response.ok) {
        setDone(true);
        return;
      }

      const body = await response.json().catch(() => null);
      if (response.status === 400) {
        // The API's message already distinguishes expired, spent and invalid.
        // Surfacing it verbatim beats a generic failure, and it is written to be
        // shown to a user.
        setFormError(
          typeof body?.detail === "string"
            ? body.detail
            : "This link is not valid. Request a new one.",
        );
        return;
      }
      if (response.status === 422) {
        setError(
          typeof body?.detail?.detail === "string"
            ? body.detail.detail
            : "That password isn't strong enough.",
        );
        return;
      }
      if (response.status === 429) {
        setFormError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      setFormError("Something went wrong. Please try again.");
    } catch {
      setFormError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <GlassPanel className="mt-9">
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <PasswordField
          id="reset-password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error ?? undefined}
          disabled={pending}
          hint={<StrengthMeter password={password} />}
        />

        {formError && (
          <FormError>
            {formError}{" "}
            <Link
              href="/forgot-password"
              className="text-ink underline-offset-4 hover:underline"
            >
              Request a new link
            </Link>
          </FormError>
        )}

        <Pill type="submit" variant="solid" size="md" disabled={pending}>
          {pending ? "Saving…" : "Set new password"}
        </Pill>
      </form>
    </GlassPanel>
  );
}
