"""V2 — the retrieval corpus: dated, versioned, citable documents.

WHY RETRIEVAL RATHER THAN WEIGHTS, FOR THIS DOMAIN SPECIFICALLY
-----------------------------------------------------------------
The older specs argued against retrieval, and that reasoning was sound *for algorithms*: binary
search does not change. It is void here. Attention variants, quantization schemes, CUDA occupancy
rules and model families churn continuously, and a tutor that holds those in weights will teach
superseded material confidently.

The learner cannot detect the error — someone preparing for an interview does not yet know enough
to catch it. So it lands in their interview instead, which is the actual failure mode this phase
exists to prevent, and it is worse than an unhelpful answer because it is delivered with the same
authority as a correct one.

**No deliberately placed factual content in the weights, ever.** Fine-tune on behaviour and output
schema only. That rule is what makes a stale fact *fixable*: a wrong document can be corrected in
one row, where a wrong fact in the weights needs a retraining run and a re-evaluation.

WHAT EACH COLUMN IS LOAD-BEARING FOR
---------------------------------------
`source_url` and `published_at` are not metadata. A citation is what makes a stale entry findable
and replaceable, and a date is what lets a reader judge whether "the current best quantization
scheme" was current when it was written. Without both, the corpus decays into exactly the
confidently-wrong state that retrieval was adopted to avoid — just in a table instead of in
weights.

`superseded_by` exists because deletion loses the trail. When a document is replaced, an answer
citing the old one should be traceable to what replaced it rather than to nothing.

WHY THE EMBEDDING IS NULLABLE
--------------------------------
A document is authored and reviewed before it is embedded, and embedding needs a model that may
not be loaded at write time. Making it non-null would force the two to happen together and mean a
model outage blocks content review. Rows without embeddings are simply not retrievable yet, which
is the correct behaviour and is asserted in the tests.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

#: Dimension of the embedding this corpus is built against. Recorded per row rather than assumed
#: globally: swapping embedding models is routine, and a corpus holding two dimensionalities with
#: no way to tell them apart returns silently meaningless neighbours.
DEFAULT_EMBEDDING_DIM = 768


class KnowledgeDocument(Base):
    """One citable chunk of reference material."""

    __tablename__ = "knowledge_documents"
    __table_args__ = (
        UniqueConstraint("slug", "version", name="uq_knowledge_slug_version"),
        # Retrieval filters to current documents before ranking by distance, so the partial-ish
        # index leads on is_current.
        Index("ix_knowledge_current", "is_current", "concept_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    slug: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    #: Bumped on every substantive edit. With `is_current` this keeps the history rather than
    #: overwriting it — an answer given last month should remain explainable.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    title: Mapped[str] = mapped_column(String(256), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)

    #: The citation. Not optional in spirit — a claim the tutor cannot attribute is a claim it
    #: should not make — but nullable in the column so an internally-authored note can exist
    #: without a fake URL.
    source_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    #: What the reader needs to judge staleness. A quantization claim from 2023 and one from last
    #: month are not interchangeable, and only the date says so.
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    #: Ties a document to the taxonomy, same plain-string convention as `problem_concepts` — the
    #: taxonomy lives in reviewed YAML and mirroring it into a table would create a second source
    #: of truth that drifts.
    concept_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    embedding_dim: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Stored as text until pgvector is installed; see the migration. Nullable because a document
    #: is authored and reviewed before it is embedded, and a model outage must not block review.
    embedding: Mapped[str | None] = mapped_column(Text, nullable=True)

    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        # SET NULL, not CASCADE: losing the replacement should not delete the history that points
        # at it. Deletion here loses the trail, which is the thing versioning exists to keep.
        ForeignKey("knowledge_documents.id", ondelete="SET NULL"),
        nullable=True,
    )
    superseded_by: Mapped[KnowledgeDocument | None] = relationship(
        remote_side=[id], foreign_keys=[superseded_by_id]
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    @property
    def is_retrievable(self) -> bool:
        """A document joins the retrieval pool only when current and embedded.

        Both halves matter. Unembedded rows cannot be ranked, and superseded rows must not be
        returned — a citation to a document the corpus itself has replaced is worse than no
        citation, because it carries the same authority.
        """
        return bool(self.is_current and self.embedding and self.embedding_dim)

    def citation(self) -> str:
        """What the tutor appends to a claim. A retrieved fact without this is indistinguishable
        from a fact the model invented, which is the distinction the whole phase turns on."""
        parts = [self.title]
        if self.source_name:
            parts.append(self.source_name)
        if self.published_at:
            parts.append(self.published_at.strftime("%Y-%m-%d"))
        if self.source_url:
            parts.append(self.source_url)
        return " — ".join(parts)
