"""add profile fields to users and notifications table

Revision ID: c3f7a8d91e02
Revises: 9024b6255687
Create Date: 2026-02-15

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "c3f7a8d91e02"
down_revision: str | None = "9024b6255687"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── Add profile columns to users table ────────────────────────
    op.add_column("users", sa.Column("bio", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("birth_date", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("country", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("occupation", sa.String(200), nullable=True))
    op.add_column("users", sa.Column("profile_photo_url", sa.Text(), nullable=True))

    # ── Create notification_type_enum ─────────────────────────────
    notification_type_enum = postgresql.ENUM(
        "submission_accepted",
        "submission_failed",
        "welcome",
        "streak",
        "system",
        name="notification_type_enum",
        create_type=False,
    )
    notification_type_enum.create(op.get_bind(), checkfirst=True)

    # ── Create notifications table ────────────────────────────────
    op.create_table(
        "notifications",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "type",
            notification_type_enum,
            nullable=False,
        ),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("is_read", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("reference_id", sa.String(100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # ── Indexes ───────────────────────────────────────────────────
    op.create_index("ix_notifications_user_id", "notifications", ["user_id"])
    op.create_index("ix_notifications_is_read", "notifications", ["is_read"])
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])
    op.create_index(
        "ix_notifications_user_unread",
        "notifications",
        ["user_id", "is_read", "created_at"],
    )


def downgrade() -> None:
    op.drop_table("notifications")

    # Drop the enum type
    notification_type_enum = postgresql.ENUM(
        "submission_accepted",
        "submission_failed",
        "welcome",
        "streak",
        "system",
        name="notification_type_enum",
    )
    notification_type_enum.drop(op.get_bind(), checkfirst=True)

    # Drop profile columns from users
    op.drop_column("users", "profile_photo_url")
    op.drop_column("users", "occupation")
    op.drop_column("users", "country")
    op.drop_column("users", "birth_date")
    op.drop_column("users", "bio")
