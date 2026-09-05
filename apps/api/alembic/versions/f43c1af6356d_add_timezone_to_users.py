"""add_timezone_to_users

Revision ID: f43c1af6356d
Revises: c3f7a8d91e02
Create Date: 2026-02-17 16:30:20.929097

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'f43c1af6356d'
down_revision: str | None = 'c3f7a8d91e02'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("timezone", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "timezone")
