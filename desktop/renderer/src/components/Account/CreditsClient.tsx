"use client";

/**
 * Credits: what is left, buying more, redeeming a voucher, and where it all went.
 *
 * WHY THIS IS A PAGE AND NOT THE MODELS CARD. It was the card, and the card was doing two jobs.
 * Beside the model list the question is "can I use the VoidCode model?", which a balance and a link
 * answer; here the question is "what have I spent and what did I buy?", which needs a table. The
 * card now shows the figure and points here, so neither surface is a worse version of the other.
 *
 * THE PURCHASE IS FINISHED SOMEWHERE ELSE. Payment happens on the provider's page in the buyer's
 * browser, and the credit reaches our server by webhook — which this application never sees. So
 * there is nothing to await after the browser opens: the page watches its own wallet and says that
 * it is watching. `lib/account/purchase-watch.ts` decides when that stops, and it is a pure module
 * precisely because the two things that matter about it — a deadline that cannot be pushed back,
 * and an arrival signal that survives the buyer spending credit while they wait — are invisible to
 * a component test.
 *
 * THE BUY BUTTON DOES NOT NAVIGATE. It asks main to start a purchase; main checks the URL our API
 * returned is https and opens the browser itself. A renderer that could hand a URL to
 * `shell.openExternal` could launch anything the operating system has a handler for.
 *
 * SIGNED OUT IS A NORMAL STATE. Nothing here is required to use the application, and the page says
 * what an account is for rather than redirecting.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { EmptyState, Surface, useToast } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { FormError } from "@/components/Account/FormError";
import { useAccount } from "@/lib/account/AccountProvider";
import {
  formatBalance,
  formatCredits,
  formatWhen,
  isMovement,
  labelFor,
} from "@/lib/account/ledger-labels";
import {
  POLL_INTERVAL_MS,
  beginWatch,
  readWatch,
  type PurchaseWatch,
} from "@/lib/account/purchase-watch";

/** How many movements to ask for, and what "show more" raises it to (the API clamps at 200). */
const PAGE_SIZES = [50, 200] as const;

/** Called as `host().voidcode.method(…)`, the shape `tests/ipc-callers.test.ts` recognises. */
function host(): VoidCodeHost {
  return window.host as VoidCodeHost;
}

interface Balance {
  availableCredits: number;
  reservedMicro: number;
  estimatedMinutes?: number;
  balanceMicro?: number;
}

interface Pack {
  code: string;
  label: string;
  priceDisplay: string;
  credits: number;
}

