"""A redeemable code that adds credit to a wallet.

WHY A VOUCHER IS NOT A PASSWORD-RESET TOKEN, THOUGH IT LOOKS LIKE ONE

The table borrows almost everything from `auth_token.py` -- a hashed secret, an expiry, a `used_at`
that is set rather than a row that is deleted -- and one thing it must not borrow is the redemption
mechanism. `token_service.redeem()` is a read-check-write: it selects the row, checks `used_at` in
Python, then assigns. Two concurrent requests can both pass that check.

For a reset link the consequence is nil, because redeeming one twice is idempotent in effect. For a
voucher the second redemption **mints money**. So redemption here is a guarded single-statement
UPDATE whose predicate lives in the `WHERE` clause, in the shape `gpu_wallet_service` uses for every
mutation on the money path, with `gpu_grant_keys` as a second independent guard behind it.

WHY `kind` IS A STRING AND NOT A NATIVE ENUM

The same reason `auth_token.purpose` is: adding a kind later should be a code change, not a
migration that takes an ACCESS EXCLUSIVE lock on the table. Note this reasoning does NOT carry over
from `users.role`, which IS a native enum -- adding a role there is an `ALTER TYPE`.

WHY `redeemed_by` IS `SET NULL` AND NOT `CASCADE`

Everything else keyed to a user in this schema cascades. This must not. The row records that credit
was issued and to whom, and deleting the user does not make that untrue -- it only removes the
subject. A cascade here would erase the audit trail for exactly the accounts most likely to be
asked about, and it is the same mistake that let a deleted wallet erase the proof a payment had
already been credited (see `GpuGrantKey`).

MULTI-USE VOUCHERS ARE DELIBERATELY NOT EXPRESSIBLE

`redeemed_at` is a boolean in disguise: one row, one redemption. A shared campaign code needs
`max_redemptions` and a counter, and the counter needs its own guarded increment -- a different
design, not a bigger version of this one. Issue N rows instead until that is actually wanted.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

#: What a voucher was issued for. Recorded so a spike in redemptions can be attributed, and so a
#: refund-in-kind is distinguishable from marketing spend when the ledger is read months later.
KIND_BETA = "beta"
KIND_REFUND = "refund"
KIND_PROMO = "promo"


class CreditVoucher(Base):
    """One row per issued code. Redeemed by setting `redeemed_at`, never by deleting."""

    __tablename__ = "credit_vouchers"
    __table_args__ = (
        # Lookup is always by hash, and it must be unique: two rows sharing one hash would make a
        # single code redeemable twice, which is the entire failure this table is designed against.
        Index("ix_credit_vouchers_hash", "code_hash", unique=True),
        Index("ix_credit_vouchers_kind", "kind", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    #: SHA-256 hex of the code. Not argon2id, and that is not a shortcut: the input is 32 bytes from
    #: `secrets.token_urlsafe`, so there is no low-entropy guess to slow down, and a redeem endpoint
    #: that took 100 ms of hashing would be a denial-of-service lever. Same reasoning as
    #: `auth_token.token_hash`.
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    #: Micro-credits granted on redemption. Integer, like every other figure on this path.
    amount_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)

    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    #: Null means it does not expire. A refund-in-kind should not evaporate.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    #: Non-null means spent. The row survives so that "already redeemed" stays distinguishable from
    #: "no such code" -- a second click is the commonest way to reach this endpoint.
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    redeemed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    #: Free text for whoever mints it: a ticket number, a campaign, a name. Never shown to a learner.
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )

    @property
    def is_redeemed(self) -> bool:
        return self.redeemed_at is not None

    def is_expired(self, now: datetime | None = None) -> bool:
        if self.expires_at is None:
            return False
        return self.expires_at <= (now or datetime.now(timezone.utc))
