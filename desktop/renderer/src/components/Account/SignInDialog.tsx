"use client";

/**
 * Sign in, create an account, or reset a forgotten password — one dialog, three views.
 *
 * A DIALOG, NOT A ROUTE. The window is frameless, and a bare route draws no title bar, so a sign-in
 * page reached that way would have no way to close the window it was opened in. As a dialog it also
 * returns you exactly where you were, which is the promise an optional account has to keep.
 *
 * PASSWORDS LIVE IN THIS COMPONENT FOR ONE SUBMIT. Each is cleared the moment the request resolves,
 * success or not, because a password sitting in React state survives into devtools and heap
 * snapshots. Main exchanges it for a session; this component never sees the token.
 *
 * CLIENT-SIDE CHECKS ARE FOR LATENCY, NOT SECURITY. `lib/account/validation.ts` mirrors the server's
 * policy so someone learns their password is too short before it goes anywhere; the server's answer
 * is the one that counts, and its field errors land under the field they name.
 */
import { useEffect, useId, useState } from "react";
import { Modal } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { Field, PasswordField } from "@/components/ui/Field";
import { Mark } from "@/components/brand/Mark";
import { FormError } from "@/components/Account/FormError";
import { StrengthMeter } from "@/components/Account/StrengthMeter";
import { Checkbox } from "@/components/Account/Checkbox";
import TermsClient from "@/components/Legal/TermsClient";
import PrivacyClient from "@/components/Legal/PrivacyClient";
import { validateEmail, validateName, validatePassword } from "@/lib/account/validation";

export type SignInView = "signIn" | "register" | "forgot";

/** How long "Send a new code" stays disabled. The server also caps codes per address per hour. */
const RESEND_COOLDOWN_S = 60;

export default function SignInDialog({
  view,
  onViewChange,
  onClose,
  onSignedIn,
}: {
  view: SignInView | null;
  onViewChange: (view: SignInView) => void;
  onClose: () => void;
  onSignedIn: (email: string) => void;
}) {
  const titleId = useId();
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);

  return (
    <>
      {/*
        Stays open while a legal document is shown, and that is load-bearing rather than tidy:
        `Modal` reports ANY close through `onClose`, including a programmatic one, so closing this
        to show the Terms would have ended the dialog and thrown away what was typed. Native
        dialogs stack in the top layer, so the document simply opens above it, and Escape or a
        backdrop click closes only the topmost.
      */}
      <Modal
        open={view !== null}
        onClose={onClose}
        labelledBy={titleId}
        className="w-[420px] max-w-[calc(100vw-2rem)]"
      >
        {view === "signIn" && (
          <SignInForm titleId={titleId} onViewChange={onViewChange} onSignedIn={onSignedIn} />
        )}
        {view === "register" && (
          <RegisterForm
            titleId={titleId}
            onViewChange={onViewChange}
            onSignedIn={onSignedIn}
            onOpenLegal={setLegal}
          />
        )}
        {view === "forgot" && (
          <ForgotForm titleId={titleId} onViewChange={onViewChange} onSignedIn={onSignedIn} />
        )}
      </Modal>

      {/* The legal documents open over the dialog rather than navigating: `/terms` is a bare route,
          and leaving for it would lose what was typed. Closing returns to the form intact. */}
      <Modal
        open={legal !== null}
        onClose={() => setLegal(null)}
        labelledBy={`${titleId}-legal`}
        className="w-[min(960px,calc(100vw-2rem))]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={`${titleId}-legal`} className="text-sm font-medium text-ink">
            {legal === "privacy" ? "Privacy Policy" : "Terms of Use"}
          </h2>
          <Pill variant="ghost" size="sm" onClick={() => setLegal(null)}>
            Back
          </Pill>
        </div>
        <div className="max-h-[70vh] overflow-y-auto pr-2">
          {legal === "terms" && <TermsClient />}
          {legal === "privacy" && <PrivacyClient />}
        </div>
      </Modal>
    </>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function Header({ titleId, title, subtitle }: { titleId: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <Mark className="mt-0.5 h-6 w-6 text-ink" aria-hidden />
      <div>
        <h2 id={titleId} className="text-[15px] font-medium text-ink">
          {title}
        </h2>
        {subtitle !== undefined && <p className="mt-1 text-xs leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
    </div>
  );
}

function TextButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-xs text-ink-2 underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
    >
      {children}
    </button>
  );
}

/** Called as `host().account.method(…)`, the shape `tests/ipc-callers.test.ts` recognises. */
function host(): VoidCodeHost {
  return window.host as VoidCodeHost;
}

// ── Sign in ──────────────────────────────────────────────────────────────────

