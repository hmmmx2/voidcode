"""Releasing holds whose request will never settle them.

WHAT STRANDS A HOLD

The settle runs in a background task after the permit is released. Anything that kills the process
between those two moments — a SIGKILL, a rollout, a pod eviction, an unreachable database — leaves a
reservation `held` and the learner's credit held with it, invisibly and forever. That is not an edge
case: it is what happens on every deploy that lands mid-request.

The sweep is the backstop, and it is deliberately the *only* backstop. The metering path is allowed
to fail as loudly as it likes precisely because this exists.

VOID, NOT CHARGE, AND THE ARGUMENT AGAINST

The case for charging the full hold is that otherwise anyone who can crash the API gets free GPU.
The case for voiding, which wins: the sweep firing at all means the measurement was lost, so any
amount charged is a guess, and charging a guessed amount is exactly what destroys trust in a billing
system. The abuse path also requires crashing the API, which is a much larger problem than the
credits involved.

So `voidcode_gpu_reservations_swept_total` is a page, not a revenue line. A non-zero value means
requests are dying between release and settle, and the answer is to find out why rather than to
collect for it.

MULTI-REPLICA SAFE BY CONSTRUCTION

The claim is one guarded UPDATE returning only the rows it actually claimed, so two replicas
sweeping the same row cannot both win — the same row-lock argument the reservation itself relies on.
No leader election, no advisory lock.
"""

import asyncio
import logging
import random
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import metrics
from ..database import AsyncSessionLocal
from ..models.gpu_billing import GpuLedger, GpuReservation, GpuWallet

logger = logging.getLogger(__name__)


async def sweep_stale_reservations(db: AsyncSession, *, max_age_seconds: int) -> int:
    """Void every hold older than `max_age_seconds`. Returns how many were released.

    `max_age_seconds` must be comfortably longer than any legitimate request, or this races the
    settle it exists to back up and voids requests that were merely slow.
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=max_age_seconds)

    # Claim first, in one statement. RETURNING gives back only the rows this call actually won, so a
    # second replica running concurrently gets the rows it won and never the same ones.
    claimed = await db.execute(
        update(GpuReservation)
        .where(
            GpuReservation.state == "held",
            GpuReservation.created_at < cutoff,
        )
        .values(state="voided", settled_micro=0, settled_at=datetime.now(UTC))
        .returning(
            GpuReservation.id, GpuReservation.wallet_user_id, GpuReservation.hold_micro
        )
    )
    rows = claimed.all()
    if not rows:
        await db.rollback()
        return 0

    for reservation_id, user_id, hold_micro in rows:
        await db.execute(
            update(GpuWallet)
            .where(GpuWallet.user_id == user_id)
            .values(
                reserved_micro=GpuWallet.reserved_micro - hold_micro,
                updated_at=datetime.now(UTC),
            )
        )
        await db.flush()
        wallet = await db.get(GpuWallet, user_id)
        db.add(
            GpuLedger(
                wallet_user_id=user_id,
                entry_type="release",
                amount_micro=0,
                balance_after_micro=wallet.balance_micro,
                reservation_id=reservation_id,
                # Same derived key the ordinary void would have used, so a sweep and a late settle
                # racing on the same reservation cannot both write a ledger row.
                idempotency_key=f"release:{reservation_id}",
            )
        )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        logger.warning("gpu sweep lost a ledger race; the rows stay for the next pass")
        return 0

    logger.error(
        "gpu sweep released %d stranded hold(s) — requests are dying between release and settle",
        len(rows),
    )
    # The counter this module's own docstring calls "a page, not a revenue line". It named the
    # metric and the metric did not exist, so the alert it argues for could never have fired.
    for _ in rows:
        metrics.record_reservation_swept()

    return len(rows)


async def reconcile_wallets(db: AsyncSession) -> list[tuple]:
    """Compare every wallet against the sum of its ledger, and REPORT — never repair.

    A wallet that disagrees with its own history is a bug to find, not a number to overwrite.
    Repairing it would erase the only evidence of whatever caused the drift, and a billing system
    that silently corrects itself is one nobody can audit.

    Returns the disagreeing wallets so a caller can log or alarm on them.
    """
    ledger_sum = (
        select(
            GpuLedger.wallet_user_id.label("user_id"),
            func.sum(GpuLedger.amount_micro).label("total"),
        )
        .group_by(GpuLedger.wallet_user_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(GpuWallet.user_id, GpuWallet.balance_micro, ledger_sum.c.total)
            .join(ledger_sum, ledger_sum.c.user_id == GpuWallet.user_id)
            .where(GpuWallet.balance_micro != ledger_sum.c.total)
        )
    ).all()
    for user_id, balance, total in rows:
        logger.error(
            "gpu wallet disagrees with its ledger: user=%s balance=%s ledger_sum=%s",
            user_id, balance, total,
        )
    return list(rows)


async def sweep_loop(*, interval_seconds: int, max_age_seconds: int) -> None:
    """Run the sweep forever, jittered. Started from the lifespan.

    JITTERED because every replica starts at the same instant on a rollout, and a fleet that sweeps
    in lockstep turns a background job into a periodic thundering herd against one table.

    The first pass runs within the jitter window rather than instantly, and that ordering is the
    trade: a pod killed mid-request leaves holds behind and the replacement starting is the earliest
    anyone can clean them up, but every replica boots at once on a rollout. Up to thirty seconds of
    stranded credit is worth more than a synchronised fleet hitting one table.

    This loop holds one long-lived connection per replica. `test_deploy_manifests.py` pins the
    connection budget (pool 5 + overflow 10 per pod, four replicas, plus surge, against
    max_connections 100) and it is close to the ceiling — worth knowing before adding another
    background task that takes one.
    """
    await asyncio.sleep(random.uniform(0, min(30, interval_seconds)))
    while True:
        try:
            async with AsyncSessionLocal() as db:
                await sweep_stale_reservations(db, max_age_seconds=max_age_seconds)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Never let a bad pass kill the loop: the next one may well succeed, and a dead sweep
            # is silent while stranded holds accumulate.
            logger.exception("gpu sweep pass failed; continuing")
        await asyncio.sleep(interval_seconds + random.uniform(0, interval_seconds * 0.1))