/** Minutes in whatever unit a person would say. The same wording as the Models card. */
function formatGenerationTime(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.floor(hours / 24))} days`;
}

export default function CreditsClient() {
  const { state, available, openSignIn } = useAccount();
  const notify = useToast();
  const signedIn = state === null ? null : state.signedIn;

  const [balance, setBalance] = useState<Balance | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [entries, setEntries] = useState<HostLedgerEntry[] | null>(null);
  const [limit, setLimit] = useState<number>(PAGE_SIZES[0]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [watch, setWatch] = useState<PurchaseWatch | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  /**
   * One fetch of everything, returning what it read.
   *
   * The watcher needs the snapshot it just caused rather than the state it will eventually see:
   * reading `balance` after `setBalance` would read the previous render's value.
   */
  const load = useCallback(
    async (
      rows: number,
    ): Promise<{ balanceMicro: number | null; entries: HostLedgerEntry[] }> => {
      setLoading(true);
      try {
        const [credits, packList, history] = await Promise.all([
          host().voidcode.credits(),
          host().voidcode.packs(),
          host().voidcode.ledger({ limit: rows }),
        ]);

        setBalance(credits.ok ? credits.balance : null);
        setPacks(packList.packs);
        setEntries(history.ok ? history.entries : null);
        // The balance is the one whose failure is worth showing: without it the page has no figure.
        // A pack list that could not be fetched simply offers nothing to buy.
        setError(credits.ok ? null : credits.message);

        return {
          balanceMicro: credits.ok ? (credits.balance.balanceMicro ?? null) : null,
          entries: history.ok ? history.entries : [],
        };
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (signedIn !== true) {
      setBalance(null);
      setPacks([]);
      setEntries(null);
      return;
    }
    void load(limit);
  }, [signedIn, limit, load]);

  /**
   * While a purchase is outstanding: poll, and check whenever the window comes back.
   *
   * `watch` is the only dependency that can restart this. The balance deliberately is not one —
   * that is what would restart the interval on every poll and push the deadline back forever.
   */
  useEffect(() => {
    if (watch === null) return;
    let stopped = false;

    const check = async (): Promise<void> => {
      const snapshot = await load(limit);
      if (stopped) return;
      const verdict = readWatch(watch, Date.now(), snapshot);
      if (verdict.status === "arrived") {
        setWatch(null);
        notify(`Added ${formatCredits(verdict.addedMicro).replace("+", "")} credits.`);
      } else if (verdict.status === "gaveUp") {
        setWatch(null);
        setGaveUp(true);
      }
    };

    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    // The buyer was just in their browser, so coming back to this window is the highest-signal
    // moment there is — better than waiting out the remainder of an interval.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // `limit` and `load` are stable for the life of a wait; `notify` is from a provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);

  async function buy(pack: Pack): Promise<void> {
    setBusy(pack.code);
    setError(null);
    setGaveUp(false);
    try {
      // The baseline is read FIRST, and from this fetch rather than from state: the wait compares
      // against the wallet as it was before the browser opened.
      const before = await load(limit);
      const result = await host().voidcode.checkout({ packCode: pack.code });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setWatch(beginWatch(Date.now(), before));
    } finally {
      setBusy(null);
    }
  }

  if (!available) {
    return (
      <PageFrame>
        <EmptyState
          title="Credits are part of the desktop app"
          body="Open VoidCode on your computer to see your balance."
        />
      </PageFrame>
    );
  }

  if (signedIn === null) return <PageFrame />;

  if (!signedIn) {
    return (
      <PageFrame>
        <Surface bordered radius="card" className="py-14">
          <EmptyState
            title="You're not signed in"
            body="Credits pay for the VoidCode model, which runs on our GPUs. The editor, grader and any model on this machine work without an account."
            action={
              <Pill variant="solid" size="sm" onClick={() => openSignIn("signIn")}>
                Sign in
              </Pill>
            }
          />
        </Surface>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      {error !== null && <FormError>{error}</FormError>}

      {watch !== null && (
        <WaitingBanner onStop={() => setWatch(null)} />
      )}

      {gaveUp && (
        <Notice>
          <strong className="text-ink-2">Still no payment after ten minutes.</strong> If you were
          charged, the credit will appear here on its own once the payment clears — reopening this
          page will show it. Nothing was lost.{" "}
          <button
            type="button"
            onClick={() => {
              setGaveUp(false);
              void load(limit);
            }}
            className="text-ink underline underline-offset-2"
          >
            Check again
          </button>
        </Notice>
      )}

      <BalanceCard balance={balance} />

      <Section title="Buy credits">
        {packs.length === 0 ? (
          <p className="text-sm text-ink-3">
            {loading ? "Loading…" : "Nothing is on sale right now."}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {packs.map((pack) => (
              <button
                key={pack.code}
                type="button"
                disabled={busy !== null}
                onClick={() => void buy(pack)}
                className="rounded-xl border border-line-strong px-4 py-3 text-left transition-colors hover:border-ink-3 disabled:opacity-40"
              >
                <span className="block text-sm text-ink">
                  {pack.credits.toLocaleString()} credits
                </span>
                <span className="block font-mono text-xs text-ink-3">{pack.priceDisplay}</span>
              </button>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Payment happens on Stripe&apos;s own page in your browser, so your card details go to
          Stripe and never to us. Credit appears here once the payment clears, usually within a
          minute.
        </p>
        <VoucherForm onRedeemed={() => void load(limit)} />
      </Section>

      <Section title="History">
        <HistoryTable
          entries={entries}
          loading={loading}
          limit={limit}
          onShowMore={() => setLimit(PAGE_SIZES[1])}
        />
      </Section>
    </PageFrame>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

function PageFrame({ children }: { children?: React.ReactNode }) {
  return (
    <div className="page-content flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-ink">Credits</h1>
        <p className="mt-1 text-sm text-ink-3">
          What pays for the VoidCode model, and what it has been spent on.
        </p>
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
    <div
      role="status"
      className="rounded-xl border border-line-strong bg-void-2 px-4 py-3 text-sm leading-relaxed text-ink-2"
    >
      {children}
    </div>
  );
}

// ── The figure ───────────────────────────────────────────────────────────────

function BalanceCard({ balance }: { balance: Balance | null }) {
  const held = balance === null ? 0 : balance.reservedMicro;
  return (
    <Surface bordered radius="card" className="p-6">
      <p className="text-sm font-medium uppercase tracking-wide text-ink-3">Available</p>
      <p className="mt-2 font-mono text-4xl font-semibold text-ink">
        {balance === null ? "—" : balance.availableCredits.toLocaleString()}
        <span className="ml-3 font-sans text-sm font-normal text-ink-3">credits</span>
      </p>

      {typeof balance?.estimatedMinutes === "number" && (
        // "Answer generation", not "study time": credit is spent while the model is writing, so an
        // hour of reading might be three minutes of this. It is a conversion of today's price, not
        // a prediction about anybody's session.
        <p className="mt-2 text-xs text-ink-3">
          about {formatGenerationTime(balance.estimatedMinutes)} of answer generation, at
          today&apos;s rate
        </p>
      )}

      {held > 0 && (
        // Shown only when it is not nought, because the concept needs a sentence to explain and
        // there is no reason to spend one on a number that is zero.
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          A further {formatBalance(held)} credits are held for questions being answered right now.
          Held credit returns to available when each answer finishes and the real cost is taken.
        </p>
      )}
    </Surface>
  );
}

function WaitingBanner({ onStop }: { onStop: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3"
    >
      <p className="text-sm leading-relaxed text-ink-2">
        <strong className="text-ink">Waiting for the payment to clear.</strong> Finish it in your
        browser; this page will notice on its own. You can keep using VoidCode meanwhile.
      </p>
      <Pill variant="ghost" size="sm" onClick={onStop}>
        Stop waiting
      </Pill>
    </div>
  );
}

// ── Vouchers ─────────────────────────────────────────────────────────────────

function VoucherForm({ onRedeemed }: { onRedeemed: () => void }) {
  const notify = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === "") return;

    setBusy(true);
    setError(null);
    try {
      const result = await host().voidcode.redeem({ code: trimmed });
      if (!result.ok) {
        // The server's wording, not ours. It tells "already redeemed" apart from "not valid", and
        // a second click is the commonest way to get here.
        setError(result.message);
        return;
      }
      // Cleared only on success: a rejected code stays in the box so a typo can be corrected
      // rather than retyped off a piece of paper.
      setCode("");
      notify(`Added ${result.credits.toLocaleString()} credits.`);
      onRedeemed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-5 border-t border-line-strong pt-5">
      <label htmlFor="voucher" className="block text-xs font-medium text-ink-2">
        Have a voucher code?
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="voucher"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Voucher code"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        />
        <Pill type="submit" size="sm" disabled={busy || code.trim() === ""}>
          {busy ? "Redeeming…" : "Redeem"}
        </Pill>
      </div>
      {error !== null && (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      )}
    </form>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

function HistoryTable({
  entries,
  loading,
  limit,
  onShowMore,
}: {
  entries: HostLedgerEntry[] | null;
  loading: boolean;
  limit: number;
  onShowMore: () => void;
}) {
  if (entries === null) {
    return (
      <p className="text-sm text-ink-3">
        {loading ? "Loading…" : "Your history could not be read. Check your connection."}
      </p>
    );
  }

  const movements = entries.filter(isMovement);
  /**
   * Fewer rows came back than were asked for, so this IS the whole history.
   *
   * Worth distinguishing, because the alternative phrasing is misleading in the commonest case: a
   * new account with four movements told "the 4 movements in your last 50 ledger entries" invites
   * the question of what the other 46 were. There were none.
   */
  const complete = entries.length < limit;

  if (movements.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        No activity yet. Buying a pack or redeeming a voucher will show up here, and so will each
        question the VoidCode model answers.
      </p>
    );
  }

  return (
    <>
      {/* Its own scroll container: four columns of figures do not reflow, and the page body must
          never scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs uppercase tracking-wide text-ink-3">
              <th scope="col" className="py-2 pr-4 font-medium">
                When
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                What
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Credits
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Balance after
              </th>
            </tr>
          </thead>
          <tbody>
            {movements.map((entry) => (
              <tr key={entry.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-4 whitespace-nowrap text-ink-3">
                  {formatWhen(entry.createdAt)}
                </td>
                <td className="py-2 pr-4 text-ink-2">{labelFor(entry.type)}</td>
                <td
                  className={`py-2 pr-4 text-right font-mono ${
                    entry.amountMicro > 0 ? "text-ink" : "text-ink-2"
                  }`}
                >
                  {formatCredits(entry.amountMicro)}
                </td>
                <td className="py-2 text-right font-mono text-ink-3">
                  {formatBalance(entry.balanceAfterMicro)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-ink-3">
          {/* The count is of MOVEMENTS, not of ledger rows, so the sentence has to say which.
              Holds and releases move credit between available and reserved without changing the
              balance; listing them produced several rows per answered question, most reading
              nothing. */}
          {complete
            ? `All ${movements.length === 1 ? "one movement" : `${String(movements.length)} movements`}.`
            : `The ${String(movements.length)} movements in your last ${limit.toLocaleString()} ledger entries.`}{" "}
          Holds and releases aren&apos;t shown: they move credit between available and held without
          changing your balance.
        </p>
        {!complete && limit < PAGE_SIZES[1] && (
          <Pill variant="ghost" size="sm" onClick={onShowMore}>
            Show more
          </Pill>
        )}
      </div>
    </>
  );
}
