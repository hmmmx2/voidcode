"""link interview questions to problems, and add attempt timing

Revision ID: e2b9c4d17f05
Revises: c7f1a2b8d940
Create Date: 2026-07-29

Interview questions become executable. Rather than duplicating `test_cases`,
`code_templates`, `submissions` and `code_drafts` for a second content type — or
making all four polymorphic, which would rewrite four tables holding live data —
an interview question simply *owns a problems row*.

That is why this migration is small. Judge0, the whole of `execution.py`,
`submission_service`, drafts and submission history already key on `problems.id`
and need no changes at all. The only new requirement is that those rows must not
leak into the curriculum, which `problems.origin` handles.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e2b9c4d17f05"
down_revision = "c7f1a2b8d940"
branch_labels = None
depends_on = None

# Named enum created explicitly, matching c7f1a2b8d940. Declaring it inline on
# the column makes Alembic emit a CREATE TYPE it does not track, which then
# collides with itself on downgrade-then-upgrade.
ORIGIN = postgresql.ENUM(
    "curriculum", "interview", name="problem_origin_enum", create_type=False
)


def upgrade() -> None:
    ORIGIN.create(op.get_bind(), checkfirst=True)

    # server_default is kept here rather than dropped, unlike `kind` in the
    # previous revision. It is load-bearing at runtime, not just for backfill:
    # `seed_problems.py` does `Problem(**problem_data)` straight from a dict
    # that has no `origin` key, so without a default every curriculum re-seed
    # would fail on a NOT NULL violation.
    op.add_column(
        "problems",
        sa.Column("origin", ORIGIN, nullable=False, server_default="curriculum"),
    )
    op.create_index("ix_problems_origin", "problems", ["origin"])

    # The one-to-one link. SET NULL, not CASCADE: deleting the executable half
    # should orphan the question, never destroy its approach, model answer and
    # every user's attempt along with it.
    op.add_column(
        "interview_questions",
        sa.Column("problem_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_interview_questions_problem_id",
        "interview_questions",
        "problems",
        ["problem_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_interview_questions_problem_id", "interview_questions", ["problem_id"]
    )

    # Attempt timing.
    #
    # `elapsed_seconds` gets a server_default for the backfill AND keeps it:
    # existing rows need a value now, and an attempt created by the reveal
    # endpoint — which does not know about timing — needs one later.
    op.add_column(
        "interview_attempts", sa.Column("started_at", sa.DateTime(), nullable=True)
    )
    op.add_column(
        "interview_attempts",
        sa.Column("elapsed_seconds", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "interview_attempts", sa.Column("submitted_at", sa.DateTime(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("interview_attempts", "submitted_at")
    op.drop_column("interview_attempts", "elapsed_seconds")
    op.drop_column("interview_attempts", "started_at")

    op.drop_constraint(
        "uq_interview_questions_problem_id", "interview_questions", type_="unique"
    )
    op.drop_constraint(
        "fk_interview_questions_problem_id", "interview_questions", type_="foreignkey"
    )
    op.drop_column("interview_questions", "problem_id")

    # Interview-owned problems are deleted rather than relabelled. Leaving them
    # behind as `curriculum` would silently inject 40 interview questions into
    # the problem catalogue — a far worse outcome than losing rows this
    # migration created in the first place. Their submissions and drafts cascade
    # with them, which is correct: they were never curriculum progress.
    op.execute("DELETE FROM problems WHERE origin = 'interview'")

    op.drop_index("ix_problems_origin", table_name="problems")
    op.drop_column("problems", "origin")
    ORIGIN.drop(op.get_bind(), checkfirst=True)
