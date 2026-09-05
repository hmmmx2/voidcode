"""add problem_concepts join table

Revision ID: a1c7f2e9d4b3
Revises: e2b9c4d17f05
Create Date: 2026-08-09

The taxonomy join. Spec §4.2 calls the concept taxonomy "the backbone of both ranking and course
generation", and until now nothing connected the two: 144 concepts in `data/concepts.yaml`, 94
problems, and no way to ask which problems teach a concept.

`concept_id` is a plain string rather than a foreign key to a `concepts` table, on purpose. The
taxonomy lives in version-controlled YAML, is reviewed in pull requests, and is validated by
`features/taxonomy.py` — mirroring it into the database would create a second source of truth, and
the database copy would be the one nobody reviews. Referential integrity is enforced at load time
by `features/content.py`, which refuses any item naming a concept the taxonomy does not define.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a1c7f2e9d4b3"
down_revision = "e2b9c4d17f05"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "problem_concepts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("problem_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("concept_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        # CASCADE because a concept tag is meaningless without its problem, and an orphaned row
        # would keep inflating that concept's coverage count after the problem was deleted.
        sa.ForeignKeyConstraint(["problem_id"], ["problems.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # A duplicated pair would double-count the concept in mastery attribution, silently
        # weighting one problem twice against a learner's estimate.
        sa.UniqueConstraint("problem_id", "concept_id", name="uq_problem_concept"),
    )
    op.create_index("ix_problem_concepts_problem_id", "problem_concepts", ["problem_id"])
    # Leads on concept_id because ranking's hot path is "which problems teach concept X"; the
    # other direction is already served by the problem_id index above.
    op.create_index("ix_problem_concepts_concept", "problem_concepts", ["concept_id"])


def downgrade() -> None:
    op.drop_index("ix_problem_concepts_concept", table_name="problem_concepts")
    op.drop_index("ix_problem_concepts_problem_id", table_name="problem_concepts")
    op.drop_table("problem_concepts")
