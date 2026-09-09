"""Credit wallet, reservations and ledger for GPU-time metering.

WHY GPU TIME AND NOT TOKENS

A rented pod bills per minute, running or idle. Tokens are what the model produces; **occupancy is
what costs money**. Metering tokens would let a trickle of light usage keep a pod alive while almost
no credit is consumed, and the difference comes out of the operator's pocket. So credit is drawn
against the interval a request held a serving slot, and token counts are recorded for analytics
only.

WHAT "SLOT" MEANS, SINCE IT IS NOT CUDA TIME

Under `USE_SGLANG` or a remote vLLM the API process is not on the GPU host; there is no CUDA clock
reachable from here. What is measurable, and what these tables record, is **slot occupancy**: the
wall-clock interval during which a request held one permit of the inference semaphore, i.e. one unit
of the pod's committed serving capacity. That is the honest unit, and it is the right one — a slot
held is a slot nobody else can use, and the pod bills by the minute either way.

The consequence for pricing is easy to get wrong, so it is stated here. With continuous batching,
sixteen concurrent requests each accrue a full wall-clock second per second, so they sum to sixteen
slot-seconds per GPU-second. The rate must therefore divide the pod's cost by the nominal
concurrency, not charge pod-cost-per-second to each slot:

    rate_micro_per_slot_second = ceil_div(pod_micro_per_hour, 3600 * NOMINAL_CONCURRENCY)

Full utilisation of every slot for an hour then recovers exactly one pod-hour, and under-utilisation
under-recovers — which is correct: idle capacity is the operator's cost, not a learner's.

MONEY IS INTEGER MICRO-CREDITS, ALWAYS

1 credit = 1_000_000 micro-credits, stored in `BigInteger`. No `Float`, no `Numeric`, no `Decimal`
anywhere on this path — none exists in this codebase today and none should start here. Integer
division only: `ceil_div(a, b) = -(-a // b)`, never `math.ceil(a / b)`, which routes through a float.

THESE ARE THE FIRST CHECK CONSTRAINTS IN THE CODEBASE

There were none before. They are worth the precedent because they are the difference between an
invariant and a comment: `reserved_micro <= balance_micro` and `settled_micro <= hold_micro` are
guarantees the database keeps even when application code is wrong, and the money path is exactly
where that distinction earns its keep. Named `ck_*` to sit alongside the existing `uq_*` and `ix_*`.

ON "APPEND-ONLY"

`gpu_ledger` is append-only *by convention* — no code path updates or deletes a row. It is not yet a
guarantee: the application connects as the schema owner, so a real guarantee needs
`REVOKE UPDATE, DELETE ON gpu_ledger` against a separate migration role. That is not done, and this
paragraph exists so nobody reads more assurance into the table than it currently carries.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

#: Micro-credits in one credit. Displayed balances floor to whole credits; the ledger never does.
MICRO_PER_CREDIT = 1_000_000


class GpuWallet(Base):
    """One wallet per user. `balance_micro` is the TOTAL, including anything reserved.

    Modelling the balance as the total rather than as balance-excluding-reserved is what lets the
    reservation be a single-row, single-statement guarded UPDATE, and what lets
    "you cannot reserve what you do not have" be expressed as a CHECK rather than as application
    logic. Available credit is `balance_micro - reserved_micro`.

    There is deliberately no wallet for `identity.ANONYMOUS_USER_ID`. That UUID is a single shared
    identity seeded at startup and handed to every caller who presents no header, so a wallet on it
    would be one bank account for the whole internet: the first abuser drains it and every
    unauthenticated visitor is refused. A free tier, if one is ever wanted, has to be per-IP or
    per-device with its own quota mechanism — not a wallet.
    """

    __tablename__ = "gpu_wallets"

    #: The user id IS the primary key, so one-wallet-per-user needs no separate unique constraint.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    balance_micro: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    reserved_micro: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    #: Timezone-aware, unlike `created_at` on older tables. `models/user.py` records the rule this
    #: follows: aware types are for values that get compared, and every one of these does.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("balance_micro >= 0", name="ck_gpu_wallets_balance_nonneg"),
        CheckConstraint("reserved_micro >= 0", name="ck_gpu_wallets_reserved_nonneg"),
        # The invariant the whole design rests on. If this can ever be violated, a wallet has sold
        # credit it does not hold.
        CheckConstraint(
            "reserved_micro <= balance_micro", name="ck_gpu_wallets_reserved_le_balance"
        ),
    )


class GpuReservation(Base):
    """A hold taken before generation and settled after it, on measured slot occupancy.

    The settled row IS the per-request cost record — it carries the kind, the backend, the measured
    interval, the rate that was live, and what was charged. A parallel "requests" table would be a
    second place for the same fact to drift.
    """

    __tablename__ = "gpu_reservations"

    #: The idempotency anchor for the whole lifecycle. Deliberately NOT `request_id`: that value is
    #: client-visible and was not unique until recently, and anchoring money on it would make a
    #: collision a cross-user charge.
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    wallet_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("gpu_wallets.user_id", ondelete="CASCADE"),
        nullable=False,
    )
    #: The `chatcmpl-...` id, for correlating with logs. Not unique and not relied upon.
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    #: `chat` | `interview_grade`. Interview grading is metered because it runs the same model on
    #: the same card; leaving it out would make it free GPU.
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    state: Mapped[str] = mapped_column(
        SAEnum("held", "settled", "voided", name="gpu_reservation_state_enum"),
        nullable=False,
        default="held",
        server_default="held",
    )
    hold_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)
    settled_micro: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: Measured occupancy: semaphore acquire to release. Null while held.
    slot_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The narrower interval around the backend call itself. Audit only — never billed. Kept because
    #: `slot_ms` includes the serving backend's own scheduler wait, and the gap between the two is
    #: the evidence for whether that is acceptable.
    backend_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Snapshotted so a price change is never retroactive: a past request settles at the rate that
    #: was live when it ran.
    rate_micro_per_slot_second: Mapped[int] = mapped_column(BigInteger, nullable=False)
    backend: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Which replica held it, so a sweep can tell "the pod is gone" from "the pod is still working".
    replica: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint("hold_micro > 0", name="ck_gpu_reservations_hold_positive"),
        CheckConstraint(
            "settled_micro IS NULL OR settled_micro >= 0",
            name="ck_gpu_reservations_settled_nonneg",
        ),
        # "A settle may never exceed its hold", as a constraint rather than an if-statement. The
        # service clamps too, but this is what makes it a guarantee: a learner is never charged more
        # than was authorised before their request ran, even if the clamp is wrong.
        CheckConstraint(
            "settled_micro IS NULL OR settled_micro <= hold_micro",
            name="ck_gpu_reservations_settled_le_hold",
        ),
        # A held row has no settled amount and a finished one always does, so "finished" cannot be
        # half-recorded.
        CheckConstraint(
            "(state = 'held' AND settled_micro IS NULL)"
            " OR (state <> 'held' AND settled_micro IS NOT NULL)",
            name="ck_gpu_reservations_state_consistent",
        ),
        # Partial index: the sweep only ever looks for old held rows, and held rows are the small
        # minority once traffic is real.
        Index(
            "ix_gpu_reservations_held",
            "created_at",
            postgresql_where=(state == "held"),
        ),
        Index("ix_gpu_reservations_wallet_time", "wallet_user_id", "created_at"),
    )


class GpuLedger(Base):
    """Append-only record of every movement, with the balance it produced.

    `balance_after_micro` is stored so an audit can read one row rather than replaying the table,
    and so a wallet that disagrees with its own history is detectable by comparison rather than by
    trust. The wallet row is a cache of this table, not the other way round.
    """

    __tablename__ = "gpu_ledger"

    #: BigInteger identity rather than a UUID: audit needs a total order, and a UUID has none.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    wallet_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("gpu_wallets.user_id", ondelete="CASCADE"),
        nullable=False,
    )
    entry_type: Mapped[str] = mapped_column(
        SAEnum(
            "grant", "hold", "release", "charge", "refund", "adjust",
            name="gpu_ledger_entry_type_enum",
        ),
        nullable=False,
    )
    #: Signed: charges negative, grants positive. Summing this column reconstructs the balance.
    amount_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reservation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("gpu_reservations.id", ondelete="SET NULL"),
        nullable=True,
    )
    #: Deterministic and derived, never generated: `charge:{reservation_id}`, `void:{...}`,
    #: `grant:{grant_id}`. The UNIQUE below is what makes every money path idempotent, so a retried
    #: settle is refused by the database rather than by a read-check-write the application has to
    #: get right under concurrency.
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_gpu_ledger_idempotency_key"),
        Index("ix_gpu_ledger_wallet", "wallet_user_id", "id"),
    )
