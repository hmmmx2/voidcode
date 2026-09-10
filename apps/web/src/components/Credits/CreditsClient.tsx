"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
    CreditsError,
    fetchBalance,
    fetchLedger,
    fetchPacks,
    startCheckout,
    type CreditBalance,
    type CreditPack,
    type LedgerEntry,
} from "@/lib/api/credits";

/**
 * Buy credit, and see what it bought.
 *
 * WHAT THIS SCREEN REFUSES TO SAY
 *
 * It never claims a purchase succeeded. Coming back from the provider with `?purchase=success` means
 * the buyer reached the receipt page — nothing more. The credit is granted by a server-side webhook
 * that arrives on its own schedule, usually within seconds but not always, and it arrives whether or
 * not anyone returns to this page.
 *
 * So the success state says the payment is confirming and polls the balance. When the balance rises,
 * that is a fact read from the ledger rather than a claim inferred from a URL. A screen that showed
 * "Payment complete!" from the query string would be lying in exactly the cases that matter: a card
 * that failed after redirect, and a webhook that has not landed yet.
 *
 * WHY THE UNIT IS EXPLAINED RATHER THAN HIDDEN
 *
 * Credit is spent per second of model time, not per message. That is unfamiliar, and hiding it
 * behind a fake "messages remaining" count would be a lie the first time a long answer cost five
 * times a short one. The balance is shown in credits with a plain sentence about what moves it, and
 * the history shows what each request actually took.
 */
