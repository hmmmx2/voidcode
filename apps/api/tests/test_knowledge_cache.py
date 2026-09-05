"""Tests for the knowledge corpus snapshot. V2.

**No test would previously have failed if the corpus were empty in production.** That is the gap
these close, and it is the reason `_iter_knowledge_documents()` could sit returning a hardcoded `[]`
while `tests/test_retrieval.py` (16 tests) and `tests/test_knowledge_corpus.py` (8 tests) all
passed: they test ranking and the ORM model, and neither touches the join between them.

So the assertions here are about the *wiring*, not the ranking:
  - a loaded document is shaped so `retrieve()` can actually rank it
  - a load failure degrades to empty rather than raising into the chat endpoint
  - "loaded zero documents" and "failed to load" stay distinguishable, because they look identical
    at the answer and need completely different fixes
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# `features/` lives at the repo root, outside the api package — the same reach main.py makes for
# prompts.py. Without it this file imports fine and the protocol test below cannot run, which is
# precisely the in-container failure it exists to catch.
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from src import knowledge_cache  # noqa: E402
from src.knowledge_cache import CachedDocument  # noqa: E402


class _FailingSession:
    """A session factory whose context manager raises, standing in for a database that is down."""

    def __call__(self):
        return self

    async def __aenter__(self):
        raise ConnectionError("database is down")

    async def __aexit__(self, *exc):
        return False


def _doc(slug="rope", dim=768, embedding="[0.1, 0.2]"):
    return CachedDocument(
        slug=slug, title="RoPE", body="Rotary position embeddings...",
        is_current=True, embedding=embedding, embedding_dim=dim,
        _citation="RoPE — arXiv — 2021-04-20",
    )


def test_documents_is_empty_and_safe_before_any_load():
    """`_ground()` calls this on the chat hot path. Raising here would 500 the endpoint; the
    fail-open contract requires an empty list."""
    knowledge_cache._DOCUMENTS = []
    assert knowledge_cache.documents() == []


def test_a_cached_document_satisfies_the_retrieval_protocol():
    """`features.retrieval.Document` is a Protocol, so a missing attribute fails at call time inside
    the broad except in `_ground()` — logged, swallowed, and served ungrounded. Checking the shape
    here is what turns that into a test failure instead."""
    from features.retrieval import retrieve

    doc = _doc(embedding="[1.0, 0.0]", dim=2)
    hits = retrieve([1.0, 0.0], [doc], min_similarity=0.5)
    assert len(hits) == 1
    assert hits[0].document.slug == "rope"
    assert "2021-04-20" in hits[0].cited()


def test_citation_is_stored_not_recomputed():
    """ORM instances are deliberately not cached — a detached KnowledgeDocument raises
    DetachedInstanceError on the first lazy read, inside the except that degrades to ungrounded."""
    assert _doc().citation() == "RoPE — arXiv — 2021-04-20"
    bare = CachedDocument(slug="s", title="Fallback Title", body="b", is_current=True,
                          embedding=None, embedding_dim=None)
    assert bare.citation() == "Fallback Title"


@pytest.mark.asyncio
async def test_a_database_failure_degrades_to_empty_rather_than_raising():
    """A corpus that cannot load must cost citations, not availability."""
    knowledge_cache._DOCUMENTS = [_doc()]
    loaded = await knowledge_cache.load(_FailingSession())
    assert loaded == 0
    assert knowledge_cache.stats()["loaded"] is False
    assert "ConnectionError" in knowledge_cache.stats()["reason"]


def test_stats_distinguishes_empty_from_failed():
    """The distinction that matters operationally. Both produce ungrounded answers; one needs a
    seed run and the other needs a database. Collapsing them into "no documents" hides which."""
    knowledge_cache._STATS = {"loaded": True, "documents": 0, "reason": "no current, embedded docs"}
    empty = knowledge_cache.stats()
    knowledge_cache._STATS = {"loaded": False, "documents": 0, "reason": "OperationalError: ..."}
    failed = knowledge_cache.stats()
    assert empty["loaded"] is True and failed["loaded"] is False
    assert empty["documents"] == failed["documents"] == 0


def test_stats_returns_a_copy_so_callers_cannot_corrupt_it():
    """`stats()` is exposed on a diagnostics endpoint; handing out the live dict would let a caller
    mutate the module's own state."""
    knowledge_cache._STATS = {"loaded": True, "documents": 3}
    knowledge_cache.stats()["documents"] = 999
    assert knowledge_cache.stats()["documents"] == 3
