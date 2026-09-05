"""Replace the course hierarchy with per-problem categories.

Revision ID: d4e5f6a7b8c9
Revises: b1c2d3e4f5a6
Create Date: 2026-07-28

WHAT THIS REMOVES AND WHY

The `courses -> modules -> content_items` hierarchy is inherited from the
university product this used to be. It can express only one thing: a problem
belongs to exactly one ordered course. That is the wrong shape for the material.
Scaled dot-product attention is genuinely both DL and LLM; LayerNorm is both DL
and PyTorch. A single-parent tree forces an arbitrary choice, and whichever way
you choose, half the people browsing will not find it.

`problems.categories` is a JSON array instead, so a problem can carry every lens
it belongs under.

WHY JSON RATHER THAN A TAGS TABLE

A join table would be the textbook answer and is the wrong trade here. The
category vocabulary is small, closed and changes about never; nothing needs to
query "all problems for tag X" with an index, because the whole problem set fits
in one response. A JSON column keeps it one column, one migration and no joins.
If categories ever grow a description, an ordering or per-category progress
stored server-side, promote it to a table then.

DROP ORDER MATTERS. `content_items` references `modules`, `modules` references
`courses`, and `problems.course_id` references `courses`. Postgres refuses to
drop a table while a foreign key still points at it, so children go first and
`problems.course_id` must go before `courses`.

THE DOWNGRADE RECREATES THE SCHEMA BUT NOT THE DATA. Course rows, module rows
and content-item rows are gone for good; re-running `scripts/seed_courses.py`
would have been the way back, and that script is deleted in this change. The
schema restore is enough to make `alembic downgrade` succeed and to let an older
revision of the code start, which is what a downgrade is for.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "d4e5f6a7b8c9"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Add the replacement ────────────────────────────────────────────
    #
    # NOT NULL with a server default of '[]'. Existing rows get an empty array
    # rather than NULL, so every consumer can iterate the column without a null
    # check — `for c in problem.categories` must never be the line that raises.
    op.add_column(
        "problems",
        sa.Column(
            "categories",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    # ── 2. Detach problems from courses ───────────────────────────────────
    #
    # Must happen before `courses` is dropped. Dropping the column takes its
    # foreign-key constraint with it.
    op.drop_column("problems", "course_id")

    # ── 3. Drop the hierarchy, children first ─────────────────────────────
    op.drop_table("content_items")
    op.drop_table("modules")
    op.drop_table("courses")


def downgrade() -> None:
    # Recreate the schema in dependency order: parents before children.
    op.create_table(
        "courses",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("code", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("image_url", sa.Text(), nullable=True),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("ix_courses_code", "courses", ["code"], unique=True)

    op.create_table(
        "modules",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("course_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_modules_sort_order", "modules", ["sort_order"])

    op.create_table(
        "content_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("module_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("problem_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("item_type", sa.String(length=30), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["module_id"], ["modules.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["problem_id"], ["problems.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_content_items_sort_order", "content_items", ["sort_order"])

    op.add_column(
        "problems",
        sa.Column("course_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "problems_course_id_fkey", "problems", "courses",
        ["course_id"], ["id"], ondelete="SET NULL",
    )

    op.drop_column("problems", "categories")
