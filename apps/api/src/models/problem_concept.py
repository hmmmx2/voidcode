"""The join between a problem and the taxonomy concepts it teaches.

WHY THIS TABLE DID NOT EXIST, AND WHY THAT MATTERED
------------------------------------------------------
Spec §4.2 asks for one to four concepts per problem and calls the taxonomy "the backbone of both
ranking and course generation". There was no such table and no `concept_id` anywhere, so the
backbone was attached to nothing: 144 concepts in `data/concepts.yaml`, 94 problems, and no way to
ask which problems teach a concept. That is the same criticism the repository audit levels at the
Spark pipeline — a well-built artefact joining to nothing.

Without it:

  * **Candidate generation cannot run.** Spec §5.1 retrieves against a learner's weakest concepts
    and walks the prerequisite graph. Both need this join.
  * **Mastery vectors have no target.** Per-learner per-concept mastery is computed by attributing
    submissions to concepts, which requires knowing what a problem teaches.
  * **Course assembly cannot order modules.** It groups by concept and orders by prerequisite.

WHY THE CONCEPT ID IS A STRING, NOT A FOREIGN KEY
----------------------------------------------------
The taxonomy lives in `data/concepts.yaml`, version-controlled and reviewed in pull requests, and
`features/taxonomy.py` validates it — the DAG assertion, the prerequisite resolution, the category
check. Mirroring it into a `concepts` table would create two sources of truth that drift, and the
one in the database would be the one nobody reviews.

So `concept_id` is a plain string, and referential integrity is enforced **at load** by
`features/content.py`, which refuses any item naming a concept the taxonomy does not define. That
is a deliberate trade: the check moves from the database to the loader, and the loader is covered
by tests that fire on a typo'd id.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


class ProblemConcept(Base):
    """One row per (problem, concept) pair. At most `max_concepts_per_problem` rows per problem."""

    __tablename__ = "problem_concepts"
    __table_args__ = (
        # A duplicated pair would double-count that concept in mastery attribution, silently
        # weighting one problem twice against a learner's estimate for it.
        UniqueConstraint("problem_id", "concept_id", name="uq_problem_concept"),
        # Ranking's hot path is "which problems teach concept X", not the reverse, so the index
        # leads on concept_id. The primary key on problem_id already serves the other direction.
        Index("ix_problem_concepts_concept", "concept_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    problem_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        # Cascade because a concept tag has no meaning without its problem. Leaving orphans would
        # let a deleted problem keep contributing to that concept's coverage count.
        ForeignKey("problems.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: A `data/concepts.yaml` concept id. Not a foreign key — see the module docstring.
    concept_id: Mapped[str] = mapped_column(String(64), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    problem: Mapped[Problem] = relationship(back_populates="concepts")  # noqa: F821
