"""desktop accounts: provider identities, terms acceptance, and reset-code attempts

Revision ID: a7c3e9f1b204
Revises: e91f4c02a7d8
Create Date: 2026-09-17 12:00:00.000000

WHY THIS EXISTS

Sign-in is moving from the website into the desktop app, and three things the website got away
without become necessary once the API is called directly by an installed application:

  * `user_identities` — Google and Microsoft accounts linked by the provider's SUBJECT, not by email.
    The website's path found a user by whatever email its own server passed along, which was safe
    only because nothing else could reach that endpoint. See `models/user_identity.py`.
  * `users.terms_accepted_at` / `users.terms_version` — `/register` required the terms checkbox and
    then discarded it. Consent that is enforced and not recorded is not a record of anything.
  * `auth_tokens.attempts` — a six-digit reset code is guessable where a 32-byte link is not, so each
    code carries its own wrong-guess count. On the row, not in Redis, because the rate limiter fails
    open and a lockout must not.

PURELY ADDITIVE, AND SAFE ON A LIVE TABLE

No backfill and no rewrite. `attempts` has a server default, so existing token rows need no update
and the column add does not rewrite `auth_tokens` on PostgreSQL 11+. Accounts the website created
through Google or Microsoft have no identity row; they are linked on their first desktop sign-in.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7c3e9f1b204"
down_revision: str | None = "e91f4c02a7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=64), nullable=True),
        sa.Column("email_at_link", sa.String(length=255), nullable=True),
        sa.Column("email_trusted_at_link", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "subject", name="uq_user_identities_provider_subject"),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_identities_user_provider"),
    )
    op.create_index("ix_user_identities_user_id", "user_identities", ["user_id"], unique=False)

    op.add_column("users", sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("terms_version", sa.String(length=32), nullable=True))

    op.add_column(
        "auth_tokens",
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("auth_tokens", "attempts")
    op.drop_column("users", "terms_version")
    op.drop_column("users", "terms_accepted_at")
    op.drop_index("ix_user_identities_user_id", table_name="user_identities")
    op.drop_table("user_identities")
