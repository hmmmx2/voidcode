"""add_code_drafts_table

Revision ID: 93f288d0e905
Revises: f43c1af6356d
Create Date: 2026-02-17 16:35:03.730023

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '93f288d0e905'
down_revision: str | None = 'f43c1af6356d'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "code_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("problem_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("problems.id", ondelete="CASCADE"), nullable=False),
        sa.Column("language", sa.String(30), nullable=False),
        sa.Column("source_code", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
    )
    op.create_unique_constraint("uq_draft_user_problem_lang", "code_drafts", ["user_id", "problem_id", "language"])
    op.create_index("ix_code_drafts_user_problem", "code_drafts", ["user_id", "problem_id"])


def downgrade() -> None:
    op.drop_index("ix_code_drafts_user_problem", table_name="code_drafts")
    op.drop_constraint("uq_draft_user_problem_lang", "code_drafts", type_="unique")
    op.drop_table("code_drafts")
