"""Reserve, settle, void and grant — the money path for GPU-time metering.

Every mutation here is either a **guarded single-statement UPDATE** whose predicate lives in the
`WHERE` clause, or an INSERT protected by a uniqueness constraint. There is no read-check-write
anywhere in this module, because a read-check-write is a race under concurrency and this is the one
place in the codebase where losing that race means charging the wrong person.

FAIL CLOSED, UNLIKE THE RATE LIMITER

`ratelimit.py` fails **open** when Redis is unavailable — it logs, bumps a counter, and allows the
request, and its docstring argues that availability beats enforcement for a rate limiter. That trade
is correct there and wrong here: an unavailable meter must never mean free GPU. So a database
failure on the reserve path propagates and the request is refused. The asymmetry is deliberate; it
is pointed out here so it reads as a decision rather than an inconsistency.

Nothing in this module touches Redis, and nothing should. Billing state lives in Postgres, where a
guarded UPDATE is atomic and a constraint is a guarantee.
"""

import logging
import os
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet

logger = logging.getLogger(__name__)


def ceil_div(numerator: int, denominator: int) -> int:
    """Integer ceiling division. Never `math.ceil(a / b)`, which routes money through a float."""
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return -(-numerator // denominator)


class WalletError(Exception):
    """Base for refusals this module raises. Callers map these to status codes."""


class NoWallet(WalletError):
    """The caller has no wallet. Distinct from having one that is empty."""


class InsufficientCredit(WalletError):
    """Not enough available credit for the hold. Maps to HTTP 402.

    Carries both figures so the caller can say what is actually wrong rather than "payment
    required", which tells a learner nothing about how much they need.
    """

    def __init__(self, required_micro: int, available_micro: int):
        self.required_micro = required_micro
        self.available_micro = available_micro
        super().__init__(
            f"Insufficient credit: this request needs {required_micro} micro-credits "
            f"and {available_micro} are available."
        )



def cost_micro_for(
    slot_ms: int, *, pod_micro_per_hour: int | None, nominal_concurrency: int | None
) -> int | None:
    """What the occupancy cost the operator, before margin. None when the basis was not recorded.

    ROUNDED UP, LIKE THE CHARGE, AND FOR THE MIRROR-IMAGE REASON. The rule elsewhere on this path is
    never to round a cost down in our own favour. Here the cost is ours, so rounding it down would
    inflate the reported margin instead -- the same bias, pointing the other way. Up on both sides
    keeps the difference honest.

    Integer throughout: `slot_ms` cancels against the 1000 in the denominator without ever forming a
    float, which is the rule `models/gpu_billing.py` states for this whole path.
    """
    if not pod_micro_per_hour or not nominal_concurrency:
        return None
    return ceil_div(pod_micro_per_hour * slot_ms, 3600 * 1000 * nominal_concurrency)


async def reserve(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    hold_micro: int,
    request_id: str,
    kind: str,
    backend: str,
    rate_micro_per_slot_second: int,
    # The cost basis behind that rate. Optional so a caller that only cares about billing still
    # works, and because rows written before these columns existed legitimately have none -- but
    # `metering.begin()` passes all four, and a wiring test asserts it keeps doing so. Omitting
    # them costs nothing at settle except the ability to say what the request cost to serve.
    pod_micro_per_hour: int | None = None,
    nominal_concurrency: int | None = None,
    margin_bps: int | None = None,
    pricing_measured: bool | None = None,
) -> GpuReservation:
    """Take a hold, or raise. Commits before returning.

    THE COMMIT IS NOT OPTIONAL AND NOT AN OVERSIGHT. `database.get_db()` commits for you when the
    request handler exits cleanly — which for a chat request is *after* the GPU work has finished.
    Relying on it would make the hold visible only once the thing it was protecting had already
    happened, which is exactly the window a reservation exists to close. It also would not work at
    all: the settle runs later on a different session and connection, and cannot see an uncommitted
    row. `services/draft_service.py` sets the precedent for committing inside a service.

    The caller therefore owns a real, durable hold the moment this returns, and any failure before
    generation starts must `void()` it.
    """
    # The predicate is in the WHERE clause, so there is no SELECT-then-UPDATE window. Two concurrent
    # transactions against the same wallet serialise on the row lock; under READ COMMITTED the
    # second re-evaluates this predicate against the row the first committed, sees the incremented
    # `reserved_micro`, matches zero rows, and is refused. No advisory lock, no SERIALIZABLE retry
    # loop, no application-level check. Same shape as `token_service.revoke_all()`.
    result = await db.execute(
        update(GpuWallet)
        .where(
            GpuWallet.user_id == user_id,
            GpuWallet.balance_micro - GpuWallet.reserved_micro >= hold_micro,
        )
        .values(
            reserved_micro=GpuWallet.reserved_micro + hold_micro,
            updated_at=datetime.now(UTC),
        )
    )

    if (result.rowcount or 0) == 0:
        # Only on this cold path do we pay for a second query, and only to tell the two refusals
        # apart: "you have no wallet" and "you have one and it is short" need different answers.
        await db.rollback()
        wallet = await db.get(GpuWallet, user_id)
        if wallet is None:
            raise NoWallet(f"No GPU credit wallet exists for user {user_id}.")
        raise InsufficientCredit(
            required_micro=hold_micro,
            available_micro=wallet.balance_micro - wallet.reserved_micro,
        )

    reservation = GpuReservation(
        wallet_user_id=user_id,
        request_id=request_id,
        kind=kind,
        state="held",
        hold_micro=hold_micro,
        rate_micro_per_slot_second=rate_micro_per_slot_second,
        pod_micro_per_hour=pod_micro_per_hour,
        nominal_concurrency=nominal_concurrency,
        margin_bps=margin_bps,
        pricing_measured=pricing_measured,
        backend=backend,
        replica=os.getenv("HOSTNAME"),
    )
    db.add(reservation)
    await db.flush()

    wallet = await db.get(GpuWallet, user_id)
    db.add(
        GpuLedger(
            wallet_user_id=user_id,
            entry_type="hold",
            # A hold moves credit between buckets rather than out of the wallet, so the signed
            # amount is zero and the row exists to record that the hold happened at all.
            amount_micro=0,
            balance_after_micro=wallet.balance_micro,
            reservation_id=reservation.id,
            idempotency_key=f"hold:{reservation.id}",
        )
    )
    await db.commit()
    return reservation


async def _finish(
    db: AsyncSession,
    reservation_id: uuid.UUID,
    *,
    charge_micro: int,
    slot_ms: int | None,
    backend_ms: int | None,
    state: str,
    cost_micro: int | None = None,
) -> bool:
    """Settle or void, idempotently. Returns False when the reservation was already finished.

    TWO INDEPENDENT IDEMPOTENCY GUARDS, BOTH IN THE DATABASE. The `state == "held"` predicate on the
    claim below, and `uq_gpu_ledger_idempotency_key` on the ledger insert. Neither relies on the
    settle task running exactly once, which is the assumption that would be false the first time a
    pod is killed mid-request.
    """
    entry_type = "charge" if state == "settled" else "release"

    # 1. Claim the row. rowcount 0 means somebody already finished it — a retry, or the sweep.
    claimed = await db.execute(
        update(GpuReservation)
        .where(GpuReservation.id == reservation_id, GpuReservation.state == "held")
        .values(
            state=state,
            settled_micro=charge_micro,
            slot_ms=slot_ms,
            backend_ms=backend_ms,
            # Written with the claim rather than afterwards, so a row can never be `settled` with
            # revenue recorded and no cost beside it.
            cost_micro=cost_micro,
            settled_at=datetime.now(UTC),
        )
    )
    if (claimed.rowcount or 0) == 0:
        await db.rollback()
        return False

    reservation = await db.get(GpuReservation, reservation_id)

    # 2. Release the hold and take the charge in one touch of the wallet row.
    await db.execute(
        update(GpuWallet)
        .where(GpuWallet.user_id == reservation.wallet_user_id)
        .values(
            reserved_micro=GpuWallet.reserved_micro - reservation.hold_micro,
            balance_micro=GpuWallet.balance_micro - charge_micro,
            updated_at=datetime.now(UTC),
        )
    )
    await db.flush()

    wallet = await db.get(GpuWallet, reservation.wallet_user_id)
    db.add(
        GpuLedger(
            wallet_user_id=reservation.wallet_user_id,
            entry_type=entry_type,
            amount_micro=-charge_micro,
            balance_after_micro=wallet.balance_micro,
            reservation_id=reservation_id,
            idempotency_key=f"{entry_type}:{reservation_id}",
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        # The ledger's unique key caught a duplicate the claim somehow did not. Treat as done.
        await db.rollback()
        return False
    return True


async def settle(
    db: AsyncSession,
    reservation_id: uuid.UUID,
    *,
    slot_ms: int,
    backend_ms: int | None = None,
    floor_micro: int = 0,
) -> bool:
    """Charge for measured occupancy, floored and then clamped to the hold.

    THE FLOOR IS APPLIED HERE, NOT ONLY AT THE HOLD, and the difference is the whole point of having
    one. Every request carries fixed cost the occupancy clock does not see: scheduling, prompt
    processing, and a share of the hour the pod sits idle between questions. A forty-millisecond
    reply measured 240 micro-credits and would have been charged that -- a rounding error against a
    pod billed by the minute. A flood of trivial requests would then run the card at a loss while
    every settle was arithmetically correct.

    Applying it at the hold alone only refuses a learner who cannot afford the floor; it does not
    collect it.

    The clamp is not the guarantee — `ck_gpu_reservations_settled_le_hold` is. This is the belt to
    that constraint's braces, and it exists so the common case does not depend on an aborted
    transaction. Under-billing a pathological request is the correct failure direction: the
    alternative is charging more than the learner authorised before their request ran.
    """
    reservation = await db.get(GpuReservation, reservation_id)
    if reservation is None:
        return False

    charge = ceil_div(slot_ms * reservation.rate_micro_per_slot_second, 1000)
    # Floor first, clamp second. The other order could charge above an authorised hold whenever the
    # floor exceeded it -- which cannot happen while `hold_micro_for` applies the same floor, but
    # ordering the operations so it is impossible costs nothing and does not depend on that.
    charge = max(charge, floor_micro)
    if charge > reservation.hold_micro:
        logger.warning(
            "gpu settle clamped: reservation=%s slot_ms=%s uncapped=%s hold=%s",
            reservation_id, slot_ms, charge, reservation.hold_micro,
        )
        charge = reservation.hold_micro

    return await _finish(
        db, reservation_id,
        charge_micro=charge, slot_ms=slot_ms, backend_ms=backend_ms, state="settled",
        # From the basis snapshotted on THIS reservation, not from a fresh pricing lookup -- the
        # same reason the rate above comes off the row. A price that changed while the learner was
        # waiting must not reach either number.
        cost_micro=cost_micro_for(
            slot_ms,
            pod_micro_per_hour=reservation.pod_micro_per_hour,
            nominal_concurrency=reservation.nominal_concurrency,
        ),
    )


async def void(db: AsyncSession, reservation_id: uuid.UUID) -> bool:
    """Release a hold without charging — the request never reached the model."""
    return await _finish(
        db, reservation_id, charge_micro=0, slot_ms=None, backend_ms=None, state="voided",
    )


async def grant(
    db: AsyncSession, user_id: uuid.UUID, *, amount_micro: int, idempotency_key: str
) -> bool:
    """Add credit. Returns False when this key was already granted.

    Deliberately not reachable over HTTP. There is no admin dependency in this codebase — `users.role`
    exists and nothing reads it — so an endpoint here would mean inventing an authorization primitive
    on the money path as a side effect. Grants happen from a script until that primitive is designed
    on its own terms.

    IDEMPOTENCY IS GUARDED TWICE, AND ONLY ONE OF THE TWO SURVIVES A DELETED WALLET.

    `uq_gpu_ledger_idempotency_key` refuses a duplicate while the wallet exists. It is not enough on
    its own: `gpu_ledger.wallet_user_id` cascades from the wallet, which cascades from the user, so
    deleting either erased the proof — and a provider redelivering days later then credited the same
    payment again, because `grant()` recreates a missing wallet a few lines below. `gpu_grant_keys`
    has no foreign key and outlives all of that. See `models/gpu_billing.py::GpuGrantKey`.

    Both inserts commit together, so either constraint refusing rolls the whole grant back.
    """
    if amount_micro <= 0:
        raise ValueError("a grant must be positive")

    wallet = await db.get(GpuWallet, user_id)
    if wallet is None:
        wallet = GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0)
        db.add(wallet)
        await db.flush()

    await db.execute(
        update(GpuWallet)
        .where(GpuWallet.user_id == user_id)
        .values(
            balance_micro=GpuWallet.balance_micro + amount_micro,
            updated_at=datetime.now(UTC),
        )
    )
    await db.flush()
    refreshed = await db.get(GpuWallet, user_id)
    db.add(
        GpuLedger(
            wallet_user_id=user_id,
            entry_type="grant",
            amount_micro=amount_micro,
            balance_after_micro=refreshed.balance_micro,
            idempotency_key=idempotency_key,
        )
    )
    # The durable half of the guard. Same transaction, so a conflict on either row refuses the
    # whole grant; different lifetime, so this one is still there after a wallet is deleted.
    db.add(
        GpuGrantKey(
            idempotency_key=idempotency_key,
            user_id=user_id,
            amount_micro=amount_micro,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return False
    return True


async def available_micro(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Spendable credit: total minus held. Zero when there is no wallet."""
    row = (
        await db.execute(
            select(GpuWallet.balance_micro, GpuWallet.reserved_micro).where(
                GpuWallet.user_id == user_id
            )
        )
    ).first()
    return 0 if row is None else row.balance_micro - row.reserved_micro
