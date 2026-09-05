"""Problem bank: problems, test cases, and per-language code templates."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy import (
    Enum as SAEnum,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    # SQLAlchemy resolves these string annotations through its own registry at
    # runtime, so the code works without them -- but nothing else can follow the
    # reference, and ruff reads them as undefined names. Importing under
    # TYPE_CHECKING gives type checkers and editors the link with no runtime import,
    # so the model cycle these tables genuinely form cannot become an import cycle.
    from .submission import Submission


class Problem(Base):
    __tablename__ = "problems"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    difficulty: Mapped[str] = mapped_column(
        SAEnum("easy", "medium", "hard", name="difficulty_enum"),
        nullable=False,
        index=True,
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)

    # JSON arrays — stored as PostgreSQL JSONB
    examples: Mapped[list] = mapped_column(JSON, default=list)
    # [{"input": "nums = [2,7,11,15], target = 9", "output": "[0,1]", "explanation": "..."}]

    constraints: Mapped[list] = mapped_column(JSON, default=list)
    # ["2 <= nums.length <= 10^4", ...]

    hints: Mapped[list] = mapped_column(JSON, default=list)
    # ["A brute force approach...", "Think about...", "A hash map..."]

    # Ordering for the problem list UI
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)

    # Category labels: "ML", "DL", "LLM", "VLM", "CUDA", "PyTorch", "TensorFlow".
    #
    # A problem carries every lens it belongs under — attention is genuinely both
    # DL and LLM, LayerNorm is both DL and PyTorch. That is precisely what the
    # `course_id` foreign key this replaced could not express: a single parent
    # forces an arbitrary choice, and whichever way you choose, half the people
    # browsing by the other lens never find it.
    categories: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    is_published: Mapped[bool] = mapped_column(Boolean, default=True)

    # Which surface owns this problem.
    #
    # Interview questions are executed and graded by exactly the same pipeline
    # as curriculum problems, so their executable half *is* a row in this table
    # — that is what lets Judge0, `submissions`, `code_drafts` and the whole of
    # `execution.py` work for them without a single change. `interview_questions
    # .problem_id` points here.
    #
    # The discriminator exists because those rows must not leak. Without it an
    # interview question would appear in the Problems catalogue, inflate
    # `total_problems`, and count toward the dashboard's solved ring — three
    # places that ask "how much curriculum is there", which is not the same
    # question as "what is executable".
    origin: Mapped[str] = mapped_column(
        SAEnum("curriculum", "interview", name="problem_origin_enum"),
        nullable=False,
        default="curriculum",
        server_default="curriculum",
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    test_cases: Mapped[list["TestCase"]] = relationship(
        back_populates="problem",
        cascade="all, delete-orphan",
        order_by="TestCase.order_index",
    )
    code_templates: Mapped[list["CodeTemplate"]] = relationship(
        back_populates="problem", cascade="all, delete-orphan"
    )
    # The taxonomy join. Until this existed the 144 concepts in data/concepts.yaml were attached to
    # nothing, so candidate generation, mastery attribution and course assembly all had no input.
    # delete-orphan because a concept tag has no meaning without its problem, and an orphan would
    # keep inflating that concept's coverage count after the problem was gone.
    concepts: Mapped[list["ProblemConcept"]] = relationship(  # noqa: F821
        back_populates="problem", cascade="all, delete-orphan"
    )
    # `passive_deletes=True` is required, not an optimisation.
    #
    # The database already declares `ON DELETE CASCADE` on
    # `submissions.problem_id`, but without this flag SQLAlchemy's ORM does not
    # know that: its default for a one-to-many with no cascade is to *nullify*
    # the child's foreign key before issuing the parent DELETE. The column is
    # `nullable=False`, so that UPDATE fails with a NotNullViolation and the
    # DB's own CASCADE is never reached.
    #
    # The effect is that `await db.delete(problem)` — the natural way to remove
    # a problem — raises, while the bulk `delete()` statement in
    # `seed_problems.py --force` succeeds, because a bulk statement bypasses the
    # ORM and lets the database rule apply. Two spellings of the same operation,
    # one of which is broken.
    #
    # This surfaced the first time the Postgres-backed tests actually ran; while
    # the DB was unreachable they skipped and the bug was invisible.
    submissions: Mapped[list["Submission"]] = relationship(
        back_populates="problem", passive_deletes=True
    )

    __table_args__ = (
        Index("ix_problems_difficulty_order", "difficulty", "order_index"),
    )


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    problem_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("problems.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    label: Mapped[str] = mapped_column(String(50), nullable=False)
    # Structured inputs as JSON: [{"name": "nums", "value": "[2,7,11,15]"}, ...]
    inputs: Mapped[list] = mapped_column(JSON, nullable=False)
    # stdin format for Judge0 execution
    stdin: Mapped[str] = mapped_column(Text, nullable=False)
    expected_output: Mapped[str] = mapped_column(Text, nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    # Hidden test cases are used for Submit but not shown in the UI
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False)

    problem: Mapped["Problem"] = relationship(back_populates="test_cases")


class CodeTemplate(Base):
    """Per-language starter code for each problem."""

    __tablename__ = "code_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    problem_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("problems.id", ondelete="CASCADE"),
        nullable=False,
    )
    language: Mapped[str] = mapped_column(String(30), nullable=False)
    # e.g. "Python", "JavaScript", "C++", "Java"
    judge0_language_id: Mapped[int] = mapped_column(Integer, nullable=False)
    template_code: Mapped[str] = mapped_column(Text, nullable=False)
    # Hidden driver code appended to user code for Judge0 execution
    # Reads stdin, calls the user's method, and prints the result to stdout
    driver_code: Mapped[str | None] = mapped_column(Text, nullable=True)

    problem: Mapped["Problem"] = relationship(back_populates="code_templates")

    __table_args__ = (
        Index(
            "ix_code_templates_problem_lang", "problem_id", "language", unique=True
        ),
    )
