"""Reading a credit balance and its history, and buying more.

THE ONLY WAY CREDIT ENTERS OVER HTTP IS A VERIFIED WEBHOOK

`/checkout` starts a purchase and grants nothing. `/webhook` is the sole route that adds credit, and
only for a body carrying a valid provider signature. There is deliberately no admin grant endpoint:
`users.role` exists and **nothing in `src/` reads it**, so an admin route would mean inventing an
authorization primitive as a side effect of a payments change, which is how authorization bugs ship.
Operator grants stay in a script until that primitive is designed on its own terms.

THE SUCCESS REDIRECT GRANTS NOTHING, AND THAT IS THE POINT

A buyer returning from the provider lands on a page that reads their balance like any other. It is a
URL their browser was sent to: it can be visited directly, replayed, or never visited at all because
they closed the tab. Crediting there would hand out free credit AND lose real payments. The webhook
is the only source of truth, and it arrives whether or not anyone comes back.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config, identity, ratelimit
from ..database import get_db
from ..models.gpu_billing import MICRO_PER_CREDIT, GpuLedger, GpuReservation, GpuWallet
from ..services import credit_packs, gpu_wallet_service, payments

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/credits", tags=["credits"])


@router.get("")
async def read_balance(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Balance, held and available, in micro-credits and whole credits.

    Returns zeroes rather than 404 for a user with no wallet. A learner who has never been granted
    credit has a balance — it is nought — and a 404 would make the client distinguish "no wallet"
    from "no credit", which is a difference they cannot act on.

    `available` is the number that matters and the only one worth showing prominently: it is what a
    request will be checked against. Displaying `balance` alone would promise credit that is already
    held by an in-flight request.
    """
    row = (
        await db.execute(
            select(GpuWallet.balance_micro, GpuWallet.reserved_micro).where(
                GpuWallet.user_id == user_id
            )
        )
    ).first()

    balance_micro = row.balance_micro if row else 0
    reserved_micro = row.reserved_micro if row else 0
    available_micro = balance_micro - reserved_micro

    return {
        "balanceMicro": balance_micro,
        "reservedMicro": reserved_micro,
        "availableMicro": available_micro,
        # Floored, never rounded: showing 1 credit when 0.99 is spendable invites a refusal the
        # learner was told would not happen.
        "availableCredits": available_micro // MICRO_PER_CREDIT,
    }


