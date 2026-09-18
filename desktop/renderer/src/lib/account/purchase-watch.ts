/**
 * Waiting for a payment to land, decided by a pure function.
 *
 * A purchase finishes in the buyer's browser and the credit arrives at our server by webhook from
 * the payment provider, which the application never sees. So after the browser opens there is
 * nothing to await: the only honest thing the page can do is watch its own balance and say it is
 * watching. This module is the decision — when to keep waiting, when the money has arrived, and
 * when to stop.
 *
 * WHY A MODULE AND NOT A `useEffect`. Two properties matter and neither is observable from a
 * component test:
 *
 *   1. THE DEADLINE IS SET ONCE. It is derived from `startedAt`, which nothing here writes, so
 *      there is no code path that can push it back. The equivalent effect in the deleted web client
 *      needed a comment and an eslint suppression to keep `balance` out of its dependency array,
 *      because including it would have restarted the interval on every poll and reset the deadline
 *      forever. A value that cannot be recomputed cannot be reset.
 *
 *   2. "THE MONEY ARRIVED" IS NOT "THE BALANCE WENT UP". The banner tells the buyer they can carry
 *      on using VoidCode, and carrying on SPENDS credit: a question taken while a purchase settles
 *      leaves a negative charge in the ledger, so a balance compared against its starting value can
 *      be flat or lower with the payment already credited. The primary signal is therefore a NEW
 *      POSITIVE LEDGER ENTRY, which is what crediting a payment actually writes, and the balance
 *      comparison is the fallback for when the history could not be read.
 *
 * Nothing here polls, waits or renders. `CreditsClient` owns the timer and the fetches.
 */
import type { LedgerEntry } from "@shared/credits";

/**
 * How often to ask, while waiting.
 *
 * Five seconds, and the page also checks whenever the window regains focus — which is the moment
 * that actually matters, because the buyer was in their browser and has just come back. The
 * interval is the fallback for someone watching this window while the payment settles.
 */
export const POLL_INTERVAL_MS = 5_000;

/**
 * How long to watch before saying so.
 *
 * Ten minutes. A webhook usually lands within seconds, but a provider retry after a timeout is
 * measured in minutes, and giving up at one would tell a buyer whose money was taken that nothing
 * happened. Bounded because an abandoned page must not poll forever: at this interval the ceiling
 * is 120 requests for a single indexed row, and stopping is a visible state with advice in it
 * rather than a spinner that never resolves.
 */
export const GIVE_UP_AFTER_MS = 10 * 60 * 1000;

/** Ledger entries that ADD credit. A `hold` is zero and a `charge` is negative. */
const CREDITING = new Set(["grant", "refund", "adjust"]);

export interface PurchaseWatch {
  /** When the wait began. The deadline is derived from this, and nothing rewrites it. */
  readonly startedAt: number;
  /**
   * The wallet total before the purchase, or null when it could not be read.
   *
   * NULL RATHER THAN NOUGHT, and the difference is a false "your payment arrived". An unreadable
   * baseline stored as zero makes the very next successful read — of an unchanged wallet with
   * credit already in it — look like an increase of the whole balance. Unknown has to stay
   * unknown: with no baseline the balance signal is simply unavailable, and this wait runs on the
   * ledger signal or not at all.
   */
  readonly baselineMicro: number | null;
  /**
   * The highest ledger id at the moment the wait began, or null when the history could not be read.
   *
   * Ids, not timestamps: the ledger is ordered by its own BigInteger identity precisely because two
   * rows written in one transaction share a `created_at` to the microsecond.
   */
  readonly latestEntryId: number | null;
}

export type WatchVerdict =
  | { status: "waiting"; secondsLeft: number }
  | { status: "arrived"; addedMicro: number }
  | { status: "gaveUp" };

export interface WalletSnapshot {
  /** Null when the balance could not be read this time round — offline, or a refused request. */
  balanceMicro: number | null;
  /** Whatever history came back with it. Empty is a legitimate answer, not a failure. */
  entries: readonly LedgerEntry[];
}

export function beginWatch(
  now: number,
  baseline: { balanceMicro: number | null; entries: readonly LedgerEntry[] },
): PurchaseWatch {
  return {
    startedAt: now,
    baselineMicro: baseline.balanceMicro,
    latestEntryId: highestId(baseline.entries),
  };
}

export function highestId(entries: readonly LedgerEntry[]): number | null {
  let highest: number | null = null;
  for (const entry of entries) {
    if (highest === null || entry.id > highest) highest = entry.id;
  }
  return highest;
}

/**
 * What to do, given the clock and the latest snapshot. Never mutates the watch.
 *
 * Arrival is checked BEFORE the deadline: a payment that lands at ten minutes and one second has
 * still landed, and reporting "gave up" over the top of it would be wrong about the one fact the
 * buyer cares about.
 */
export function readWatch(
  watch: PurchaseWatch,
  now: number,
  snapshot: WalletSnapshot,
): WatchVerdict {
  // The primary signal, and it needs a known starting id: without one, "new" is undecidable and
  // every entry already in the history would read as an arrival.
  if (watch.latestEntryId !== null) {
    const startedAbove = watch.latestEntryId;
    const credited = snapshot.entries.filter(
      (entry) => CREDITING.has(entry.type) && entry.amountMicro > 0 && entry.id > startedAbove,
    );
    if (credited.length > 0) {
      return {
        status: "arrived",
        addedMicro: credited.reduce((total, entry) => total + entry.amountMicro, 0),
      };
    }
  }

  // The fallback, for a wait that began without a readable history. Strictly greater: equal means
  // nothing has happened yet. Both sides must be known — see `baselineMicro`.
  const baseline = watch.baselineMicro;
  if (baseline !== null && snapshot.balanceMicro !== null && snapshot.balanceMicro > baseline) {
    return { status: "arrived", addedMicro: snapshot.balanceMicro - baseline };
  }

  const elapsed = now - watch.startedAt;
  if (elapsed >= GIVE_UP_AFTER_MS) return { status: "gaveUp" };
  return { status: "waiting", secondsLeft: Math.ceil((GIVE_UP_AFTER_MS - elapsed) / 1000) };
}
