"""Hold the knowledge corpus in memory so synchronous retrieval can reach it. V2.

THE BLOCKER THIS REMOVES
--------------------------
`main._iter_knowledge_documents()` returned `[]`. Not as a bug — as a stub, with a docstring saying
"empty until the corpus is populated". The consequence was that `retrieve()` always received an
empty pool, always returned no hits, and every grounded turn fell back to the ungrounded
instruction. **Growing the corpus would have changed nothing**, because nothing read it.

That is this project's most common fault, again: the ranking, the prompt composition, the mode
gating and the fail-open behaviour were all written and tested, and the one line that connects them
to the data was missing.

WHY A SNAPSHOT RATHER THAN A QUERY PER TURN
---------------------------------------------
`_ground()` is synchronous, called from `prepare_messages_hybrid`, while the database is
`AsyncSession`. That mismatch is most likely why the stub was left in place — there is no clean way
to await inside that call.

A startup snapshot removes the problem instead of working around it, and it costs nothing this
design was not already paying: `features/retrieval.retrieve()` computes cosine similarity in Python
across every candidate, so the full corpus is walked on every query regardless. Holding it in memory
turns a per-turn database round trip into an attribute read on the hot path of the most
latency-sensitive endpoint in the product.

**The trade is staleness, and it is real.** A re-seeded corpus is invisible until the process
restarts. That is acceptable for content that changes on a human timescale and is reviewed in pull
requests, and `reload()` exists so a caller can refresh without a restart. It is recorded here
rather than discovered later.

DETACHED BY CONSTRUCTION
--------------------------
ORM instances are **not** cached. A `KnowledgeDocument` outliving its session raises
`DetachedInstanceError` on the first lazy attribute read — inside `_ground()`, which catches
everything and degrades to ungrounded, so the corpus would appear empty with only a log line to say
otherwise. `CachedDocument` is a frozen dataclass holding plain values, with the citation string
rendered at load time rather than recomputed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

#: Populated by `load()`. Module-level rather than passed around because the sync retrieval path has
#: no object to hang it off — that is the whole constraint this module exists under.
_DOCUMENTS: list[CachedDocument] = []
_STATS: dict = {"loaded": False, "documents": 0, "reason": "not loaded yet"}


@dataclass(frozen=True)
class CachedDocument:
    """Satisfies `features.retrieval.Document` with plain values and no session.

    `citation` is a stored string, not a method computing from ORM state, so the rendering logic
    stays in one place (`KnowledgeDocument.citation()`) and cannot drift between the two.
    """

    slug: str
    title: str
    body: str
    is_current: bool
    embedding: str | None
    embedding_dim: int | None
    _citation: str = field(default="")

    def citation(self) -> str:
        return self._citation or self.title


def documents() -> list[CachedDocument]:
    """The corpus for `retrieve()`. Empty list when unloaded — never raises.

    Returning empty rather than raising keeps the fail-open contract in `_ground()`: an unreachable
    corpus must degrade to an ungrounded answer, not a 500 in the chat endpoint.
    """
    return _DOCUMENTS


def stats() -> dict:
    """Whether the corpus loaded, and how much of it. For the diagnostics endpoint.

    `loaded` and `documents` are separate fields on purpose. A successful load of an EMPTY corpus is
    not the same as a failed load, and reporting both as "no documents" is how a broken seed looks
    identical to an unseeded database.
    """
    return dict(_STATS)


async def load(session_factory) -> int:
    """Snapshot every retrievable document. Returns the count loaded.

    Retrievable means current AND embedded — the same condition
    `KnowledgeDocument.is_retrievable` encodes. Filtering here rather than in `retrieve()` keeps
    superseded and unembedded rows off the hot path entirely; `retrieve()` still re-checks, because
    it is used directly in tests and must not depend on its caller having filtered.

    Never raises. A database that is down at startup must not stop the API serving chat.
    """
    global _DOCUMENTS, _STATS
    try:
        from sqlalchemy import select

        from .models.knowledge import KnowledgeDocument

        async with session_factory() as session:
            rows = (await session.execute(
                select(KnowledgeDocument).where(
                    KnowledgeDocument.is_current.is_(True),
                    KnowledgeDocument.embedding.isnot(None),
                )
            )).scalars().all()

            cached = [
                CachedDocument(
                    slug=row.slug,
                    title=row.title,
                    body=row.body,
                    is_current=bool(row.is_current),
                    embedding=row.embedding,
                    embedding_dim=row.embedding_dim,
                    _citation=row.citation(),
                )
                for row in rows
            ]
    except Exception as exc:  # the corpus must never break startup
        log.warning("knowledge corpus did not load (%s); answers will be ungrounded", exc)
        _STATS = {"loaded": False, "documents": 0, "reason": f"{type(exc).__name__}: {exc}"}
        return 0

    _DOCUMENTS = cached
    _STATS = {
        "loaded": True,
        "documents": len(cached),
        # Dimension agreement is worth surfacing: `retrieve()` RAISES on a mismatch with the query
        # vector rather than ranking badly, because mixed embedders produce meaningless neighbours
        # rather than merely worse ones. Two values here means a re-embed is half done.
        "embedding_dims": sorted({d.embedding_dim for d in cached if d.embedding_dim}),
        "reason": "ok" if cached else "no current, embedded documents in knowledge_documents",
    }
    if not cached:
        log.warning("knowledge corpus loaded 0 documents; every answer will be ungrounded")
    else:
        log.info("knowledge corpus loaded: %d documents", len(cached))
    return len(cached)


async def reload(session_factory) -> int:
    """Re-snapshot after a re-seed, without a process restart."""
    return await load(session_factory)