@router.get("/ledger")
async def read_ledger(
    limit: int = 50,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """The most recent movements, newest first.

    Ordered by the ledger's own id rather than a timestamp: two rows written in the same transaction
    share a `created_at` to the microsecond, and an audit that cannot put them in order is not an
    audit. That is why the primary key is a BigInteger identity rather than a UUID.
    """
    rows = (
        await db.execute(
            select(GpuLedger)
            .where(GpuLedger.wallet_user_id == user_id)
            .order_by(GpuLedger.id.desc())
            .limit(min(max(limit, 1), 200))
        )
    ).scalars().all()

    return {
        "entries": [
            {
                "id": entry.id,
                "type": entry.entry_type,
                "amountMicro": entry.amount_micro,
                "balanceAfterMicro": entry.balance_after_micro,
                "reservationId": str(entry.reservation_id) if entry.reservation_id else None,
                "createdAt": entry.created_at.isoformat(),
            }
            for entry in rows
        ]
    }


@router.get("/usage")
async def read_usage(
    limit: int = 50,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Settled requests with what they occupied and what they cost.

    `slotMs` is exposed deliberately. The unit is unfamiliar — learners expect to pay per message —
    so the interface has to be able to show *why* one question cost more than another, and the only
    honest answer is that it held the model for longer.
    """
    rows = (
        await db.execute(
            select(GpuReservation)
            .where(
                GpuReservation.wallet_user_id == user_id,
                GpuReservation.state == "settled",
            )
            .order_by(GpuReservation.created_at.desc())
            .limit(min(max(limit, 1), 200))
        )
    ).scalars().all()

    return {
        "requests": [
            {
                "id": str(r.id),
                "kind": r.kind,
                "backend": r.backend,
                "slotMs": r.slot_ms,
                "chargedMicro": r.settled_micro,
                "rateMicroPerSlotSecond": r.rate_micro_per_slot_second,
                "createdAt": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }


# ── Buying credit ────────────────────────────────────────────────────────────


class CheckoutRequest(BaseModel):
    pack_code: str

    model_config = {"extra": "forbid"}


@router.get("/packs")
async def list_packs():
    """What is on sale. Retired packs are excluded here but still honoured by the webhook."""
    return {
        "packs": [
            {
                "code": pack.code,
                "label": pack.label,
                "priceMinor": pack.price_minor,
                "priceDisplay": pack.price_display,
                "currency": pack.currency,
                "credits": pack.credits_micro // MICRO_PER_CREDIT,
            }
            for pack in credit_packs.packs_on_sale()
        ]
    }


@router.post("/checkout")
async def start_checkout(
    body: CheckoutRequest,
    http_request: Request,
    caller: identity.Caller = Depends(identity.resolve_caller),
):
    """Start a purchase. Grants nothing; returns where to send the buyer.

    Rate limited like the other write paths: creating checkout sessions is cheap for us and free for
    an abuser, and an unbounded loop of them fills the provider's dashboard with junk sessions.
    """
    await ratelimit.check_ip(ratelimit.CHAT, http_request)

    if not config.PAYMENTS_ENABLED:
        raise HTTPException(status_code=503, detail="Purchases are not available yet.")

    # Both checks, for the reason `_begin_metering` needs both: anonymous is `verified=True` because
    # there is no id to forge, so `verified` alone would let an unauthenticated visitor buy credit
    # into the shared anonymous wallet, where anybody could then spend it.
    if caller.is_anonymous:
        raise HTTPException(status_code=401, detail="Sign in before buying credit.")
    if not caller.verified:
        raise HTTPException(status_code=401, detail="This request could not be authenticated.")

    pack = credit_packs.pack_by_code(body.pack_code)
    if pack is None or not pack.on_sale:
        raise HTTPException(status_code=404, detail="No such credit pack.")

    try:
        session = await payments.create_checkout(
            pack=pack,
            user_id=caller.user_id,
            idempotency_key=f"checkout:{caller.user_id}:{pack.code}:{uuid.uuid4().hex[:8]}",
        )
    except payments.PaymentError as exc:
        logger.error("checkout could not be created for %s: %s", caller.user_id, exc)
        raise HTTPException(
            status_code=502, detail="The payment provider is unavailable. Please try again."
        ) from exc

    return {"redirectUrl": session.redirect_url, "reference": session.provider_reference}


@router.post("/webhook")
async def payment_webhook(
    request: Request,
    stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    db: AsyncSession = Depends(get_db),
):
    """The only route that adds credit. Session-less; the signature is the whole authentication.

    NOT RATE LIMITED, DELIBERATELY. `ratelimit.py` fails open when Redis is down, and worse, a 429
    here makes the provider retry with backoff and eventually give up -- turning a traffic spike
    into money taken with no credit granted. The signature already bounds who can reach the
    expensive path, and an unsigned body is rejected before any database work.

    RAW BODY. The signature covers the exact bytes sent, so this reads `await request.body()`
    rather than a parsed model. A Pydantic body would re-serialise and break the signature for
    correct requests, which is the worst way to find out.
    """
    payload = await request.body()

    try:
        event = payments.verify_and_parse(payload, stripe_signature)
    except payments.SignatureInvalid as exc:
        # 400, not 401: there are no credentials to retry with. A signature that does not match
        # means the body was not written by the provider.
        logger.warning("rejected a webhook: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid signature.") from exc
    except payments.PaymentError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if event is None:
        # Verified, but not a completed payment. 200 so the provider stops retrying it.
        return {"received": True, "credited": False}

    pack = credit_packs.pack_by_code(event.pack_code)
    if pack is None:
        # Money taken and nothing here can say how much credit it bought. Loud, and NOT a 4xx: a
        # retry costs nothing and buys time to restore the missing pack row.
        logger.error(
            "PAID BUT UNGRANTABLE: event=%s pack_code=%r is unknown. The buyer has been charged "
            "%s %s and has no credit. Restore the pack row and let the provider retry.",
            event.event_id, event.pack_code, event.amount_minor, event.currency,
        )
        raise HTTPException(status_code=500, detail="Unknown pack; retry.")

    # THE PACK DECIDES THE CREDIT, NOT THE MONEY. `event.amount_minor` is logged for reconciliation
    # and never divided by anything.
    granted = await gpu_wallet_service.grant(
        db,
        event.user_id,
        amount_micro=pack.credits_micro,
        # The provider's event id. Every provider redelivers on retry by design, so this is what
        # makes a second delivery a no-op rather than a second grant.
        idempotency_key=f"purchase:{event.event_id}",
    )

    logger.info(
        "purchase %s: user=%s pack=%s paid=%s %s credited=%s duplicate=%s",
        event.event_id, event.user_id, pack.code, event.amount_minor, event.currency,
        pack.credits_micro, not granted,
    )
    return {"received": True, "credited": granted}
