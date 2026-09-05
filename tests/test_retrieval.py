"""V2 retrieval: the refusals matter more than the ranking.

A tutor that cites a superseded document, or cites unrelated material because top-k always returns
k things, is worse than one that says it has no source — both answers carry identical authority and
one of them is wrong. The learner cannot tell, which is the whole reason this phase exists.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.retrieval import (
    build_context,
    cosine_similarity,
    parse_embedding,
    retrieve,
)


@dataclass
class FakeDoc:
    slug: str
    embedding: str | None
    is_current: bool = True
    embedding_dim: int | None = 3
    title: str = "T"
    body: str = "BODY"

    def citation(self) -> str:
        return f"{self.title} — 2024-05-01"


Q = [1.0, 0.0, 0.0]


def test_an_aligned_document_is_returned() -> None:
    hits = retrieve(Q, [FakeDoc("aligned", "[1.0, 0.0, 0.0]")])
    assert [h.document.slug for h in hits] == ["aligned"]
    assert hits[0].similarity == pytest.approx(1.0)


def test_a_superseded_document_never_ranks() -> None:
    """Even a perfect match. A citation to something the corpus itself replaced carries the same
    authority as a correct one and is wrong."""
    assert retrieve(Q, [FakeDoc("old", "[1.0, 0.0, 0.0]", is_current=False)]) == []


def test_an_unembedded_document_is_skipped_not_crashed_on() -> None:
    hits = retrieve(Q, [FakeDoc("pending", None), FakeDoc("ready", "[1.0, 0.0, 0.0]")])
    assert [h.document.slug for h in hits] == ["ready"]


def test_an_uncovered_query_returns_nothing_rather_than_the_least_irrelevant() -> None:
    """The rule that stops manufactured answers. Top-k always returns k things; a threshold is what
    lets the tutor say it has no source."""
    orthogonal = FakeDoc("unrelated", "[0.0, 1.0, 0.0]")
    assert retrieve(Q, [orthogonal]) == []
    # …and the same document IS returned if the caller lowers the bar deliberately.
    assert len(retrieve(Q, [orthogonal], min_similarity=-1.0)) == 1


def test_a_dimension_mismatch_raises_rather_than_ranking() -> None:
    """Mixing embedding models does not make similarities worse, it makes them meaningless. This
    is the failure that reads as 'retrieval degraded' for weeks."""
    with pytest.raises(ValueError, match="dim"):
        retrieve(Q, [FakeDoc("wrong", "[1.0, 0.0]", embedding_dim=2)])


def test_a_corrupt_embedding_drops_the_row_not_the_query() -> None:
    """One bad row is a corrupt record, not a caller error; it should fall out of the pool rather
    than take down every query touching the corpus."""
    hits = retrieve(Q, [FakeDoc("corrupt", "[not, a, number]"), FakeDoc("ok", "[1.0, 0.0, 0.0]")])
    assert [h.document.slug for h in hits] == ["ok"]


def test_ties_break_deterministically() -> None:
    """Otherwise the same query cites different documents on different days and no complaint is
    reproducible."""
    docs = [FakeDoc("b", "[1.0, 0.0, 0.0]"), FakeDoc("a", "[1.0, 0.0, 0.0]")]
    assert [h.document.slug for h in retrieve(Q, docs)] == ["a", "b"]
    assert [h.document.slug for h in retrieve(Q, list(reversed(docs)))] == ["a", "b"]


def test_top_k_is_respected() -> None:
    docs = [FakeDoc(f"d{i}", "[1.0, 0.0, 0.0]") for i in range(10)]
    assert len(retrieve(Q, docs, top_k=3)) == 3


def test_skips_are_reported_not_silent() -> None:
    """An operator must be able to tell 'no good match' from 'nothing was embedded'. Silent
    filtering makes a misconfigured corpus look correctly configured and merely unhelpful."""
    seen: list[tuple[str, str]] = []
    retrieve(Q, [FakeDoc("old", "[1.0,0.0,0.0]", is_current=False), FakeDoc("pending", None)],
             on_skip=lambda d, why: seen.append((d.slug, why)))
    assert dict(seen) == {"old": "superseded", "pending": "not embedded"}


def test_every_hit_carries_its_citation() -> None:
    """A retrieved fact without attribution is indistinguishable from an invented one."""
    hit = retrieve(Q, [FakeDoc("aligned", "[1.0, 0.0, 0.0]")])[0]
    assert "BODY" in hit.cited() and "2024-05-01" in hit.cited()


def test_empty_context_is_a_real_state() -> None:
    """The prompt must treat 'no source' as an answer, not paper over it."""
    assert build_context([]) == ""


def test_a_zero_vector_scores_zero_rather_than_raising() -> None:
    assert cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_parse_embedding_handles_the_empty_and_malformed_cases() -> None:
    assert parse_embedding(None) is None
    assert parse_embedding("[]") is None
    assert parse_embedding("garbage") is None
    assert parse_embedding("[1.5, -2.0]") == [1.5, -2.0]


# ── grounding the tutor prompt ────────────────────────────────────────────────────────────────

def flat(text: str) -> str:
    """Collapse whitespace before asserting on prompt text.

    Prompt paragraphs get rewrapped, and a test that matches raw substrings breaks on a reflow
    that changed nothing semantically. The first version of these asserted on "Do not invent a
    citation" and failed because the phrase wraps across two lines.
    """
    return " ".join(text.split())


def test_grounded_prompt_carries_the_material_and_asks_for_citations() -> None:
    from features.retrieval import ground_prompt

    hits = retrieve(Q, [FakeDoc("aligned", "[1.0, 0.0, 0.0]")])
    out = flat(ground_prompt("BASE PROMPT", hits))
    assert "BASE PROMPT" in out
    assert "BODY" in out and "2024-05-01" in out
    assert "Cite what you take from it" in out


def test_an_empty_result_still_changes_the_prompt() -> None:
    """The case most likely to be handled by omission, and the one that matters most.

    Appending nothing when retrieval finds nothing leaves the model answering from weights with no
    signal to hedge — exactly the state V2 exists to fix. It must be told to flag time-sensitive
    claims instead.
    """
    from features.retrieval import ground_prompt

    out = flat(ground_prompt("BASE PROMPT", []))
    assert "BASE PROMPT" in out
    assert "No reference material was found" in out
    assert "Do not invent a citation" in out


def test_grounding_appends_rather_than_replaces() -> None:
    """The mode prompts carry the teaching behaviour and the fine-tuned adapter is bound to their
    exact text. Appending is safe where editing is not — a small drift has already produced
    garbage output once in this project."""
    from features.retrieval import ground_prompt

    base = "PE_TEACHING_PROMPT verbatim text"
    assert ground_prompt(base, []).startswith(base)
    assert ground_prompt(base, retrieve(Q, [FakeDoc("a", "[1.0,0.0,0.0]")])).startswith(base)
