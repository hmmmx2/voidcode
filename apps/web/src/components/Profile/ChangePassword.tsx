"use client";

import { useState, type FormEvent } from "react";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { PasswordField } from "@/components/ui/Field";
import { StrengthMeter } from "@/components/auth/StrengthMeter";
import { validatePassword } from "@/lib/validation/auth";

/**
 * Change the password of the signed-in account.
 *
 * THIS IS THE FEATURE THE FORGOT-PASSWORD PAGE USED TO PROMISE. It said "you can
 * change your password from your profile at any time" while `routers/profile.py`
 * had only GET and PUT and nothing in this directory touched passwords. The
 * sentence was deleted when the reset flow landed; this is the control that makes
 * a version of it true again.
 *
 * WHY THE CURRENT PASSWORD IS REQUIRED
 *
 * The caller is already authenticated, so asking again looks redundant. It isn't:
 * a session is not proof of presence. A borrowed laptop or a stolen cookie should
 * not be enough to lock the real owner out of their own account, and re-entering
 * the password is what turns "someone has this session" into "someone knows the
 * secret". The API enforces it too — this field is not the control, it is the
 * prompt for it.
 *
 * OAUTH ACCOUNTS SEE NOTHING. Rendering a change-password form for an account
 * that has never had one produces a control that can only fail. `hasPassword`
 * comes from the profile payload, so the decision is server-side.
 */
export function ChangePassword({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  if (!hasPassword) {
    return (
      <Surface radius="panel" className="p-6">
        <h2 className="text-base font-medium text-ink">Password</h2>
        <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-2">
          This account signs in with Google or Microsoft, so it has no password to
          change. Your provider manages that.
        </p>
      </Surface>
    );
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSaved(false);

    if (!current) {
      setCurrentError("Enter your current password.");
      return;
    }
    const invalid = validatePassword(next);
    if (invalid) {
      setNextError(invalid);
      return;
    }
    if (next === current) {
      // Caught here rather than server-side: it is not a security rule, it is a
      // user who has not noticed the form did nothing.
      setNextError("That is already your password.");
      return;
    }
    setCurrentError(null);
    setNextError(null);
    setPending(true);

    try {
      const response = await fetch("/api/proxy/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });

      if (response.ok) {
        setSaved(true);
        setCurrent("");
        setNext("");
        return;
      }

      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        setCurrentError(
          typeof body?.detail === "string" ? body.detail : "That is not your current password.",
        );
        return;
      }
      if (response.status === 422) {
        setNextError(
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
    <Surface radius="panel" className="p-6">
      <h2 className="text-base font-medium text-ink">Password</h2>
      <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-2">
        Changing this signs out any reset links you were sent.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-5 max-w-sm space-y-5">
        <PasswordField
          id="current-password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={currentError ?? undefined}
          disabled={pending}
        />

        <PasswordField
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError ?? undefined}
          disabled={pending}
          hint={<StrengthMeter password={next} />}
        />

        {formError && (
          <p role="alert" className="text-sm leading-relaxed text-ink">
            {formError}
          </p>
        )}
        {saved && (
          // A live region: without it a screen reader gets no signal that the
          // form succeeded, because nothing else on the page changes.
          <p role="status" className="text-sm leading-relaxed text-ink-2">
            Your password has been changed.
          </p>
        )}

        <Pill type="submit" variant="solid" size="md" disabled={pending}>
          {pending ? "Saving…" : "Change password"}
        </Pill>
      </form>
    </Surface>
  );
}
