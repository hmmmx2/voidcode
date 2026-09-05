"""Code submissions and per-test-case results."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
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
    from .problem import Problem
    from .user import User


class Submission(Base):
    __tablename__ = "submissions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    problem_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("problems.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Code snapshot
    source_code: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(30), nullable=False)
    judge0_language_id: Mapped[int] = mapped_column(Integer, nullable=False)

    # Overall result
    status: Mapped[str] = mapped_column(
        SAEnum(
            "accepted",
            "wrong_answer",
            "time_limit_exceeded",
            "runtime_error",
            "compilation_error",
            "internal_error",
            name="submission_status_enum",
        ),
        nullable=False,
    )

    # Aggregate metrics
    total_tests: Mapped[int] = mapped_column(Integer, nullable=False)
    passed_tests: Mapped[int] = mapped_column(Integer, nullable=False)
    overall_runtime_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    overall_memory_kb: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        index=True,
    )

    # Relationships
    user: Mapped["User"] = relationship(back_populates="submissions")
    problem: Mapped["Problem"] = relationship(back_populates="submissions")
    test_case_results: Mapped[list["TestCaseResult"]] = relationship(
        back_populates="submission", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Fast lookup for "my submissions for problem X, newest first"
        Index(
            "ix_submissions_user_problem_time",
            "user_id",
            "problem_id",
            "created_at",
        ),
    )


class TestCaseResult(Base):
    """Per-test-case execution result within a submission."""

    __tablename__ = "test_case_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    submission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("submissions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    test_case_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("test_cases.id", ondelete="SET NULL"),
        nullable=True,  # Nullable so test case deletion doesn't lose history
    )

    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)

    # Judge0 raw fields
    stdout: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr: Mapped[str | None] = mapped_column(Text, nullable=True)
    compile_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status_description: Mapped[str] = mapped_column(String(100), nullable=False)
    runtime_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    memory_kb: Mapped[int | None] = mapped_column(Integer, nullable=True)

    expected_output: Mapped[str] = mapped_column(Text, nullable=False)
    actual_output: Mapped[str | None] = mapped_column(Text, nullable=True)

    submission: Mapped["Submission"] = relationship(back_populates="test_case_results")
