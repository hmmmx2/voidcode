"use client";

/**
 * Sign in to VoidCode, see what credit is left, and buy more.
 *
 * WHY THIS SITS BESIDE THE MODEL LIST RATHER THAN IN ITS OWN SETTINGS SCREEN
 *
 * Signing in is not an account chore here — it is what makes one more model available. A learner
 * arrives at this page to decide what will answer their questions, and the hosted model is one of
 * the options with a price attached. Putting it next to the OpenRouter key, which is the other
 * "connect something and get more models" control, means the page reads as one decision rather
 * than two unrelated ones.
 *
 * NOTHING HERE EVER HOLDS THE CREDENTIAL
 *
 * The password crosses one IPC call and is not kept. The session token lives in the OS keychain and
 * is only ever read in main. This component knows whether somebody is signed in and what their
 * balance is, which is everything it needs to render and nothing worth stealing.
 *
 * THE BUY BUTTON DOES NOT NAVIGATE
 *
 * It asks main to start a purchase, and main opens the browser after checking the URL it got back
 * is https. A renderer that could hand a URL to `shell.openExternal` could launch anything the
 * operating system has a handler for.
 */
import { useCallback, useEffect, useState } from "react";

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
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [voucher, setVoucher] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const host = () => window.host as NonNullable<Window["host"]>;

  const refresh = useCallback(async () => {
    const session = await host().voidcode.session();
    setSignedIn(session.signedIn);
    if (!session.signedIn) {
      setBalance(null);
      setPacks([]);
      return;
    }
    const [credits, packList] = await Promise.all([
      host().voidcode.credits(),
      host().voidcode.packs(),
    ]);
    setBalance(credits.ok ? credits.balance : null);
    if (!credits.ok) setError(credits.message);
    setPacks(packList.packs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await host().voidcode.signIn({ email, password });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Cleared immediately on success. It is not needed again and a password sitting in component
      // state survives into a React devtools inspection and a heap snapshot.
      setPassword("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

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

  if (signedIn === null) return null;

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

          <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-col gap-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded border border-line bg-transparent px-3 py-2 text-sm text-ink"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="rounded border border-line bg-transparent px-3 py-2 text-sm text-ink"
            />
            <button
              type="submit"
              disabled={busy}
              className="self-start rounded border border-line px-4 py-2 text-sm text-ink transition-colors hover:border-ink-3 disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded border border-line p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-2xl font-semibold text-ink">
              {balance ? balance.availableCredits.toLocaleString() : "—"}
              <span className="ml-2 text-sm font-normal text-ink-3">credits</span>
            </p>
            <button
              type="button"
              onClick={() => void host().voidcode.signOut().then(refresh)}
              className="text-xs text-ink-3 transition-colors hover:text-ink-2"
            >
              Sign out
            </button>
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
