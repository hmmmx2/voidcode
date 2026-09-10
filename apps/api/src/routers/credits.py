"""Reading a credit balance and its history. Nothing here moves money.

WHY THERE IS NO TOP-UP OR GRANT ENDPOINT

Adding credit needs an authorization primitive this codebase does not have. `users.role` is an enum
of student/instructor/admin and **nothing in `src/` reads it** — there is no `require_admin`, and
`identity.current_user_id` never touches the database, so an admin check would be the first identity
dependency that does. Inventing that primitive as a side effect of a billing change is how
authorization bugs get shipped. Grants happen from a script until it is designed on its own terms.

So this router is read-only, and the write path has no HTTP surface at all.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..models.gpu_billing import MICRO_PER_CREDIT, GpuLedger, GpuReservation, GpuWallet

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
