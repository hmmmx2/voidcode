"""V2 — turn authored reference material into retrievable documents.

Named `knowledge_ingest`, not `ingest`, because `features/ingest/` already exists: it is the Spark
pipeline's Codeforces fetch. A module and a package of the same name do not conflict loudly —
the package wins and the module becomes silently unimportable, which is how this file would have
been dead code with passing-looking tests.

Chunking, versioning and supersession. The embedder is injected: which model to use is not decided
here, and `embedding_dim` is recorded per row precisely because swapping models is routine and a
corpus holding two dimensionalities silently returns meaningless neighbours.

WHY CHUNKING IS NOT JUST SPLITTING
-------------------------------------
A chunk is the unit of citation, so a chunk that spans two topics produces a citation that is
half-relevant to whatever it was retrieved for — and the tutor will quote it anyway. Splitting on
paragraph boundaries rather than a fixed character count keeps a claim with its qualification,
which is what stops "quantization to 4 bits is lossless for most models" being retrieved without
the sentence that follows it.

Overlap exists for the opposite failure: a claim split across a boundary is retrievable from
neither half, because neither contains enough of it to score. That one is invisible — the document
is in the corpus, the query is reasonable, and nothing comes back.

SUPERSESSION IS AN UPDATE, NOT A DELETE
------------------------------------------
`supersede()` marks the old version `is_current=False` and points it at the new one. It never
deletes. An answer given last month cited a document, and that citation should still resolve to
something explaining what replaced it — otherwise the trail ends and a learner who followed a
recommendation cannot find out it changed.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime

#: Roughly 200-400 words. Long enough to carry a claim with its qualification, short enough that a
#: citation points at something a reader can check quickly.
DEFAULT_MAX_CHARS = 1800
#: One paragraph of overlap. A claim split across a boundary is retrievable from neither half, and
#: that failure is silent — the document is present, the query is fine, nothing returns.
DEFAULT_OVERLAP_CHARS = 200

Embedder = Callable[[str], Sequence[float]]


@dataclass
class Chunk:
    slug: str
    title: str
    body: str
    ordinal: int
    concept_id: str | None = None
    source_url: str | None = None
    source_name: str | None = None
    published_at: datetime | None = None
    embedding: str | None = None
    embedding_dim: int | None = None
    version: int = 1
    is_current: bool = True

    def as_row(self) -> dict:
        """The mapping a `KnowledgeDocument` is constructed from. Kept as a plain dict so ingest
        does not import the ORM — the chunking logic is where the mistakes are, and it should be
        testable without a database."""
        return {
            "slug": self.slug, "title": self.title, "body": self.body,
            "version": self.version, "is_current": self.is_current,
            "concept_id": self.concept_id, "source_url": self.source_url,
            "source_name": self.source_name, "published_at": self.published_at,
            "embedding": self.embedding, "embedding_dim": self.embedding_dim,
        }


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def chunk_text(text: str, max_chars: int = DEFAULT_MAX_CHARS,
               overlap_chars: int = DEFAULT_OVERLAP_CHARS) -> list[str]:
    """Split on paragraph boundaries, packing up to `max_chars`, with a tail of overlap.

    Never splits mid-paragraph even when a single paragraph exceeds `max_chars`. An oversized
    paragraph is emitted whole and the limit is treated as a target rather than a hard cap: cutting
    a paragraph in half to satisfy a byte count is exactly the split-claim failure the overlap
    exists to prevent, and doing it deliberately would be worse than the size.
    """
    paras = split_paragraphs(text)
    if not paras:
        return []

    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for para in paras:
        if current and size + len(para) > max_chars:
            chunks.append("\n\n".join(current))
            # Carry the tail forward so a claim spanning the boundary survives in both.
            tail, tail_len = [], 0
            for prev in reversed(current):
                if tail_len + len(prev) > overlap_chars:
                    break
                tail.insert(0, prev)
                tail_len += len(prev)
            current, size = list(tail), tail_len
        current.append(para)
        size += len(para)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def ingest(*, slug: str, title: str, text: str, embedder: Embedder,
           concept_id: str | None = None, source_url: str | None = None,
           source_name: str | None = None, published_at: datetime | None = None,
           version: int = 1, max_chars: int = DEFAULT_MAX_CHARS) -> list[Chunk]:
    """Chunk, embed, and return rows ready to insert.

    Chunk slugs are `"<slug>#<ordinal>"` so a citation names the *chunk* rather than the document.
    Pointing a reader at a 4,000-word page and asking them to find the claim is not a citation.
    """
    chunks: list[Chunk] = []
    for i, body in enumerate(chunk_text(text, max_chars=max_chars)):
        vector = list(embedder(body))
        chunks.append(Chunk(
            slug=f"{slug}#{i}", title=title, body=body, ordinal=i, concept_id=concept_id,
            source_url=source_url, source_name=source_name, published_at=published_at,
            version=version,
            embedding="[" + ", ".join(repr(float(x)) for x in vector) + "]",
            embedding_dim=len(vector),
        ))
    return chunks


@dataclass
class Supersession:
    """What to write when a document is replaced. Two updates, never a delete."""

    retire_slugs: list[str] = field(default_factory=list)
    new_rows: list[dict] = field(default_factory=list)


def supersede(existing: Sequence[Chunk], replacement: Sequence[Chunk]) -> Supersession:
    """Retire the old chunks and install the new ones at the next version.

    The old rows are marked `is_current=False`, not removed. An answer given last month cited one
    of them, and that citation should still resolve to something that explains what replaced it —
    otherwise the trail simply ends, and a learner who acted on a recommendation cannot discover
    it has changed.

    Version is one past the highest existing, so an accidental re-ingest of the same text creates
    a new version rather than silently overwriting the one people have already been served.
    """
    next_version = max((c.version for c in existing), default=0) + 1
    rows = []
    for c in replacement:
        row = c.as_row()
        row["version"] = next_version
        row["is_current"] = True
        rows.append(row)
    return Supersession(retire_slugs=[c.slug for c in existing], new_rows=rows)
