"use client";

/**
 * The VoidCode model's card: whether it can be used, and what credit is left.
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
 * BUYING AND HISTORY MOVED TO `/account/credits`
 *
 * This card carried the pack buttons, the voucher box and a purchase notice, which made it a second
 * and worse credits page: no history, no wait for the payment to clear, and a form squeezed beside a
 * model list. The question here is "can I use the VoidCode model?", which a figure and a link
 * answer. The question on that page is "what did I buy and what did it cost?", which needs a table.
 * Two surfaces, one each, instead of one surface doing both jobs badly.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui/Pill";
import { useAccount } from "@/lib/account/AccountProvider";

interface Balance {
  availableCredits: number;
  reservedMicro: number;
  estimatedMinutes?: number;
}

/** Minutes in whatever unit a person would say. Mirrors the web app's wording exactly. */
function formatGenerationTime(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export default function VoidCodeAccount() {
  const router = useRouter();
  const { state, available, openSignIn } = useAccount();
  const signedIn = state === null ? null : state.signedIn;
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);

  const host = () => window.host as NonNullable<Window["host"]>;

  // Signed out, nothing is fetched: the balance is an account call, and a signed-out launch makes
  // no request to our server at all.
  const refresh = useCallback(async () => {
    if (!signedIn) {
      setBalance(null);
      return;
    }
    const credits = await host().voidcode.credits();
    setBalance(credits.ok ? credits.balance : null);
    setError(credits.ok ? null : credits.message);
  }, [signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
            // a long study session might be three minutes of this. `CreditsClient` words it
            // identically, and for the same reason.
            <p className="mt-1 text-xs text-ink-3">
              about {formatGenerationTime(balance.estimatedMinutes)} of answer generation, at
              today&apos;s rate
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Pill
              variant="solid"
              size="sm"
              type="button"
              onClick={() => router.push("/account/credits")}
            >
              Buy credits
            </Pill>
            <Pill
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => router.push("/account/credits")}
            >
              History
            </Pill>
          </div>
        </div>
      )}

      {error !== null && <p className="text-xs text-ink-2">{error}</p>}
    </section>
  );
}
