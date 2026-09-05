"""add interview_questions.kind

Revision ID: c7f1a2b8d940
Revises: ecbee765535a
Create Date: 2026-07-29

The bank became entirely technical, so `kind` replaces "is it technical" with
"what do you physically do to answer": derive, compute, or write code.

Backfilled to 'derivation' rather than left null. Every existing row predates
the distinction, and derivation is the honest default for them — an unlabelled
question would drop out of a `kind` filter and look like missing data.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c7f1a2b8d940"
down_revision = "ecbee765535a"
branch_labels = None
depends_on = None

# Named enum, created explicitly. Declaring it inline on the column makes
# Alembic emit a CREATE TYPE it does not track, which then collides with itself
# on downgrade-then-upgrade — the same trap that bit the catalogue migration.
KIND = postgresql.ENUM(
    "derivation", "computation", "code", name="interview_kind_enum", create_type=False
)


def upgrade() -> None:
    KIND.create(op.get_bind(), checkfirst=True)

    # server_default for the backfill, then dropped: it exists to fill existing
    # rows in one statement, and leaving it behind would let a future insert
    # silently omit the field rather than fail loudly.
    op.add_column(
        "interview_questions",
        sa.Column("kind", KIND, nullable=False, server_default="derivation"),
    )
    op.alter_column("interview_questions", "kind", server_default=None)
    op.create_index(
        "ix_interview_questions_kind", "interview_questions", ["kind"]
    )


def downgrade() -> None:
    op.drop_index("ix_interview_questions_kind", table_name="interview_questions")
    op.drop_column("interview_questions", "kind")
    KIND.drop(op.get_bind(), checkfirst=True)
