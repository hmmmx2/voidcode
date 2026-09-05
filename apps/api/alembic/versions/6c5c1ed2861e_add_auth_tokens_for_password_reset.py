"""add auth_tokens for password reset

Revision ID: 6c5c1ed2861e
Revises: b8e3d1f07a26
Create Date: 2026-08-10 04:22:40.099388

WHAT AUTOGENERATE WANTED TO DO, AND WHY IT WAS REMOVED

`alembic revision --autogenerate` produced five extra operations alongside the new table:

    op.drop_constraint('uq_interview_questions_problem_id', ...)
    op.create_index('ix_interview_questions_problem_id', ..., unique=True)
    op.alter_column('knowledge_documents', 'created_at', nullable=False)
    op.alter_column('knowledge_documents', 'updated_at', nullable=False)
    op.alter_column('problem_concepts', 'created_at', nullable=False)

None of them has anything to do with password reset. They are pre-existing drift between the models
and the live database, and every one of them is a lock on a populated table — the NOT NULLs would
fail outright against any existing row with a null timestamp.

They are removed rather than kept. A migration named for one change that quietly performs five is
unreviewable, and an earlier migration in this project dropped six columns including `test_cases`
this exact way. The drift is real and worth a migration of its own, deliberately written, after
checking what the affected rows actually contain.

This migration creates one table and nothing else.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '6c5c1ed2861e'
down_revision: str | None = 'b8e3d1f07a26'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'auth_tokens',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        # SHA-256 hex of the token, never the token. A backup or a slow-query log would otherwise
        # hold a working reset link for every pending request.
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('purpose', sa.String(length=32), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        # Non-null means spent. The row is kept rather than deleted so a second click on a link can
        # be told apart from a forged token.
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        # Denormalised so a link can be invalidated when the account's email changes afterwards;
        # comparing against `users.email` at redemption would compare the new address with itself.
        sa.Column('sent_to_email', sa.String(length=255), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    # Unique: two rows sharing a hash would make the lookup on a valid link raise.
    op.create_index('ix_auth_tokens_hash', 'auth_tokens', ['token_hash'], unique=True)
    # Revoking every outstanding token for a user on password change scans by this pair.
    op.create_index('ix_auth_tokens_user_purpose', 'auth_tokens', ['user_id', 'purpose'])


def downgrade() -> None:
    op.drop_index('ix_auth_tokens_user_purpose', table_name='auth_tokens')
    op.drop_index('ix_auth_tokens_hash', table_name='auth_tokens')
    op.drop_table('auth_tokens')