export default function CreditsClient() {
    const searchParams = useSearchParams();
    const returned = searchParams.get("purchase");

    const [packs, setPacks] = useState<CreditPack[]>([]);
    const [balance, setBalance] = useState<CreditBalance | null>(null);
    const [ledger, setLedger] = useState<LedgerEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [buying, setBuying] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [awaitingWebhook, setAwaitingWebhook] = useState(returned === "success");

    const load = useCallback(async () => {
        try {
            const [nextBalance, nextPacks, nextLedger] = await Promise.all([
                fetchBalance(),
                fetchPacks(),
                fetchLedger(10),
            ]);
            setBalance(nextBalance);
            setPacks(nextPacks);
            // Only movements that actually changed the balance.
            //
            // The ledger is double-entry: a `hold` moves credit from available to reserved and a
            // `release` moves it back, so both have an amount of zero. They are essential to an
            // audit and meaningless to a learner — showing them produced seven rows for three
            // actions, four of them reading "—". What someone wants to see is what they bought and
            // what each question cost.
            setLedger(nextLedger.filter((entry) => entry.amountMicro !== 0));
            setError(null);
            return nextBalance;
        } catch (err) {
            setError(err instanceof CreditsError ? err.message : "Something went wrong.");
            return null;
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * Poll only after returning from a purchase, and only for a bounded time.
     *
     * The webhook is usually quick, but "usually" is not "always" — a provider retry after a
     * timeout can take minutes. Polling forever would hammer the API for every abandoned tab, so
     * this gives up after two minutes and tells the buyer what to do instead, which is more honest
     * than a spinner that never resolves.
     */
    useEffect(() => {
        if (!awaitingWebhook) return;

        const startedAt = Date.now();
        const startingBalance = balance?.balanceMicro ?? null;

        const timer = setInterval(async () => {
            const next = await load();
            if (next && startingBalance !== null && next.balanceMicro > startingBalance) {
                setAwaitingWebhook(false);
            } else if (Date.now() - startedAt > 120_000) {
                setAwaitingWebhook(false);
            }
        }, 3000);

        return () => clearInterval(timer);
        // `balance` is deliberately not a dependency: including it would restart the interval on
        // every poll and reset the two-minute deadline forever.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [awaitingWebhook, load]);

    async function buy(packCode: string) {
        setBuying(packCode);
        setError(null);
        try {
            const url = await startCheckout(packCode);
            // A full navigation, not a router push: the destination is the provider's domain.
            window.location.href = url;
        } catch (err) {
            setError(
                err instanceof CreditsError ? err.message : "Could not start the purchase.",
            );
            setBuying(null);
        }
    }

    return (
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
            <h1 className="text-xl font-semibold text-ink">Credits</h1>
            <p className="mt-2 text-sm text-ink-3">
                Credit is spent by the second while the tutor is generating an answer, so a longer or
                more involved question costs more than a short one. It does not expire.
            </p>

            {returned === "cancelled" && (
                <p className="mt-6 rounded border border-line px-4 py-3 text-sm text-ink-2">
                    Payment cancelled. Nothing was charged.
                </p>
            )}

            {awaitingWebhook && (
                <p className="mt-6 rounded border border-line px-4 py-3 text-sm text-ink-2">
                    Confirming your payment. This usually takes a few seconds — your balance will
                    update here on its own.
                </p>
            )}

            {returned === "success" && !awaitingWebhook && (
                <p className="mt-6 rounded border border-line px-4 py-3 text-sm text-ink-2">
                    If your balance has not updated yet, the payment is still confirming. It will
                    appear here once it does; you do not need to pay again.
                </p>
            )}

            {error && (
                <p className="mt-6 rounded border border-line px-4 py-3 text-sm text-ink-2">
                    {error}
                </p>
            )}

            {/* ── Balance ─────────────────────────────────────────── */}
            <section className="mt-8">
                <h2 className="text-sm font-medium text-ink-2">Balance</h2>
                {loading ? (
                    <p className="mt-2 text-sm text-ink-3">Loading…</p>
                ) : balance ? (
                    <>
                        <p className="mt-2 text-3xl font-semibold text-ink">
                            {balance.availableCredits.toLocaleString()}
                            <span className="ml-2 text-base font-normal text-ink-3">
                                credits available
                            </span>
                        </p>
                        {typeof balance.estimatedMinutes === "number" && (
                            // "Answer generation", not "tutoring". Credit is spent while the model
                            // is writing, so a forty-minute study session might be three minutes of
                            // this. Calling it tutoring time would be the same lie as a
                            // "messages remaining" count, told in a different unit.
                            //
                            // Rendered only when the API sent it: an older deployment does not, and
                            // "0 minutes" next to a funded balance reads as a fault.
                            <p className="mt-1 text-sm text-ink-3">
                                about {formatGenerationTime(balance.estimatedMinutes)} of answer
                                generation, at today&apos;s rate
                            </p>
                        )}
                        {balance.reservedMicro > 0 && (
                            // Shown only when non-zero. A permanent "0 held" line would make an
                            // ordinary state look like something to worry about.
                            <p className="mt-1 text-xs text-ink-3">
                                {Math.floor(balance.reservedMicro / 1_000_000).toLocaleString()} held
                                by a question in progress, returned when it finishes.
                            </p>
                        )}
                    </>
                ) : null}
            </section>

            {/* ── Packs ───────────────────────────────────────────── */}
            <section className="mt-10">
                <h2 className="text-sm font-medium text-ink-2">Top up</h2>
                {packs.length === 0 && !loading ? (
                    <p className="mt-2 text-sm text-ink-3">
                        Purchases are not available yet.
                    </p>
                ) : (
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        {packs.map((pack) => (
                            <button
                                key={pack.code}
                                type="button"
                                disabled={buying !== null}
                                onClick={() => void buy(pack.code)}
                                className="flex flex-col items-start rounded border border-line px-4 py-4 text-left transition-colors hover:border-ink-3 disabled:opacity-50"
                            >
                                <span className="text-sm text-ink-3">{pack.label}</span>
                                <span className="mt-1 text-lg font-semibold text-ink">
                                    {pack.credits.toLocaleString()} credits
                                </span>
                                <span className="mt-2 text-sm text-ink-2">
                                    {buying === pack.code ? "Opening checkout…" : pack.priceDisplay}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </section>

            {/* ── History ─────────────────────────────────────────── */}
            {ledger.length > 0 && (
                <section className="mt-10">
                    <h2 className="text-sm font-medium text-ink-2">Recent activity</h2>
                    <ul className="mt-3 divide-y divide-line border-y border-line">
                        {ledger.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-baseline justify-between py-2 text-sm"
                            >
                                <span className="text-ink-2">{describe(entry.type)}</span>
                                <span className="tabular-nums text-ink-3">
                                    {formatDelta(entry.amountMicro)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}


/**
 * Minutes, in whatever unit a person would actually say.
 *
 * The API returns minutes because minutes are the honest integer to derive from a per-second rate.
 * Printing them raw is not: a starter pack works out at about 3,300 of them, and "3,338 minutes"
 * reads as a number rather than as an amount of time. The arithmetic stays on the server; only the
 * wording is decided here.
 */
function formatGenerationTime(minutes: number): string {
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    // Past a couple of days of generation the exact figure has stopped being decision-relevant, and
    // precision there would imply a confidence the underlying rate does not have -- it divides by a
    // concurrency that has never been measured on this hardware.
    if (hours < 48) return `${hours} hours`;
    return `${Math.floor(hours / 24)} days`;
}

/** Ledger types are internal words; these are what a learner is owed instead. */
function describe(type: string): string {
    switch (type) {
        case "grant":
            return "Credit added";
        case "charge":
            return "Question answered";
        case "refund":
            return "Refunded";
        // `hold` and `release` are not listed: both carry an amount of zero and are filtered out
        // before they reach here. A learner whose question failed simply sees no charge, which is
        // the truthful presentation — nothing was taken.
        default:
            return "Adjustment";
    }
}

function formatDelta(amountMicro: number): string {
    if (amountMicro === 0) return "—";
    const credits = amountMicro / 1_000_000;
    const sign = credits > 0 ? "+" : "";
    // Two decimals: a single question can cost a fraction of a credit, and rounding it to zero
    // would make the history look like nothing happened.
    return `${sign}${credits.toFixed(2)}`;
}
