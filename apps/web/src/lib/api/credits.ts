/**
 * Credit balance, packs, and starting a purchase.
 *
 * Everything here goes through `/api/proxy`, which reads the identity from the NextAuth session and
 * signs it server-side. Nothing in this file sends a user id: a browser that could name its own user
 * could buy credit into someone else's wallet, or read theirs.
 *
 * THERE IS NO `confirmPurchase`, AND THAT IS DELIBERATE.
 *
 * After paying, Stripe sends the buyer back to `/credits?purchase=success`. That parameter is a
 * string in a URL — it can be typed by hand, shared, or bookmarked, and it does NOT arrive when the
 * buyer closes the tab on the receipt page. Credit is granted by the server-side webhook and by
 * nothing else. The success page's only job is to say "we are waiting for the payment to confirm"
 * and re-read the balance, which is a fact rather than a claim.
 */

import { API_BASE, makeHeaders } from "./client";

export interface CreditPack {
    code: string;
    label: string;
    priceMinor: number;
    priceDisplay: string;
    currency: string;
    credits: number;
}

export interface CreditBalance {
    balanceMicro: number;
    reservedMicro: number;
    availableMicro: number;
    availableCredits: number;
    /**
     * Roughly how many minutes of answer generation the available credit buys, and the rate it was
     * derived from. Optional because an API deployed before these existed does not send them, and a
     * missing figure must render as nothing rather than as zero minutes.
     *
     * Computed server-side deliberately: the rate is a dated row resolved live, and a rate cached
     * in a client bundle would render a stale price as a promise.
     */
    estimatedMinutes?: number;
    rateMicroPerSlotSecond?: number;
}

export interface LedgerEntry {
    id: number;
    type: string;
    amountMicro: number;
    balanceAfterMicro: number;
    reservationId: string | null;
    createdAt: string;
}

/** Thrown with the server's own message so the UI can say what actually went wrong. */
export class CreditsError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "CreditsError";
    }
}

async function readError(response: Response, fallback: string): Promise<string> {
    try {
        const body = await response.json();
        // FastAPI puts a string in `detail` for simple raises and an object for structured ones.
        if (typeof body?.detail === "string") return body.detail;
        if (typeof body?.detail?.message === "string") return body.detail.message;
    } catch {
        // A non-JSON body (a proxy error page, say) is not worth surfacing verbatim.
    }
    return fallback;
}

export async function fetchBalance(): Promise<CreditBalance> {
    const response = await fetch(`${API_BASE}/v1/credits`, {
        headers: makeHeaders(),
        // Never cached: a balance shown from cache after a purchase is the exact moment a learner
        // decides the payment failed and buys again.
        cache: "no-store",
    });
    if (!response.ok) {
        throw new CreditsError(await readError(response, "Could not read your balance."), response.status);
    }
    return response.json();
}

export async function fetchPacks(): Promise<CreditPack[]> {
    const response = await fetch(`${API_BASE}/v1/credits/packs`, {
        headers: makeHeaders(),
        cache: "no-store",
    });
    if (!response.ok) {
        throw new CreditsError(await readError(response, "Could not load the credit packs."), response.status);
    }
    const body = await response.json();
    return body.packs ?? [];
}

export async function fetchLedger(limit = 20): Promise<LedgerEntry[]> {
    const response = await fetch(`${API_BASE}/v1/credits/ledger?limit=${limit}`, {
        headers: makeHeaders(),
        cache: "no-store",
    });
    if (!response.ok) {
        throw new CreditsError(await readError(response, "Could not load your history."), response.status);
    }
    const body = await response.json();
    return body.entries ?? [];
}

/**
 * Start a purchase and return where to send the buyer.
 *
 * Returns the URL rather than navigating, so the caller decides when to leave the page — a component
 * that redirected from inside a data function would strand any unsaved state on the way out.
 */
export async function startCheckout(packCode: string): Promise<string> {
    const response = await fetch(`${API_BASE}/v1/credits/checkout`, {
        method: "POST",
        headers: { ...makeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ pack_code: packCode }),
    });
    if (!response.ok) {
        throw new CreditsError(
            await readError(response, "Could not start the purchase."),
            response.status,
        );
    }
    const body = await response.json();
    if (typeof body?.redirectUrl !== "string") {
        throw new CreditsError("The payment provider did not return a checkout page.", 502);
    }
    return body.redirectUrl;
}

/**
 * Redeem a voucher code.
 *
 * THE SERVER'S REFUSAL MESSAGE IS SHOWN VERBATIM. It deliberately tells "already redeemed" apart
 * from "not valid" -- a second click is the commonest way to reach a refusal, and telling somebody
 * their working code is invalid sends them to support over something that worked. Rewording here
 * would either lose that distinction or invent one the server did not make.
 */
export async function redeemVoucher(code: string): Promise<number> {
    const response = await fetch(`${API_BASE}/v1/credits/vouchers/redeem`, {
        method: "POST",
        headers: { ...makeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
    });
    if (!response.ok) {
        throw new CreditsError(
            await readError(response, "That code could not be redeemed."),
            response.status,
        );
    }
    const body = await response.json();
    return typeof body?.credits === "number" ? body.credits : 0;
}
