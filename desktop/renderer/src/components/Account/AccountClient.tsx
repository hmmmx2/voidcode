"use client";

/**
 * The optional VoidCode account: who is signed in, their password, and signing out.
 *
 * NOT THE LOCAL PROFILE. `/profile` edits a name and avatar stored in this computer's database and
 * sent nowhere. This page shows what our server holds for an account, fetched when you open it and
 * kept in memory by main. The two are deliberately unlinked, and the page says so, because the
 * natural assumption — that signing out wipes local work, or that the profile syncs — is false.
 *
 * SIGNED OUT IS A NORMAL STATE, NOT AN ERROR. The page explains what an account is for and offers
 * the sign-in dialog; it never redirects, and nothing else in the app requires visiting it.
 *
 * TWO PASSWORD FORMS, BECAUSE THERE ARE TWO SITUATIONS. With a password, changing it needs the
 * current one — a session is not proof of presence. Without one (an account made with Google or
 * Microsoft), the only safe way to add a password is to prove the mailbox, so it uses the same
 * emailed code as a forgotten password.
 */
import { useEffect, useId, useState } from "react";
import { EmptyState, Badge, Modal, Surface, useToast } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { Field, PasswordField } from "@/components/ui/Field";
import { FormError } from "@/components/Account/FormError";
import { StrengthMeter } from "@/components/Account/StrengthMeter";
import { useAccount } from "@/lib/account/AccountProvider";
import { validatePassword } from "@/lib/account/validation";
import {
  ProviderError,
  ProviderMonogram,
  ProviderWaiting,
  useProviderSignIn,
} from "@/components/Account/ProviderSignIn";

/** How long "Send a new code" stays disabled. Matches the sign-in dialog. */
const RESEND_COOLDOWN_S = 60;

/** Called as `host().account.method(…)`, the shape `tests/ipc-callers.test.ts` recognises. */
function host(): VoidCodeHost {
  return window.host as VoidCodeHost;
}

