/**
 * The shape of a credit ledger row, and what a credit is.
 *
 * SHARED BECAUSE THREE PLACES HAD THEIR OWN COPY. `inference/hosted.ts` declared it to parse the
 * API's answer, `renderer/src/types/host.d.ts` declared it again to describe the same answer
 * crossing the bridge, and `lib/account/purchase-watch.ts` needed it a third time to decide whether
 * a payment had landed. Three declarations of one wire format is three places for a field rename to
 * be half-applied, and the compiler would have objected to none of it.
 *
 * `MICRO_PER_CREDIT` lives beside the type it converts. It is the same constant as
 * `apps/api/src/models/gpu_billing.py::MICRO_PER_CREDIT`, and `credits-history.test.ts` pins the two
 * together: a client that disagreed with the server about what a credit is would be wrong by a
 * factor of a million on every figure it displayed, with both test suites green.
 */

/** Micro-credits in one credit. Storage is micro; display is never. */
export const MICRO_PER_CREDIT = 1_000_000;

/** One movement of credit, as `GET /v1/credits/ledger` reports it. */
export interface LedgerEntry {
  /**
   * The ledger's own id.
   *
   * Ordering is by this and not by date, because two rows written in one transaction share a
   * `created_at` to the microsecond — which is why the primary key is a BigInteger identity rather
   * than a UUID. It is also how "an entry that appeared since I started waiting" is decided.
   */
  id: number;
  /** `grant`, `hold`, `release`, `charge`, `refund` or `adjust`. A Postgres enum, server-side. */
  type: string;
  /** Signed: grants positive, charges negative. Zero for a hold or a release. */
  amountMicro: number;
  balanceAfterMicro: number;
  reservationId: string | null;
  /** ISO 8601 with an offset. */
  createdAt: string;
}
