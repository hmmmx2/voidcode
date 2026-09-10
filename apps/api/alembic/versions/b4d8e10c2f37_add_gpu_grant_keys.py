"""add gpu_grant_keys so a replayed payment cannot re-credit after a wallet delete

Revision ID: b4d8e10c2f37
Revises: a3f9c2e71b04
Create Date: 2026-09-10 08:05:00.000000

THE DEFECT THIS CLOSES

`uq_gpu_ledger_idempotency_key` was the only record that a grant had already happened. It sits on
`gpu_ledger`, whose `wallet_user_id` cascades from `gpu_wallets`, which cascades from `users`. So
deleting a wallet -- support closing a billing account, an erasure request, a cleanup script --
deleted the proof along with it. Stripe redelivers for up to several days, `grant()` recreates a
missing wallet, and the replay credited the same payment a second time. Both grants look correct
individually and nothing in the data marks the pair as wrong.

Reproduced before the fix by
`tests/test_payments_webhook_postgres.py::TestRedeliveryAfterTheWalletIsGone`.

WHY A SEPARATE TABLE RATHER THAN `ondelete="RESTRICT"` ON THE LEDGER

RESTRICT would also have worked, by making a wallet with history undeletable. It was rejected
because it moves the failure to the wrong place: an erasure request would fail with a foreign-key
violation from a table nobody deleting a user was thinking about, and the only way out would be to
delete the ledger by hand -- reintroducing the defect as an operational step.

This table separates the two questions. Erasure still removes the wallet, the reservations and the
ledger. What survives is a key, an amount and a user id: the minimum needed to refuse a replay, and
small enough that an erasure procedure can decide about it deliberately rather than destroy it as a
side effect.

There is deliberately NO foreign key on `user_id`. A foreign key is exactly the cascade that caused
this, and the column records who an event credited, not a live relationship.

THE BACKFILL IS THE POINT OF DEPLOYING THIS, NOT A TIDY-UP

Without it, every grant made before this migration has no key row, and the first redelivery of any
of those payments after deploy would credit again -- the precise bug, on real historical purchases.
The backfill is idempotent (`ON CONFLICT DO NOTHING`) so a re-run is harmless.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b4d8e10c2f37'
down_revision: str | None = 'a3f9c2e71b04'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'gpu_grant_keys',
        sa.Column('idempotency_key', sa.String(length=128), nullable=False),
        sa.Column('user_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('amount_micro', sa.BigInteger(), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint('idempotency_key', name='pk_gpu_grant_keys'),
    )
    op.create_index('ix_gpu_grant_keys_user', 'gpu_grant_keys', ['user_id', 'created_at'])

    # Backfill from grants that already happened. `created_at` is carried across so the row dates
    # from the payment rather than from the deploy.
    op.execute(
        """
        INSERT INTO gpu_grant_keys (idempotency_key, user_id, amount_micro, created_at)
        SELECT idempotency_key, wallet_user_id, amount_micro, created_at
        FROM gpu_ledger
        WHERE entry_type = 'grant'
        ON CONFLICT (idempotency_key) DO NOTHING
        """
    )


def downgrade() -> None:
    # Dropping this reopens the defect. It is reversible because a migration that cannot be undone
    # is worse, not because going back is safe.
    op.drop_index('ix_gpu_grant_keys_user', table_name='gpu_grant_keys')
    op.drop_table('gpu_grant_keys')