export default function AccountClient() {
  const { state, available, openSignIn, signOut, refresh } = useAccount();

  // Opening the page is a reason to check: the details shown should be the server's current ones.
  useEffect(() => {
    if (state?.signedIn) void refresh();
    // Once per visit, not on every state change — `refresh` itself changes the state.
  }, [state?.signedIn]);

  if (!available) {
    return (
      <PageFrame>
        <EmptyState
          title="Accounts are part of the desktop app"
          body="Open VoidCode on your computer to sign in."
        />
      </PageFrame>
    );
  }

  if (state === null) return <PageFrame />;

  if (!state.signedIn) {
    return (
      <PageFrame>
        <Surface bordered radius="card" className="py-14">
          <EmptyState
            title="You're not signed in"
            body="An account is optional. It's for the VoidCode model and credits; the editor, grader and local models work without one."
            action={
              <div className="flex items-center gap-2">
                <Pill variant="solid" size="sm" onClick={() => openSignIn("signIn")}>
                  Sign in
                </Pill>
                <Pill variant="ghost" size="sm" onClick={() => openSignIn("register")}>
                  Create an account
                </Pill>
              </div>
            }
          />
        </Surface>
      </PageFrame>
    );
  }

  const user = state.user;

  return (
    <PageFrame>
      {!state.durable && (
        <Notice>
          You&apos;ll need to sign in again next time you open VoidCode — this computer has no system
          keyring to keep your sign-in in.
        </Notice>
      )}
      {state.offline && (
        <Notice>
          Signed in, but VoidCode can&apos;t be reached right now, so these details may be out of date.{" "}
          <button type="button" onClick={() => void refresh()} className="text-ink underline underline-offset-2">
            Try again
          </button>
        </Notice>
      )}

      <Section title="Overview">
        {user === null ? (
          <p className="text-sm text-ink-3">{state.offline ? "Signed in (offline)." : "Loading your account…"}</p>
        ) : (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="text-ink-3">Name</dt>
            <dd className="text-ink">{user.name || "—"}</dd>
            <dt className="text-ink-3">Email</dt>
            <dd className="flex flex-wrap items-center gap-2 text-ink">
              <span className="break-all">{user.email}</span>
              <Badge tone={user.emailVerified ? "strong" : "quiet"}>
                {user.emailVerified ? "Verified" : "Not verified"}
              </Badge>
            </dd>
          </dl>
        )}
        <p className="mt-5 text-xs leading-relaxed text-ink-3">
          Your local profile, projects and history stay on this computer and are not linked to this
          account.
        </p>
      </Section>

      {user !== null && (
        <Section title="Sign-in methods">
          <SignInMethods user={user} />
        </Section>
      )}

      {user !== null && (
        <Section title={user.hasPassword ? "Change password" : "Set a password"}>
          {user.hasPassword ? <ChangePasswordForm email={user.email} name={user.name} /> : <SetPasswordForm email={user.email} />}
        </Section>
      )}

      <Section title="Sign out">
        <SignOutControls onSignOut={signOut} />
      </Section>
    </PageFrame>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

function PageFrame({ children }: { children?: React.ReactNode }) {
  return (
    <div className="page-content flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-ink">Account</h1>
        <p className="mt-1 text-sm text-ink-3">Your optional VoidCode account.</p>
      </div>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <Surface as="section" bordered radius="card" aria-labelledby={id} className="p-6">
      <h2 id={id} className="mb-4 text-sm font-medium uppercase tracking-wide text-ink-3">
        {title}
      </h2>
      {children}
    </Surface>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="rounded-xl border border-line-strong bg-void-2 px-4 py-3 text-sm text-ink-2">
      {children}
    </div>
  );
}

// ── Which ways this account can be signed in to ──────────────────────────────

/**
 * Password, Google and Microsoft, with what each one currently is.
 *
 * WHY THE THREE ARE LISTED TOGETHER. They are alternatives, and the thing a person comes here to
 * find out is how many they have — an account with one way in is an account they can be locked out
 * of. A bare row of badges said what was connected and gave no way to change it; the second column
 * is the point of the list.
 *
 * CONNECTING RUNS THE SAME FLOW AS SIGNING IN, in `mode: "link"`, so the provider is asked to
 * confirm the address rather than this application asserting it. That is what stops "connect
 * Google" from being a way to attach somebody else's address to your own account.
 *
 * A PROVIDER THIS BUILD HAS NO CLIENT ID FOR SAYS SO. Here, unlike the sign-in dialog, the row is
 * kept and labelled: the question being asked on this page is "can I connect Google?", and the
 * honest answer is "not in this build of VoidCode", not silence.
 */
function SignInMethods({ user }: { user: HostAccountUser }) {
  const flow = useProviderSignIn({});
  const connected = new Set(user.providers);

  if (flow.waiting !== null) return <ProviderWaiting flow={flow} />;

  return (
    <div className="flex flex-col gap-3">
      <ProviderError flow={flow} />
      <ul className="divide-y divide-line-strong rounded-xl border border-line-strong">
        <li className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="flex items-center gap-3 text-sm text-ink">
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line-strong bg-void-2 text-[11px] font-semibold text-ink-2"
            >
              P
            </span>
            Password
          </span>
          {/* No button: the form for both cases is the next section down, always visible. */}
          <Badge tone={user.hasPassword ? "strong" : "quiet"}>{user.hasPassword ? "Set" : "Not set"}</Badge>
        </li>
        {flow.offered !== null && flow.offered.length === 0 && connected.size === 0 && (
          <li className="px-4 py-3 text-xs leading-relaxed text-ink-3">
            Signing in with Google or Microsoft isn&apos;t set up in this build of VoidCode.
          </li>
        )}
        {(flow.offered ?? []).map((provider) => (
          <li key={provider.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-3 text-sm text-ink">
              <ProviderMonogram provider={provider} />
              {provider.label}
            </span>
            {connected.has(provider.id) ? (
              <Badge tone="strong">Connected</Badge>
            ) : (
              <Pill size="sm" onClick={() => void flow.start(provider, "link")}>
                Connect
              </Pill>
            )}
          </li>
        ))}
        {/*
          A provider already attached that this build can no longer offer — the client id was
          changed or removed since. It stays on the account and still works elsewhere, so the row
          has to appear, and there is nothing this build can do with it.
        */}
        {[...connected]
          .filter((id) => !(flow.offered ?? []).some((provider) => provider.id === id))
          .map((id) => (
            <li key={id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm text-ink">{id === "google" ? "Google" : id === "microsoft" ? "Microsoft" : id}</span>
              <Badge tone="strong">Connected</Badge>
            </li>
          ))}
      </ul>
      <p className="text-xs leading-relaxed text-ink-3">
        Connecting an account lets you sign in with it. VoidCode never sees the password, and asks
        only for your name and email address.
      </p>
    </div>
  );
}

// ── Change a known password ──────────────────────────────────────────────────

function ChangePasswordForm({ email, name }: { email: string; name: string }) {
  const notify = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const errors = {
      current_password: current === "" ? "Enter your current password." : null,
      new_password: validatePassword(next, { email, name }),
      confirm: next === confirm ? null : "The passwords don't match.",
    };
    setFieldErrors(errors);
    if (Object.values(errors).some((e) => e !== null)) return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().account.changePassword({ currentPassword: current, newPassword: next });
      if (!result.ok) {
        if (result.field !== undefined) setFieldErrors({ [result.field]: result.message });
        else setError(result.message);
        return;
      }
      notify("Password changed.", { detail: "Other devices were signed out." });
      setFieldErrors({});
    } finally {
      // Every outcome: a password in React state survives into devtools and heap snapshots.
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      {error !== null && <FormError>{error}</FormError>}
      <PasswordField
        label="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={fieldErrors.current_password ?? null}
        disabled={busy}
      />
      <div>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fieldErrors.new_password ?? null}
          hint="At least 12 characters."
          disabled={busy}
        />
        <StrengthMeter password={next} />
      </div>
      <PasswordField
        label="Confirm new password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={fieldErrors.confirm ?? null}
        disabled={busy}
      />
      <p className="text-xs text-ink-3">Changing your password signs out every other device.</p>
      <div>
        <Pill type="submit" variant="solid" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </Pill>
      </div>
    </form>
  );
}

// ── Set a first password, by emailed code ────────────────────────────────────

function SetPasswordForm({ email }: { email: string }) {
  const notify = useToast();
  const [step, setStep] = useState<"start" | "code">("start");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await host().account.requestPasswordCode({ email });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setStep("code");
      setCooldown(RESEND_COOLDOWN_S);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
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
      const result = await host().account.resetPassword({ email, code, newPassword: password });
      if (!result.ok) {
        if (result.field !== undefined) setFieldErrors({ [result.field]: result.message });
        else setError(result.message);
        return;
      }
      // The server issued a fresh session for this device; main has stored it and broadcast the
      // change, so the page re-renders with "Change password" in place of this form.
      notify("Password set.", { detail: "Other devices were signed out." });
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  if (step === "start") {
    return (
      <div className="flex flex-col gap-4">
        {error !== null && <FormError>{error}</FormError>}
        <p className="text-sm leading-relaxed text-ink-2">
          This account signs in with a provider and has no password. To add one, we&apos;ll email a
          6-digit code to <span className="text-ink">{email}</span> to confirm it&apos;s yours.
        </p>
        <div>
          <Pill variant="solid" size="sm" disabled={busy} onClick={() => void sendCode()}>
            {busy ? "Sending…" : "Email me a code"}
          </Pill>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      {error !== null && <FormError>{error}</FormError>}
      <p className="text-sm text-ink-2">
        We sent a code to <span className="text-ink">{email}</span>. It expires in 15 minutes.
      </p>
      <Field
        label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
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
          hint="At least 12 characters."
          disabled={busy}
        />
        <StrengthMeter password={password} />
      </div>
      <div className="flex items-center justify-between">
        <Pill type="submit" variant="solid" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
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
    </form>
  );
}

// ── Signing out ──────────────────────────────────────────────────────────────

function SignOutControls({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const notify = useToast();
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function everywhere() {
    setBusy(true);
    setError(null);
    try {
      const result = await host().account.signOutEverywhere();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(false);
      notify("Signed out of every device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">
        Signing out keeps everything on this computer. The VoidCode model stops being available until
        you sign in again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Pill size="sm" onClick={() => void onSignOut()}>
          Sign out
        </Pill>
        <Pill variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Sign out of all devices…
        </Pill>
      </div>

      <Modal
        open={confirming}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        labelledBy={titleId}
        className="w-[400px] max-w-[calc(100vw-2rem)]"
      >
        <h2 id={titleId} className="text-[15px] font-medium text-ink">
          Sign out of all devices?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Every computer signed in to this account is signed out, including this one. Nothing stored
          on any of them is deleted.
        </p>
        {error !== null && (
          <div className="mt-4">
            <FormError>{error}</FormError>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Pill variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Pill>
          <Pill variant="solid" size="sm" disabled={busy} onClick={() => void everywhere()}>
            {busy ? "Signing out…" : "Sign out everywhere"}
          </Pill>
        </div>
      </Modal>
    </div>
  );
}