function SignInForm({
  titleId,
  onViewChange,
  onSignedIn,
}: {
  titleId: string;
  onViewChange: (view: SignInView) => void;
  onSignedIn: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const invalid = validateEmail(email);
    setEmailError(invalid);
    if (invalid !== null || password === "") return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().account.signInPassword({ email: email.trim(), password });
      if (!result.ok) {
        // The server's one message for every credential failure, shown as-is — see the header.
        setError(result.message);
        return;
      }
      onSignedIn(result.user.email);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Header
        titleId={titleId}
        title="Sign in to VoidCode"
        subtitle="Optional. The editor, grader and local models work without an account."
      />
      {error !== null && <FormError>{error}</FormError>}
      <div className="flex flex-col gap-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
          disabled={busy}
        />
        <PasswordField
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="mt-6 flex items-center justify-between">
        <Pill type="submit" variant="solid" disabled={busy || password === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </Pill>
        <TextButton onClick={() => onViewChange("forgot")}>Forgot password?</TextButton>
      </div>
      <p className="mt-6 text-xs text-ink-3">
        New here? <TextButton onClick={() => onViewChange("register")}>Create an account</TextButton>
      </p>
    </form>
  );
}

// ── Create an account ────────────────────────────────────────────────────────

function RegisterForm({
  titleId,
  onViewChange,
  onSignedIn,
  onOpenLegal,
}: {
  titleId: string;
  onViewChange: (view: SignInView) => void;
  onSignedIn: (email: string) => void;
  onOpenLegal: (document: "terms" | "privacy") => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const errors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validatePassword(password, { email, name }),
      terms: accepted ? null : "You need to accept the Terms of Use and Privacy Policy.",
    };
    setFieldErrors(errors);
    if (Object.values(errors).some((e) => e !== null)) return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().account.register({
        name: name.trim(),
        email: email.trim(),
        password,
        acceptTerms: true,
      });
      if (!result.ok) {
        if (result.field !== undefined) setFieldErrors({ [result.field]: result.message });
        else setError(result.message);
        return;
      }
      onSignedIn(result.user.email);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Header
        titleId={titleId}
        title="Create a VoidCode account"
        subtitle="For the VoidCode model and credits. Everything else works without one."
      />
      {error !== null && <FormError>{error}</FormError>}
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name ?? null}
          disabled={busy}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email ?? null}
          disabled={busy}
        />
        <div>
          <PasswordField
            label="Password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password ?? null}
            hint="At least 12 characters. A few unrelated words works well."
            disabled={busy}
          />
          <StrengthMeter password={password} />
        </div>
        <Checkbox
          checked={accepted}
          onChange={setAccepted}
          error={fieldErrors.terms ?? null}
          disabled={busy}
          label={
            <>
              I agree to the <InlineLegalLink onClick={() => onOpenLegal("terms")}>Terms of Use</InlineLegalLink>{" "}
              and <InlineLegalLink onClick={() => onOpenLegal("privacy")}>Privacy Policy</InlineLegalLink>.
            </>
          }
        />
      </div>
      <div className="mt-6 flex items-center justify-between">
        <Pill type="submit" variant="solid" disabled={busy}>
          {busy ? "Creating your account…" : "Create account"}
        </Pill>
        <TextButton onClick={() => onViewChange("signIn")}>I have an account</TextButton>
      </div>
    </form>
  );
}

function InlineLegalLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // Inside the checkbox's <label>: without this the click would also toggle the box.
        event.preventDefault();
        onClick();
      }}
      className="text-ink underline underline-offset-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

// ── Forgot password ──────────────────────────────────────────────────────────

function ForgotForm({
  titleId,
  onViewChange,
  onSignedIn,
}: {
  titleId: string;
  onViewChange: (view: SignInView) => void;
  onSignedIn: (email: string) => void;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    const invalid = validateEmail(email);
    setFieldErrors({ email: invalid });
    if (invalid !== null) return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().account.requestPasswordCode({ email: email.trim() });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The server's own sentence, which is the same whether or not the address has an account.
      setNotice(result.message);
      setStep("code");
      setCooldown(RESEND_COOLDOWN_S);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    const errors = {
      code: /^\d{6}$/.test(code) ? null : "Enter the 6-digit code from the email.",
      new_password: validatePassword(password, { email }),
    };
    setFieldErrors(errors);
    if (Object.values(errors).some((e) => e !== null)) return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().account.resetPassword({ email: email.trim(), code, newPassword: password });
      if (!result.ok) {
        if (result.field !== undefined) setFieldErrors({ [result.field]: result.message });
        else setError(result.message);
        return;
      }
      onSignedIn(result.user.email);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form onSubmit={(e) => void sendCode(e)} noValidate>
        <Header
          titleId={titleId}
          title="Reset your password"
          subtitle="We'll email you a 6-digit code to enter here."
        />
        {error !== null && <FormError>{error}</FormError>}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email ?? null}
          disabled={busy}
        />
        <div className="mt-6 flex items-center justify-between">
          <Pill type="submit" variant="solid" disabled={busy}>
            {busy ? "Sending…" : "Send code"}
          </Pill>
          <TextButton onClick={() => onViewChange("signIn")}>Back to sign in</TextButton>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void confirm(e)} noValidate>
      <Header titleId={titleId} title="Enter your code" subtitle={notice ?? undefined} />
      {error !== null && <FormError>{error}</FormError>}
      <div className="flex flex-col gap-4">
        <Field
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          // Digits only, so a pasted "123 456" or "Code: 123456" still lands as six digits.
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          error={fieldErrors.code ?? null}
          disabled={busy}
          className="[&_input]:font-mono [&_input]:tracking-[0.5em]"
        />
        <div>
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.new_password ?? null}
            disabled={busy}
          />
          <StrengthMeter password={password} />
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <Pill type="submit" variant="solid" disabled={busy}>
          {busy ? "Saving…" : "Set password and sign in"}
        </Pill>
        <button
          type="button"
          disabled={busy || cooldown > 0}
          onClick={() => void sendCode()}
          className="text-xs text-ink-2 transition-colors hover:text-ink disabled:text-ink-3"
        >
          {cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
        </button>
      </div>
      <p className="mt-6 text-xs text-ink-3">
        Setting a password signs you out everywhere else. <TextButton onClick={() => onViewChange("signIn")}>Back to sign in</TextButton>
      </p>
    </form>
  );
}
