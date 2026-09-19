"""
The three catalogue modules: research papers, guided projects, interview questions.

WHY ONE FILE FOR THREE MODULES

They are the same shape. Every catalogue item has a slug, a title, a difficulty,
a `categories` array and an `order_index`; every one has a per-user progress row
keyed on (user_id, item_id). Splitting them across three files would triple the
imports and hide the fact that they are deliberately uniform — which is what lets
the dashboard aggregate all four modules without four special cases.

`Problem` (in `problem.py`) is the fourth member of this family and already
matches. It stays where it is because it carries test cases and code templates
that nothing else has.

WHY THE DEEP CONTENT IS JSON RATHER THAN TABLES

A paper's four sections, a project's steps and a question's follow-ups are all
authored together, read together and never queried independently. A `sections`
table would buy an index nobody uses and cost a join on every read. They are also
edited as whole documents in `scripts/`, so a JSON column matches how the content
is actually written. If a section ever needs to be searched or versioned on its
own, promote it then.
"""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import (
    Enum as SAEnum,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    # Import-time only. A runtime import would make this module depend on
    # `problem`, and `alembic/env.py` imports both — a cycle there breaks every
    # alembic command, which is exactly how a stale `Course` import once broke
    # the whole migration chain.
    from .problem import Problem


DIFFICULTY = SAEnum("easy", "medium", "hard", name="difficulty_enum", create_type=False)


# ── Research papers ──────────────────────────────────────────────────────────


class Paper(Base):
    """A paper, plus the four breakdowns that make it teachable."""

    __tablename__ = "papers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)

    authors: Mapped[str] = mapped_column(String(500), nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    venue: Mapped[str | None] = mapped_column(String(120), nullable=True)
    arxiv_id: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # Hotlinked from arXiv rather than stored. If these ever need to be served
    # locally the column stays — only what it points at changes.
    pdf_url: Mapped[str] = mapped_column(Text, nullable=False)
    abstract: Mapped[str] = mapped_column(Text, nullable=False)

    difficulty: Mapped[str] = mapped_column(DIFFICULTY, nullable=False, default="medium")
    categories: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)

    # { architecture, implementation, systems, mathematics } — markdown bodies.
    # The keys are fixed because the UI renders exactly four tabs; a paper
    # missing one shows that tab empty rather than reshaping the interface.
    sections: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    key_equations: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    # Slugs of problems that implement this paper's ideas. Stored as slugs, not
    # foreign keys, so authoring a paper does not depend on the problem existing
    # yet — the UI simply omits a link it cannot resolve.
    related_problem_slugs: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    is_published: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    progress: Mapped[list["PaperProgress"]] = relationship(
        back_populates="paper", cascade="all, delete-orphan", passive_deletes=True
    )


class PaperProgress(Base):
    __tablename__ = "paper_progress"
    __table_args__ = (UniqueConstraint("user_id", "paper_id", name="uq_paper_progress"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    paper_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("papers.id", ondelete="CASCADE"), index=True
    )

    # Section keys read so far. Progress is "how much of the breakdown have I
    # worked through", which is the only thing about reading a paper this
    # platform can honestly measure.
    sections_read: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    paper: Mapped["Paper"] = relationship(back_populates="progress")


# ── Guided projects ──────────────────────────────────────────────────────────


class Project(Base):
    """A guided build, from nothing to a working LLM or VLM component."""

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)

    kind: Mapped[str] = mapped_column(
        SAEnum("llm", "vlm", name="project_kind_enum"), nullable=False
    )
    difficulty: Mapped[str] = mapped_column(DIFFICULTY, nullable=False, default="medium")
    categories: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    estimated_hours: Mapped[int] = mapped_column(Integer, default=4)
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)

    # [{ key, title, brief, instructions, checkpoint, artifact_hint }]
    steps: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    is_published: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    sessions: Mapped[list["ProjectSession"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )


class ProjectSession(Base):
    """
    One user's run through one project.

    STATE IS SERVER-SIDE, DELIBERATELY. A guided build spans hours and probably
    more than one sitting; keeping progress in localStorage would lose it on a
    different machine and silently on a cleared browser. That is the difference
    between a tutorial and a project.
    """

    __tablename__ = "project_sessions"
    __table_args__ = (
        UniqueConstraint("user_id", "project_id", name="uq_project_session"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    # 0-based index of the furthest step opened. Gating reads this: step n opens
    # only once n-1 is checkpointed.
    current_step: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completed_steps: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    # Per-step scratch and carried-forward artifacts. JSON because a step's
    # shape varies — a config, a file, a chosen hyperparameter — and written on
    # checkpoint rather than on keystroke.
    step_state: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    artifacts: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    project: Mapped["Project"] = relationship(back_populates="sessions")


# ── Elite interview questions ────────────────────────────────────────────────


class InterviewQuestion(Base):
    """
    One interview question, with the answer withheld until asked for.

    `approach` and `model_answer` are separate columns rather than one body
    because the UI reveals them in two stages. Merging them would make it
    impossible to show the shape of a good answer without also showing the
    answer, which is the entire pedagogy of the page.
    """

    __tablename__ = "interview_questions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)

    domain: Mapped[str] = mapped_column(
        SAEnum("ml", "dl", "cuda", "maths", "llm", "vlm", name="interview_domain_enum"),
        nullable=False,
        index=True,
    )
    difficulty: Mapped[str] = mapped_column(DIFFICULTY, nullable=False, default="medium")

    # What the candidate physically does to answer.
    #
    # The bank is entirely technical, so "technical" stopped being a useful
    # label and this took its place. It is a real filter axis: preparing for a
    # whiteboard round means wanting the `code` questions specifically, and
    # revising the maths means wanting `derivation`.
    #
    #   derivation  — algebra with a result you can check (dL/dz = p - y).
    #   computation — arithmetic on a real config (KV cache for 7B at 8k).
    #   code        — 5-15 lines written on a board. NOT graded here; full
    #                 implementations belong in the problem catalogue, where
    #                 Judge0 executes them against test cases.
    kind: Mapped[str] = mapped_column(
        SAEnum("derivation", "computation", "code", name="interview_kind_enum"),
        nullable=False,
        default="derivation",
        index=True,
    )

    # Labs where this question, or a close variant, is commonly asked.
    companies: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    categories: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)

    approach: Mapped[str] = mapped_column(Text, nullable=False)
    model_answer: Mapped[str] = mapped_column(Text, nullable=False)
    follow_ups: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    red_flags: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    # The executable half, if this question has one.
    #
    # A question that is answered by writing code owns a `problems` row carrying
    # its description, examples, constraints, test cases and code templates.
    # That row is marked `origin='interview'` so it never appears in the
    # curriculum, but it is a real problem in every other respect — which is
    # exactly the point: Judge0, grading, submissions and autosaved drafts all
    # key on `problems.id` and needed no changes to work here.
    #
    # Nullable because a question can exist before its executable half is
    # authored, and unique because the relationship is one-to-one. `SET NULL`
    # rather than `CASCADE`: deleting the problem should orphan the question,
    # not silently destroy its approach, model answer and every user's attempt.
    problem_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("problems.id", ondelete="SET NULL"),
        nullable=True,
    )

    # A named unique CONSTRAINT, as e2b9c4d17f05 created it — not `unique=True,
    # index=True`, which declares a unique index autogenerate would swap it for.
    # The constraint's own index already serves lookups by `problem_id`.
    __table_args__ = (
        UniqueConstraint("problem_id", name="uq_interview_questions_problem_id"),
    )

    is_published: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    attempts: Mapped[list["InterviewAttempt"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", passive_deletes=True
    )

    # No `back_populates`: `Problem` deliberately knows nothing about interview
    # questions. The dependency runs one way, which is what keeps the problems
    # model and the whole execution pipeline unaware that this feature exists.
    problem: Mapped["Problem | None"] = relationship("Problem", lazy="raise")


class InterviewAttempt(Base):
    """
    A self-assessed attempt.

    THERE IS NO AUTO-GRADING AND THAT IS THE POINT. These answers are prose about
    trade-offs; scoring them by keyword match would reward the wrong thing and
    lie to the candidate about readiness. `self_rating` is the honest signal
    available, and it drives progress.
    """

    __tablename__ = "interview_attempts"
    __table_args__ = (
        UniqueConstraint("user_id", "question_id", name="uq_interview_attempt"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    question_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("interview_questions.id", ondelete="CASCADE"),
        index=True,
    )

    # 1 = could not answer, 2 = shaky, 3 = solid. Three levels because a finer
    # scale invites deliberation without improving the signal.
    self_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    revealed_answer: Mapped[bool] = mapped_column(Boolean, default=False)

    # ── Timer ────────────────────────────────────────────────────────────
    #
    # Set once, on first open. Not reset on a later visit: the point is how long
    # this question took you the first time, and a timer that restarts every
    # time you reopen the tab measures nothing.
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Accumulated seconds, written by the client on submit and on leaving.
    # Stored rather than derived from `started_at` because wall-clock since
    # first open counts the two days you left the tab open, which is not the
    # number anyone wants.
    elapsed_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # First successful submit. Gates the AI tutor: no hints while you are being
    # assessed, help afterwards. Null means never submitted.
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    attempted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    question: Mapped["InterviewQuestion"] = relationship(back_populates="attempts")


# ── Daily challenge delivery ─────────────────────────────────────────────────


class DailyDelivery(Base):
    """
    One daily-challenge email, and the single-use link it carried.

    ONLY THE TOKEN HASH IS STORED. A link that arrives by email must not be
    reconstructable from a database read — that is the same reasoning as never
    storing a password. The plaintext exists once, inside the email.

    The link is also NOT an authentication factor. It resolves to a problem and
    redirects; a signed-out visitor is sent to /login with a callbackUrl. An
    inbox is not a credential, and a forwarded email must not become account
    access.
    """

    __tablename__ = "daily_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    problem_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("problems.id", ondelete="CASCADE")
    )

    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    sent_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
