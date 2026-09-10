"""add credit_vouchers

Revision ID: d7a3b91c6e05
Revises: c5e9f21a3b48
Create Date: 2026-09-10 08:45:00.000000

A redeemable code that adds credit: beta access, a refund in kind, a promotion.

TWO CHOICES HERE DIFFER FROM EVERY OTHER USER-KEYED TABLE IN THIS SCHEMA, ON PURPOSE.

`redeemed_by` is `ondelete="SET NULL"`, not `CASCADE`. Everything else keyed to a user cascades,
because a draft or a chat session for a deleted account is meaningless. A record that credit was
issued is not: deleting the user removes the subject, not the fact. Cascading here would erase the
audit trail for precisely the accounts most likely to be asked about later, which is the same
mistake that let a deleted wallet erase the proof a payment had already been credited -- see
revision b4d8e10c2f37.

`kind` is `String(32)` rather than a native enum, matching `auth_tokens.purpose`, so adding a kind
later is a code change rather than an `ALTER TYPE` that locks the table. Note that `users.role` IS a
native enum, so this reasoning does not generalise across the schema -- it is a per-column decision.

THE UNIQUE INDEX ON `code_hash` IS LOAD-BEARING, NOT AN OPTIMISATION

Two rows sharing a hash would make one code redeemable twice, which is the entire failure the
redemption path is built to prevent. The guarded UPDATE in `voucher_service.redeem()` claims by
`code_hash`; if that matched two rows it would claim both and grant once.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'd7a3b91c6e05'
down_revision: str | None = 'c5e9f21a3b48'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'credit_vouchers',
        sa.Column('id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('amount_micro', sa.BigInteger(), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('redeemed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('redeemed_by', sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('note', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ['redeemed_by'], ['users.id'],
            name='fk_credit_vouchers_redeemed_by', ondelete='SET NULL',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_credit_vouchers'),
        sa.CheckConstraint('amount_micro > 0', name='ck_credit_vouchers_amount_positive'),
    )
    op.create_index('ix_credit_vouchers_hash', 'credit_vouchers', ['code_hash'], unique=True)
    op.create_index('ix_credit_vouchers_kind', 'credit_vouchers', ['kind', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_credit_vouchers_kind', table_name='credit_vouchers')
    op.drop_index('ix_credit_vouchers_hash', table_name='credit_vouchers')
    op.drop_table('credit_vouchers')
