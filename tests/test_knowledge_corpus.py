"""V2: the retrieval corpus is citable, dated, and refuses to serve stale documents.

The phase exists because a tutor holding attention variants and quantization schemes in its
weights teaches superseded material confidently, to a learner who cannot detect the error. The
tests that matter are therefore not "can we store a document" but "can a stale one reach an
answer", and "can a claim arrive without attribution".
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from src.models import KnowledgeDocument  # noqa: E402


def doc(**kw) -> KnowledgeDocument:
    base = {"slug": "awq-vs-gptq", "version": 1, "is_current": True, "title": "AWQ vs GPTQ",
            "body": "...", "source_name": "MLSys 2024",
            "source_url": "https://arxiv.org/abs/2306.00978",
            "published_at": datetime(2024, 5, 1), "embedding": "[0.1,0.2]", "embedding_dim": 768}
    base.update(kw)
    return KnowledgeDocument(**base)


def test_a_current_embedded_document_is_retrievable() -> None:
    assert doc().is_retrievable


def test_an_unembedded_document_is_not_retrievable() -> None:
    """Authoring and embedding are separate steps — a document is reviewed before a model sees it,
    and a model outage must not block review. Unembedded rows simply are not in the pool yet."""
    assert not doc(embedding=None, embedding_dim=None).is_retrievable


def test_a_superseded_document_is_not_retrievable() -> None:
    """The one that matters. A citation to a document the corpus itself has replaced is worse than
    no citation, because it carries exactly the same authority."""
    assert not doc(is_current=False).is_retrievable


def test_the_citation_carries_source_and_date() -> None:
    """A retrieved fact without these is indistinguishable from one the model invented, which is
    the distinction this whole phase turns on."""
    c = doc().citation()
    assert "MLSys 2024" in c and "2024-05-01" in c and "arxiv.org" in c


def test_a_citation_degrades_rather_than_lies_when_metadata_is_absent() -> None:
    """An internally-authored note has no URL. It should cite as much as it honestly can rather
    than fabricate a source or omit the citation entirely."""
    c = doc(source_url=None, source_name=None, published_at=None).citation()
    assert c == "AWQ vs GPTQ"


def test_versions_of_one_slug_coexist() -> None:
    """Versioning keeps history rather than overwriting it: an answer given last month should stay
    explainable after the document behind it is replaced."""
    old, new = doc(version=1, is_current=False), doc(version=2, is_current=True)
    assert old.slug == new.slug and old.version != new.version
    assert not old.is_retrievable and new.is_retrievable


def test_slug_and_version_are_unique_together() -> None:
    names = {c.name for c in KnowledgeDocument.__table__.constraints if c.name}
    assert "uq_knowledge_slug_version" in names


def test_superseded_by_is_set_null_not_cascade() -> None:
    """Deleting a replacement must not delete the history pointing at it — that would lose exactly
    the trail versioning exists to keep."""
    fk = next(iter(KnowledgeDocument.__table__.foreign_keys))
    assert fk.ondelete == "SET NULL"
