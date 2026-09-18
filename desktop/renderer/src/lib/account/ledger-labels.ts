/**
 * Turning a ledger row into something a person can read.
 *
 * The ledger is a double-entry audit trail and its vocabulary is the accounting one: `grant`,
 * `hold`, `release`, `charge`, `refund`, `adjust`. None of those is what somebody looking at their
 * own history would say, and two of them describe movements that do not change what they have.
 *
 * WHY THE WORDS ARE CHOSEN THIS WAY. "Used" rather than "Charged", because nobody thinks of asking
 * a question as being charged. "Added" rather than "Granted", because a grant is what we did and
 * adding is what happened to them. "Adjusted" is kept vague on purpose: it is what a human
 * correction writes, and inventing a friendlier word for it would be claiming to know which.
 *
 * WHY THE CONVERSION LIVES HERE. Micro-credits are the storage unit and never a display unit, and
 * the divisor is a constant shared with the API. `credits-history.test.ts` pins it to
 * `apps/api/src/models/gpu_billing.py`, because a client that disagreed with the server about what
 * a credit is would misreport every figure on the page by a factor of a million while every test
 * on either side stayed green.
 */

// Re-exported rather than redeclared: it belongs with the row type it converts, in
// `src/shared/credits.ts`, and every consumer of this module wants it in the same breath.
export { MICRO_PER_CREDIT } from "@shared/credits";
import { MICRO_PER_CREDIT } from "@shared/credits";

const LABELS: Record<string, string> = {
  grant: "Added",
  charge: "Used",
  refund: "Refunded",
  adjust: "Adjusted",
  hold: "Held",
  release: "Released",
};

/**
 * The word for an entry type.
 *
 * An unknown type comes back as itself rather than as "Other": the enum can gain a member on the
 * server before this ships, and showing the server's own word is more use to whoever then has to
 * work out what it was than a label that hides it.
 */
export function labelFor(type: string): string {
  return LABELS[type] ?? type;
}

/**
 * A movement is an entry that changed the balance.
 *
 * A `hold` moves credit from available to reserved and a `release` moves it back, so both carry an
 * amount of zero. They are essential to an audit and meaningless in a history: showing them
 * produced seven rows for three actions, four of them reading nothing. The deleted web client
 * filtered on the same rule for the same reason.
 */
export function isMovement(entry: { amountMicro: number }): boolean {
  return entry.amountMicro !== 0;
}

/**
 * A signed amount in credits, for a column of figures.
 *
 * Fractions are shown to two places and only when there are any, so a purchase reads `+1,200` and
 * a question reads `-0.02`. Rounding a real charge to zero would present spending as free, so a
 * non-zero amount smaller than the smallest shown fraction reads as `-0.01` rather than `-0.00`.
 */
export function formatCredits(amountMicro: number): string {
  const sign = amountMicro < 0 ? "-" : "+";
  const magnitude = Math.abs(amountMicro) / MICRO_PER_CREDIT;
  const shown = magnitude > 0 && magnitude < 0.01 ? 0.01 : magnitude;
  return `${sign}${shown.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/** A balance in credits, unsigned, for the "balance after" column. Same rounding rule. */
export function formatBalance(amountMicro: number): string {
  return (amountMicro / MICRO_PER_CREDIT).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * When it happened, in the reader's own locale and time zone.
 *
 * The API sends ISO 8601 with an offset. An unparseable value falls back to the raw string rather
 * than to "Invalid Date", which is the one thing a date column must never say.
 */
export function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
