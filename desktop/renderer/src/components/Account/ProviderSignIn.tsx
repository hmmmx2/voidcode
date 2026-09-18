"use client";

/**
 * "Continue with Google" / "Continue with Microsoft", and the wait that follows.
 *
 * THE WAIT IS THE DESIGN PROBLEM HERE. Pressing one of these buttons sends the person out of the
 * application into a browser, and what they come back to has to make sense whether that took four
 * seconds or four minutes — or never happened, because they closed the tab. So the form is replaced
 * by a panel that says where they are, offers the browser again, and counts down the same five
 * minutes main is actually waiting. A spinner with no way out would be the easy version of this and
 * the wrong one: the most common failure is a browser window that opened behind this one.
 *
 * THE BUTTONS ARE ABSENT, NOT DISABLED, when a build has no client id for a provider. A disabled
 * "Continue with Google" invites someone to work out what they have done wrong; there is nothing
 * they can do, because the answer is that this installer was not built with a Google registration.
 * `/account` says it in words instead, where the question "can I connect Google?" is being asked.
 *
 * NO PROVIDER LOGOS. Google's and Microsoft's marks are trademarks with brand rules, and neither is
 * bundled with this application — so the choice is between drawing them from memory and not drawing
 * them at all. A mis-drawn Google G is both a breach of those rules and visibly cheap, so each
 * provider gets a monogram in the application's own type instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { FormError } from "@/components/Account/FormError";

/** Called as `host().account.method(…)`, the shape `tests/ipc-callers.test.ts` recognises. */
function host(): VoidCodeHost {
  return window.host as VoidCodeHost;
}

export interface ProviderFlow {
  /** Null until main has answered. Only `configured` providers are ever offered. */
  offered: HostProviderStatus[] | null;
  /** The provider whose browser tab we are waiting on, or null. */
  waiting: HostProviderStatus | null;
  /** Seconds left before main stops waiting. */
  remaining: number;
  error: string | null;
  /** Set when the server's refusal is one an email-and-password account would solve. */
  suggestEmail: boolean;
  start(provider: HostProviderStatus, mode: "signIn" | "link"): Promise<void>;
  cancel(): void;
  reopen(): void;
}

/**
 * Drive one provider sign-in at a time.
 *
 * Unmounting cancels: closing the dialog mid-flow has to release the loopback port and the pending
 * IPC call, or the next attempt supersedes a listener nobody is watching. `onSignedIn` is not called
 * from the cleanup path, so a dialog that has gone away cannot navigate anything.
 */
