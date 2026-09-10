"""Claiming, renewing and releasing a fleet-wide serving slot, and waiting in line for one.

READ `models/gpu_queue.py` FIRST -- it carries the design and the reasons. This file is the four
statements that implement it, and the property each one has to keep.

EVERY MUTATION HERE IS A GUARDED SINGLE STATEMENT, decided by `rowcount` or by what `RETURNING`
gives back. That is the same rule `gpu_wallet_service` states for money, applied here for a
different reason: two replicas claiming the same slot would put two requests on capacity sized for
one, and the symptom is a backend that OOMs under a load its own metrics say it can carry.

NOTHING IN THIS MODULE HOLDS A SESSION ACROSS AN `await asyncio.sleep`. There are roughly fourteen
spare database connections fleet-wide (`deploy/base/api-hpa.yaml` derives the figure). A waiter that
kept a connection open for a two-minute wait would exhaust them at twenty concurrent waiters, and
the outage would look like the database rather than like the queue. `wait_for_slot` therefore takes
a sessionmaker, not a session, and opens one per tick.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..models.gpu_queue import (
    STATE_ABANDONED,
    STATE_ADMITTED,
    STATE_WAITING,
    GpuQueueTicket,
    GpuSlot,
)

logger = logging.getLogger(__name__)

#: How long a claim survives without renewal. Short enough that a killed replica frees its slot
#: quickly, long enough that a renewal missing one tick does not lose it.
LEASE_SECONDS = 60

#: Renewals must be comfortably more frequent than the lease, or an ordinary scheduling delay costs
#: a holder its slot mid-generation. A third of the lease tolerates two consecutive misses.
RENEW_EVERY_SECONDS = 20

#: How often a waiter looks again. Also the heartbeat interval, and the cadence at which queue
#: position is reported to the caller.
POLL_SECONDS = 2.0


class QueueFull(Exception):
    """The queue is longer than it can serve within the wait ceiling. Callers map this to 429."""


class QueueTimeout(Exception):
    """Waited the full budget without being admitted."""


def _replica() -> str | None:
    return os.getenv("HOSTNAME")


# ── Slots ───────────────────────────────────────────────────────────────────────────────────


async def try_claim(db: AsyncSession, ticket_id: uuid.UUID) -> int | None:
    """Take a free or lapsed slot for `ticket_id`. Returns the slot id, or None if none was free.

    ONE STATEMENT. The subquery picks the lowest slot that is free or whose lease has passed,
    `FOR UPDATE SKIP LOCKED` so four replicas polling together each get a different row rather than
    queueing behind one another, and the outer UPDATE claims exactly that row.

    A lapsed lease is claimable regardless of `holder`. That is what makes a killed replica's slot
    recover itself with nothing sweeping the table -- see the model's docstring.
    """
    now = datetime.now(timezone.utc)
    claimed = await db.execute(
        text(
            """
            UPDATE gpu_slots SET holder = :ticket, leased_until = :until
            WHERE id = (
                SELECT id FROM gpu_slots
                WHERE holder IS NULL OR leased_until IS NULL OR leased_until < :now
                ORDER BY id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id
            """
        ),
        {
            "ticket": ticket_id,
            "until": now + timedelta(seconds=LEASE_SECONDS),
            "now": now,
        },
    )
    row = claimed.first()
    await db.commit()
    return int(row[0]) if row is not None else None


async def renew(db: AsyncSession, slot_id: int, ticket_id: uuid.UUID) -> bool:
    """Push the lease out. False means the slot is no longer ours.

    THE `holder = :ticket` PREDICATE IS THE WHOLE POINT. Without it, a holder whose lease had
    already lapsed -- and whose slot had already been claimed by somebody else -- would renew its
    way back on top of the new owner, putting two requests on one slot. That is the failure a
    renewal is most likely to cause, so the guard is in the WHERE clause rather than in a check.
    """
    result = await db.execute(
        update(GpuSlot)
        .where(GpuSlot.id == slot_id, GpuSlot.holder == ticket_id)
        .values(leased_until=datetime.now(timezone.utc) + timedelta(seconds=LEASE_SECONDS))
    )
    await db.commit()
    return (result.rowcount or 0) > 0


async def release(db: AsyncSession, slot_id: int, ticket_id: uuid.UUID) -> bool:
    """Give the slot back. False means it was not ours to give.

    Same guard, and the reason is the mirror image: a late release from a holder whose lease already
    lapsed must not free the slot out from under whoever legitimately holds it now. This is what
    "a slot released twice" means once slots are leased -- the second release belongs to a holder
    that no longer owns anything, and it must be a no-op rather than a free.
    """
    result = await db.execute(
        update(GpuSlot)
        .where(GpuSlot.id == slot_id, GpuSlot.holder == ticket_id)
        .values(holder=None, leased_until=None)
    )
    await db.commit()
    return (result.rowcount or 0) > 0


async def capacity(db: AsyncSession) -> int:
    return int((await db.execute(select(func.count()).select_from(GpuSlot))).scalar_one())


async def slots_in_use(db: AsyncSession) -> int:
    """Held AND not lapsed. A lapsed slot is free, whatever its `holder` column says."""
    now = datetime.now(timezone.utc)
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuSlot)
                .where(GpuSlot.holder.is_not(None), GpuSlot.leased_until > now)
            )
        ).scalar_one()
    )


# ── Tickets ─────────────────────────────────────────────────────────────────────────────────


async def enqueue(
    db: AsyncSession, user_id: uuid.UUID, request_id: str, *, max_depth: int
) -> GpuQueueTicket:
    """Join the queue, or raise `QueueFull`.

    Refusing at the door rather than admitting to an unservable queue: a caller told "you are 400th"
    has been given a worse answer than "try again shortly", and will wait for it.
    """
    depth = await waiting_count(db)
    if depth >= max_depth:
        raise QueueFull(f"{depth} requests are already waiting")

    ticket = GpuQueueTicket(
        user_id=user_id,
        request_id=request_id,
        state=STATE_WAITING,
        replica=_replica(),
        heartbeat_at=datetime.now(timezone.utc),
    )
    db.add(ticket)
    await db.commit()
    return ticket


async def waiting_count(db: AsyncSession) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuQueueTicket)
                .where(GpuQueueTicket.state == STATE_WAITING)
            )
        ).scalar_one()
    )


async def position(db: AsyncSession, ticket: GpuQueueTicket) -> int:
    """How many are ahead, plus one. First in line is 1.

    Ordered by `created_at` rather than by id: ids are random UUIDs and carry no order, which is the
    same reason `gpu_ledger` uses a BigInteger identity.
    """
    ahead = int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuQueueTicket)
                .where(
                    GpuQueueTicket.state == STATE_WAITING,
                    GpuQueueTicket.created_at < ticket.created_at,
                )
            )
        ).scalar_one()
    )
    return ahead + 1


async def _mark(db: AsyncSession, ticket_id: uuid.UUID, state: str) -> None:
    await db.execute(
        update(GpuQueueTicket)
        .where(GpuQueueTicket.id == ticket_id)
        .values(state=state, heartbeat_at=datetime.now(timezone.utc))
    )
    await db.commit()


async def abandon(db: AsyncSession, ticket_id: uuid.UUID) -> None:
    """The caller went away. Recorded rather than deleted, so queue depth over time stays readable."""
    await _mark(db, ticket_id, STATE_ABANDONED)


async def forget(db: AsyncSession, ticket_id: uuid.UUID) -> None:
    """Remove a finished ticket. Called after the slot is released."""
    await db.execute(delete(GpuQueueTicket).where(GpuQueueTicket.id == ticket_id))
    await db.commit()


# ── Waiting ─────────────────────────────────────────────────────────────────────────────────


async def wait_for_slot(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    request_id: str,
    *,
    max_wait_seconds: float,
    max_depth: int,
    on_position=None,
    is_disconnected=None,
) -> tuple[uuid.UUID, int]:
    """Queue for a slot. Returns `(ticket_id, slot_id)` once admitted.

    TAKES A SESSIONMAKER, NOT A SESSION, AND THAT IS THE LOAD-BEARING DETAIL. A session held across
    the sleeps below would hold a database connection for the whole wait. There are about fourteen
    spare fleet-wide, so twenty waiters would exhaust them and the incident would read as a database
    problem rather than as a queue that got popular. Each tick opens one, runs a statement, commits.

    `on_position` is awaited with the current position each tick, which is how a streaming caller is
    told where it is. `is_disconnected` is awaited each tick too: a caller who closed the tab must
    not be admitted, because admitting them spends a slot -- the scarcest thing here -- on nobody.
    """
    async with sessionmaker() as db:
        ticket = await enqueue(db, user_id, request_id, max_depth=max_depth)
        ticket_id, created_at = ticket.id, ticket.created_at

    deadline = asyncio.get_running_loop().time() + max_wait_seconds

    try:
        while True:
            if is_disconnected is not None and await is_disconnected():
                async with sessionmaker() as db:
                    await abandon(db, ticket_id)
                raise QueueTimeout("the caller disconnected while waiting")

            async with sessionmaker() as db:
                slot_id = await try_claim(db, ticket_id)
                if slot_id is not None:
                    await _mark(db, ticket_id, STATE_ADMITTED)
                    return ticket_id, slot_id

                # Same short-lived session: report where we are, then let the connection go.
                if on_position is not None:
                    ahead = int(
                        (
                            await db.execute(
                                select(func.count())
                                .select_from(GpuQueueTicket)
                                .where(
                                    GpuQueueTicket.state == STATE_WAITING,
                                    GpuQueueTicket.created_at < created_at,
                                )
                            )
                        ).scalar_one()
                    )
                    await on_position(ahead + 1)

                await db.execute(
                    update(GpuQueueTicket)
                    .where(GpuQueueTicket.id == ticket_id)
                    .values(heartbeat_at=datetime.now(timezone.utc))
                )
                await db.commit()

            if asyncio.get_running_loop().time() >= deadline:
                async with sessionmaker() as db:
                    await abandon(db, ticket_id)
                raise QueueTimeout(f"no slot became free within {max_wait_seconds:.0f}s")

            await asyncio.sleep(POLL_SECONDS)
    except asyncio.CancelledError:
        # A cancelled wait must not leave a ticket counted in everybody else's position.
        async with sessionmaker() as db:
            await abandon(db, ticket_id)
        raise


async def renew_forever(
    sessionmaker: async_sessionmaker[AsyncSession], slot_id: int, ticket_id: uuid.UUID
) -> None:
    """Hold the lease open until cancelled. Run as a task alongside the generation.

    ONLY THE RENEWAL GOES INTO A SEPARATE TASK, never the generation itself.
    `main.py`'s `_reasoning_visible_to_caller` is a ContextVar, and a ContextVar set in one task is
    not visible in another -- splitting the generation across tasks would silently change what the
    caller is shown. Renewal touches none of that.

    It stops renewing the moment the slot stops being ours, rather than retrying: if the lease
    lapsed and somebody else claimed the slot, the correct action is to stop, not to fight for it.
    """
    while True:
        await asyncio.sleep(RENEW_EVERY_SECONDS)
        async with sessionmaker() as db:
            if not await renew(db, slot_id, ticket_id):
                logger.warning(
                    "gpu slot %s is no longer held by ticket %s; stopping renewal",
                    slot_id, ticket_id,
                )
                return
