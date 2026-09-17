"use client";

/**
 * The VoidCode model's card: what credit is left, and buying more.
 *
 * WHY THIS SITS BESIDE THE MODEL LIST RATHER THAN IN ITS OWN SETTINGS SCREEN
 *
 * Signing in is not an account chore here — it is what makes one more model available. A learner
 * arrives at this page to decide what will answer their questions, and the hosted model is one of
 * the options with a price attached. Putting it next to the OpenRouter key, which is the other
 * "connect something and get more models" control, means the page reads as one decision rather
 * than two unrelated ones.
 *
 * SIGNING IN HAPPENS IN THE ONE SIGN-IN DIALOG, NOT HERE
 *
 * This card had its own email-and-password form. It now opens the dialog `AccountProvider` owns, so
 * signing in means the same thing from here, the title bar and a failed chat — including creating
 * an account and recovering a password, which this form never offered. Whether someone is signed
 * in comes from that provider too, so signing out in another window updates this card.
 *
 * The session token lives in the OS keychain and is only ever read in main. This component knows
 * whether somebody is signed in and what their balance is, which is everything it needs to render
 * and nothing worth stealing.
 *
 * THE BUY BUTTON DOES NOT NAVIGATE
 *
 * It asks main to start a purchase, and main opens the browser after checking the URL it got back
 * is https. A renderer that could hand a URL to `shell.openExternal` could launch anything the
 * operating system has a handler for.
 */
import { useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { useAccount } from "@/lib/account/AccountProvider";

interface Balance {
  availableCredits: number;
  reservedMicro: number;
  estimatedMinutes?: number;
}

interface Pack {
  code: string;
  label: string;
  priceDisplay: string;
  credits: number;
}

/** Minutes in whatever unit a person would say. Mirrors the web app's wording exactly. */
function formatGenerationTime(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export default function VoidCodeAccount() {
  const { state, available, openSignIn } = useAccount();
  const signedIn = state === null ? null : state.signedIn;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [voucher, setVoucher] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const host = () => window.host as NonNullable<Window["host"]>;

  // Signed out, nothing is fetched: the balance and the pack list are both account calls, and a
  // signed-out launch makes no request to our server at all.
  const refresh = useCallback(async () => {
    if (!signedIn) {
      setBalance(null);
      setPacks([]);
      return;
    }
    const [credits, packList] = await Promise.all([
      host().voidcode.credits(),
      host().voidcode.packs(),
    ]);
    setBalance(credits.ok ? credits.balance : null);
    setError(credits.ok ? null : credits.message);
    setPacks(packList.packs);
  }, [signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    const code = voucher.trim();
    if (code === "") return;

    setRedeeming(true);
    setError(null);
    setNotice(null);
    try {
      const result = await host().voidcode.redeem({ code });
      if (!result.ok) {
        // The server's wording, not ours. It tells "already redeemed" apart from "not valid",
        // and a second click is the commonest way to get here.
        setError(result.message);
        return;
      }
      // Cleared only on success. A rejected code stays in the box so a typo can be corrected
      // rather than retyped off a piece of paper.
      setVoucher("");
      setNotice(`Added ${result.credits.toLocaleString()} credits.`);
      await refresh();
    } finally {
      setRedeeming(false);
    }
  }

  async function buy(packCode: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await host().voidcode.checkout({ packCode });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The purchase completes in a browser and the credit arrives by webhook, so there is nothing
      // to await here. Saying so is better than a spinner that resolves on nothing.
      setNotice(
        "Your browser is open to finish the payment. Credit appears here once it clears — "
          + "you can close that tab when you are done.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Outside the desktop app there is no account to show; before main answers there is nothing yet.
  if (!available || signedIn === null) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-ink-3">VoidCode</h2>

      {!signedIn ? (
        <div className="rounded border border-line p-4">
          <p className="text-sm text-ink-2">
            Sign in to use the VoidCode model — a far larger model than this machine can hold, run
            on our GPUs and charged by the second of answering time.
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Optional. Everything else on this page keeps working without an account, offline and
            free.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill variant="solid" size="sm" type="button" onClick={() => openSignIn("signIn")}>
              Sign in to use the VoidCode model
            </Pill>
            <Pill variant="ghost" size="sm" type="button" onClick={() => openSignIn("register")}>
              Create an account
            </Pill>
          </div>
        </div>
      ) : (
        <div className="rounded border border-line p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-2xl font-semibold text-ink">
              {balance ? balance.availableCredits.toLocaleString() : "—"}
              <span className="ml-2 text-sm font-normal text-ink-3">credits</span>
            </p>
            {state?.user && (
              // Who is paying, so a shared computer does not spend the wrong person's credit.
              // Signing out lives in the account menu and on the Account page.
              <p className="truncate text-xs text-ink-3">{state.user.email}</p>
            )}
          </div>

          {typeof balance?.estimatedMinutes === "number" && (
            // "Answer generation", not "tutoring": credit is spent while the model is writing, so
            // a long study session might be three minutes of this. The web app says it the same
            // way, and for the same reason.
            <p className="mt-1 text-xs text-ink-3">
              about {formatGenerationTime(balance.estimatedMinutes)} of answer generation, at
              today&apos;s rate
            </p>
          )}

          {packs.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {packs.map((pack) => (
                <button
                  key={pack.code}
                  type="button"
                  disabled={busy}
                  onClick={() => void buy(pack.code)}
                  className="rounded border border-line px-3 py-2 text-left text-sm transition-colors hover:border-ink-3 disabled:opacity-50"
                >
                  <span className="block text-ink">{pack.credits.toLocaleString()} credits</span>
                  <span className="block text-xs text-ink-3">{pack.priceDisplay}</span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={(e) => void redeem(e)} className="mt-4 flex items-center gap-2">
            <input
              type="text"
              value={voucher}
              onChange={(e) => setVoucher(e.target.value)}
              placeholder="Voucher code"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-line bg-transparent px-3 py-1.5 font-mono text-xs text-ink"
            />
            <button
              type="submit"
              disabled={redeeming || voucher.trim() === ""}
              className="rounded border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink-3 disabled:opacity-40"
            >
              {redeeming ? "Redeeming..." : "Redeem"}
            </button>
          </form>

          {notice !== null && <p className="mt-3 text-xs text-ink-2">{notice}</p>}
        </div>
      )}

      {error !== null && <p className="text-xs text-ink-2">{error}</p>}
    </section>
  );
}
