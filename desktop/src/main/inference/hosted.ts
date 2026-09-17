/**
 * Credits: the balance, the packs for sale, starting a purchase, and redeeming a voucher.
 *
 * Signing in used to live here too. It moved to `account/` when accounts grew registration, password
 * reset and a real session check, and the transport moved to `platform/http.ts` so every caller gets
 * the same two guarantees: no request without a session, and a 401 ends the session it was sent with.
 *
 * EVERY FUNCTION HERE TOLERATES THE API BEING ABSENT
 *
 * The desktop app is local-first and must keep working with no network and no account, so these
 * return a shaped failure rather than throwing into a renderer that has no way to recover.
 */
import { apiCall } from "../platform/http.js";

export interface CreditBalance {
  availableCredits: number;
  reservedMicro: number;
  estimatedMinutes?: number;
  rateMicroPerSlotSecond?: number;
}

export async function credits(): Promise<
  { ok: true; balance: CreditBalance } | { ok: false; message: string }
> {
  try {
    const { status, body } = await apiCall("/credits", { auth: true });
    if (status === 401) return { ok: false, message: "Sign in to see your balance." };
    if (status !== 200) return { ok: false, message: "Could not read your balance." };
    return { ok: true, balance: body as CreditBalance };
  } catch {
    return { ok: false, message: "Could not reach VoidCode." };
  }
}

export interface CreditPack {
  code: string;
  label: string;
  priceDisplay: string;
  credits: number;
}

export async function packs(): Promise<CreditPack[]> {
  try {
    const { status, body } = await apiCall("/credits/packs", { auth: true });
    if (status !== 200) return [];
    return ((body as { packs?: CreditPack[] } | null)?.packs ?? []);
  } catch {
    return [];
  }
}

/**
 * Start a purchase and return where to send the buyer.
 *
 * Returns a URL rather than opening it. Opening a browser is a main-process side effect with its
 * own consent question, and the caller — `index.ts` — is where every other external navigation in
 * this app is already funnelled and checked.
 */
export async function checkout(
  packCode: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const { status, body } = await apiCall("/credits/checkout", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ pack_code: packCode }),
    });
    if (status === 401) return { ok: false, message: "Sign in before buying credit." };
    if (status === 503) return { ok: false, message: "Purchases are not available yet." };
    const url = (body as { redirectUrl?: string } | null)?.redirectUrl;
    if (status !== 200 || typeof url !== "string") {
      return { ok: false, message: "Could not start the purchase." };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: "Could not reach VoidCode." };
  }
}


/**
 * Redeem a voucher code into the signed-in learner's wallet.
 *
 * THE API'S REFUSAL MESSAGE IS PASSED THROUGH VERBATIM, and that is deliberate. It distinguishes
 * "already redeemed" from "not valid" on purpose — a second click is the commonest way to reach a
 * refusal, and telling somebody their working code is invalid sends them to support over something
 * that worked. Rewording it here would either lose that distinction or invent one the server did
 * not make.
 */
export async function redeemVoucher(
  code: string,
): Promise<{ ok: true; credits: number } | { ok: false; message: string }> {
  try {
    const { status, body } = await apiCall("/credits/vouchers/redeem", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ code }),
    });
    if (status === 401) return { ok: false, message: "Sign in before redeeming a voucher." };
    if (status === 429) {
      // The endpoint is rate limited far harder than anything else, because a voucher code is a
      // guessable-shaped secret and every outstanding one shares this door.
      return { ok: false, message: "Too many attempts. Please wait a while and try again." };
    }
    if (status !== 200) {
      const detail = (body as { detail?: unknown } | null)?.detail;
      return {
        ok: false,
        message: typeof detail === "string" ? detail : "That code could not be redeemed.",
      };
    }
    return { ok: true, credits: (body as { credits?: number }).credits ?? 0 };
  } catch {
    return { ok: false, message: "Could not reach VoidCode." };
  }
}