export function useProviderSignIn(options: {
  onSignedIn?: (email: string) => void;
  onLinked?: (provider: HostProviderId) => void;
}): ProviderFlow {
  const notify = useToast();
  const [offered, setOffered] = useState<HostProviderStatus[] | null>(null);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [waiting, setWaiting] = useState<HostProviderStatus | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [suggestEmail, setSuggestEmail] = useState(false);
  const live = useRef(true);
  // Held in a ref as well as in state: the cleanup below must know whether to cancel, and it reads
  // whatever was current at unmount rather than what was current when the effect was created.
  const pending = useRef(false);

  useEffect(() => {
    live.current = true;
    /**
     * One path, including the web preview where there is no host at all.
     *
     * The absent-host case used to `setOffered([])` and return, which is a synchronous setState in
     * an effect body — a cascading render, and an eslint error. Answering it with a resolved promise
     * puts both cases on the same asynchronous path and reads better besides: "nothing is offered"
     * is an answer, not a special case.
     */
    const account = window.host?.account;
    const answer =
      account === undefined
        ? Promise.resolve({ providers: [] as HostProviderStatus[], timeoutSeconds })
        : account.providers();
    void answer.then((listed) => {
      if (!live.current) return;
      setOffered(listed.providers.filter((provider) => provider.configured));
      setTimeoutSeconds(listed.timeoutSeconds);
    });
    return () => {
      live.current = false;
      if (pending.current) void window.host?.account?.cancelOAuth();
    };
    // `timeoutSeconds` is only the seed for the no-host branch, which discards it; re-running this
    // when main's answer lands would ask for the provider list a second time on every mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One second per tick while a flow is open, for the counter in the waiting panel. Main enforces
  // the deadline; this only shows it, which is why running out here changes nothing on its own.
  useEffect(() => {
    if (waiting === null || remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [waiting, remaining]);

  const start = useCallback(
    async (provider: HostProviderStatus, mode: "signIn" | "link") => {
      setError(null);
      setSuggestEmail(false);
      setWaiting(provider);
      setRemaining(timeoutSeconds);
      pending.current = true;
      let result;
      try {
        result = await host().account.signInOAuth({ provider: provider.id, mode });
      } finally {
        pending.current = false;
        if (live.current) setWaiting(null);
      }
      if (!live.current) return;

      if (!result.ok) {
        // Cancelling is not a failure and does not deserve a red panel; the person pressed Cancel.
        if (result.code !== "cancelled") setError(result.message);
        // The server refuses to attach an address a provider would not vouch for, and its message
        // says to use a password instead — so offer that route rather than leaving a dead end.
        setSuggestEmail(result.code === "unverified_email");
        return;
      }

      if ("linked" in result) {
        notify(`${provider.label} connected.`);
        options.onLinked?.(result.provider);
        return;
      }

      if (result.passwordCleared === true) {
        // Rare and alarming if unexplained: a password that used to work no longer does.
        notify("The password on this account was removed.", {
          detail: `It had been set without ${provider.label} confirming the address. Set a new one from the Account page.`,
          tone: "warn",
        });
      }
      options.onSignedIn?.(result.user.email);
    },
    // `options` is a fresh object every render; the callbacks it carries are what matter and they
    // are read at call time, so depending on the object would rebuild this on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeoutSeconds, notify]
  );

  return {
    offered,
    waiting,
    remaining,
    error,
    suggestEmail,
    start,
    cancel: () => void host().account.cancelOAuth(),
    reopen: () => void host().account.reopenOAuth(),
  };
}

// ── The buttons ──────────────────────────────────────────────────────────────

export function ProviderButtons({
  flow,
  mode,
  disabled,
}: {
  flow: ProviderFlow;
  mode: "signIn" | "link";
  disabled?: boolean;
}) {
  const offered = flow.offered ?? [];
  if (offered.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {offered.map((provider) => (
        <Pill
          key={provider.id}
          variant="outline"
          disabled={disabled === true}
          onClick={() => void flow.start(provider, mode)}
          className="w-full justify-start gap-3 px-3 text-sm"
        >
          <ProviderMonogram provider={provider} />
          Continue with {provider.label}
        </Pill>
      ))}
    </div>
  );
}

/** A bordered tile with the provider's initial. See the header for why this is not a logo. */
export function ProviderMonogram({ provider }: { provider: HostProviderStatus }) {
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line-strong bg-void-2 text-[11px] font-semibold text-ink-2"
    >
      {provider.label.slice(0, 1)}
    </span>
  );
}

/** The `or` rule between the provider buttons and the email form. Absent when there is no `or`. */
export function ProviderDivider({ flow }: { flow: ProviderFlow }) {
  if ((flow.offered ?? []).length === 0) return null;
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden>
      {/* `line-strong`, not `line`: a 1px `--color-line` rule is the same value as the glass
          panel's own surface and photographed as nothing at all — the word "or" floating with no
          rule either side. The strength meter's inactive segments use the same weight. */}
      <span className="h-px flex-1 bg-line-strong" />
      <span className="text-[11px] uppercase tracking-wide text-ink-3">or</span>
      <span className="h-px flex-1 bg-line-strong" />
    </div>
  );
}

// ── The wait ─────────────────────────────────────────────────────────────────

function clock(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60))}:${String(safe % 60).padStart(2, "0")}`;
}

/**
 * Shown in place of the form while the browser has the person.
 *
 * `role="status"` so a screen reader announces the change of surface — the visual cue is the form
 * disappearing, which is no cue at all if you cannot see it.
 */
export function ProviderWaiting({
  flow,
  titleId,
}: {
  flow: ProviderFlow;
  titleId?: string;
}) {
  const provider = flow.waiting;
  if (provider === null) return null;

  return (
    <div role="status">
      <h2 id={titleId} className="text-[15px] font-medium text-ink">
        Continue in your browser
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        We opened {provider.label} in your default browser. Finish signing in there, then come back —
        this window will notice on its own.
      </p>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        VoidCode never sees your {provider.label} password. We ask {provider.label} for your name and
        email address, and nothing else.
      </p>
      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Pill size="sm" onClick={flow.reopen}>
            Open the browser again
          </Pill>
          <Pill variant="ghost" size="sm" onClick={flow.cancel}>
            Cancel
          </Pill>
        </div>
        <span className="font-mono text-xs text-ink-3" aria-label="time left">
          Waiting… {clock(flow.remaining)}
        </span>
      </div>
    </div>
  );
}

/** The provider error, plus the way out the server's own message points at. */
export function ProviderError({ flow, onUseEmail }: { flow: ProviderFlow; onUseEmail?: () => void }) {
  if (flow.error === null) return null;
  return (
    <FormError>
      {flow.error}
      {flow.suggestEmail && onUseEmail !== undefined && (
        <>
          {" "}
          <button
            type="button"
            onClick={onUseEmail}
            className="text-ink underline underline-offset-2"
          >
            Create an account with an email address
          </button>
          .
        </>
      )}
    </FormError>
  );
}
