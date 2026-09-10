"""A serving-slot budget shared across replicas, and the queue waiting on it.

WHY AN IN-PROCESS SEMAPHORE WAS NOT ENOUGH, WHICH IS A BIGGER PROBLEM THAN THE 503 IT CAUSED

`MAX_CONCURRENT_REQUESTS` bounds concurrency **per process**. `deploy/base/api-hpa.yaml` runs two to
four replicas. So the fleet can push 32 to 64 concurrent requests at a backend sized for 16, while
every replica is correctly within its own limit and none can see the others. The semaphore is a
memory guard for one process; it was never a statement about the pod.

`gpu_slots` is the fleet-wide budget: a fixed number of rows, and holding one is what entitles a
request to occupy the backend. The in-process semaphore stays, because it still does its own job --
on the HuggingFace path `model.generate()` runs in a thread and more than two concurrent risks OOM
on this process's own GPU. Two guards, two different questions.

WHY SLOTS ARE ROWS AND NOT A COUNTER

A counter needs decrementing on release, and a replica killed mid-request never releases. Recovering
that means a sweeper, a heuristic about how long is too long, and a bug the first time the heuristic
is wrong. A row with a LEASE recovers itself: `leased_until` passes and the slot is claimable again,
with no process needing to have survived to say so. The renewal is the liveness signal, which is the
only honest one -- a holder that is still generating is a holder that can still renew.

WHY THE CLAIM IS `FOR UPDATE SKIP LOCKED`

Four replicas polling for a free slot must not serialise behind each other, and must not both take
the same row. `SKIP LOCKED` gives each poller the first row nobody else is currently claiming, which
is exactly the semantics wanted and is the one thing that makes this cheap enough to poll.

WHY THE QUEUE DOES NOT HOLD A DATABASE CONNECTION WHILE IT WAITS

`api-hpa.yaml` documents the budget: 100 max connections, 15 per pod, ~11 baseline, and a
rolling-update peak around 86. There are roughly 14 spare fleet-wide. A waiter that held a session
open for its whole wait would exhaust that at twenty concurrent waiters, and the failure would look
like a database outage rather than a queue that was too popular.

So a waiting request holds a ROW, not a connection. Each tick opens a session, runs one statement,
commits, and gives the connection back -- single-digit milliseconds. Twenty waiters at a two-second
tick is ten short acquisitions a second against a pool of fifteen, which the pool does not notice.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, SmallInteger, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

#: Ticket states. A string rather than a native enum, for the reason `auth_tokens.purpose` gives:
#: adding one later should be a code change, not a migration that locks the table.
STATE_WAITING = "waiting"
STATE_ADMITTED = "admitted"
STATE_ABANDONED = "abandoned"


class GpuSlot(Base):
    """One row per unit of the backend's serving capacity. Pre-seeded; never inserted at runtime.

    The row count IS the budget. Changing capacity is a migration that inserts or deletes rows,
    deliberately: a capacity change should be as visible and as reviewable as a schema change,
    rather than an environment variable somebody sets differently on one replica.
    """

    __tablename__ = "gpu_slots"

    #: Small and dense, so `ORDER BY id` in the claim is a cheap, stable preference for low slots.
    #: That keeps the occupied set compact rather than scattered, which makes "how many are in use"
    #: readable at a glance in the table itself.
    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)

    #: The ticket holding this slot, not the user: a user may legitimately hold two slots, and the
    #: renewal predicate needs to name the exact holder so a lapsed holder cannot steal it back.
    holder: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    #: When the claim expires unless renewed. Null means free. A row whose lease is in the past is
    #: claimable regardless of `holder` -- that is the self-healing property, and it is why nothing
    #: sweeps this table.
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # The claim's subquery scans for a free-or-lapsed slot in id order.
        Index("ix_gpu_slots_free", "leased_until"),
    )


class GpuQueueTicket(Base):
    """One row per request waiting for, or holding, a slot.

    Separate from `gpu_slots` because the two answer different questions and change at different
    rates. A slot is scarce, fixed and contended; a ticket is cheap, per-request and mostly
    uninteresting after the fact. Merging them would make position a scan over the scarce table.
    """

    __tablename__ = "gpu_queue_tickets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    #: The `chatcmpl-...` id, so a queued request can be tied to the reservation it later takes.
    #: Not unique: a retry after a disconnect legitimately reuses nothing, but a client may.
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)

    state: Mapped[str] = mapped_column(String(16), nullable=False, default=STATE_WAITING)

    #: Which replica is waiting on behalf of this ticket. Attribution only; nothing branches on it.
    replica: Mapped[str | None] = mapped_column(String(64), nullable=True)

    #: Set on every tick. A ticket whose heartbeat has stopped belongs to a caller that went away
    #: or a replica that died, and it should not be counted in anybody else's queue position.
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Position is `count(*) WHERE state = 'waiting' AND created_at < mine`, which is this index
        # exactly. Without it every tick of every waiter is a sequential scan.
        Index("ix_gpu_queue_waiting", "state", "created_at"),
    )


#: Purely so the sweep of abandoned tickets has a name to reference. Not a column: derived.
ABANDON_AFTER_MISSED_TICKS = 3


class GpuQueueCapacity:
    """Namespace for the seeded capacity, kept out of `config` deliberately.

    Capacity lives in the `gpu_slots` table rather than in an environment variable, because an
    environment variable can differ between replicas and a table cannot. This constant is only the
    number a migration seeds, and changing it alone changes nothing until a migration runs.
    """

    DEFAULT_SLOTS: int = 16
