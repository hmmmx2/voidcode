"""V2 ingest: chunking is where the retrievable-but-unfindable failures come from.

A chunk is the unit of citation. Two failures matter and both are silent — the document is in the
corpus, the query is reasonable, and either nothing comes back or the wrong half does.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.knowledge_ingest import (
    Chunk,
    chunk_text,
    ingest,
    split_paragraphs,
    supersede,
)


def fake_embedder(text: str):
    """Deterministic and dimension-stable. The real one is injected; which model is not decided
    in this module, which is the point."""
    return [float(len(text) % 7), 1.0, 0.0]


def test_paragraphs_are_not_split_mid_paragraph() -> None:
    """Cutting a paragraph to satisfy a byte count is the split-claim failure the overlap exists to
    prevent. Doing it deliberately would be worse than the size."""
    long_para = "x" * 5000
    chunks = chunk_text(long_para, max_chars=100)
    assert chunks == [long_para]


def test_chunks_pack_up_to_the_limit() -> None:
    text = "\n\n".join(["a" * 400] * 10)
    chunks = chunk_text(text, max_chars=1000, overlap_chars=0)
    assert len(chunks) > 1
    assert all(len(c) <= 1400 for c in chunks)


def test_overlap_keeps_a_boundary_claim_retrievable() -> None:
    """The silent failure: a claim split across a boundary scores in neither half, so nothing is
    returned even though the document is present and the query is fine."""
    paras = [f"para {i} " + "w" * 300 for i in range(6)]
    text = "\n\n".join(paras)
    with_overlap = chunk_text(text, max_chars=700, overlap_chars=400)
    without = chunk_text(text, max_chars=700, overlap_chars=0)
    joined_with = " ".join(with_overlap)
    # Overlap means some paragraph text appears in two chunks; without, each appears once.
    assert len(joined_with) > len(" ".join(without))


def test_empty_input_yields_no_chunks() -> None:
    assert chunk_text("") == []
    assert chunk_text("   \n\n  ") == []


def test_ingest_names_the_chunk_not_the_document() -> None:
    """Pointing a reader at a 4,000-word page and asking them to find the claim is not a citation."""
    text = "\n\n".join(["p" * 900 for _ in range(4)])
    chunks = ingest(slug="awq", title="AWQ", text=text, embedder=fake_embedder, max_chars=1000)
    assert len(chunks) > 1
    assert [c.slug for c in chunks][:2] == ["awq#0", "awq#1"]


def test_ingest_records_the_dimension_it_actually_produced() -> None:
    """Recorded per row, not assumed globally: a corpus holding two dimensionalities returns
    meaningless neighbours rather than worse ones."""
    chunks = ingest(slug="d", title="D", text="one\n\ntwo", embedder=fake_embedder)
    assert all(c.embedding_dim == 3 for c in chunks)
    assert all(c.embedding and c.embedding.startswith("[") for c in chunks)


def test_ingest_carries_the_citation_metadata_onto_every_chunk() -> None:
    """Every chunk is independently retrievable, so every chunk needs its own attribution — a
    citation that only exists on chunk 0 is missing from every answer that retrieves chunk 3."""
    when = datetime(2024, 5, 1)
    chunks = ingest(slug="awq", title="AWQ", text="a\n\nb", embedder=fake_embedder,
                    source_url="https://arxiv.org/abs/2306.00978", source_name="MLSys 2024",
                    published_at=when, concept_id="quantization_schemes")
    for c in chunks:
        assert c.source_url and c.source_name and c.published_at == when
        assert c.concept_id == "quantization_schemes"


def test_supersede_retires_rather_than_deletes() -> None:
    """An answer given last month cited the old chunk. That citation must still resolve to
    something explaining what replaced it, or the trail simply ends."""
    old = [Chunk(slug="awq#0", title="AWQ", body="old", ordinal=0, version=1)]
    new = [Chunk(slug="awq#0", title="AWQ", body="new", ordinal=0)]
    plan = supersede(old, new)
    assert plan.retire_slugs == ["awq#0"]
    assert plan.new_rows[0]["is_current"] is True
    assert plan.new_rows[0]["body"] == "new"


def test_supersede_bumps_past_the_highest_existing_version() -> None:
    """So an accidental re-ingest creates a new version rather than silently overwriting the one
    people have already been served."""
    old = [Chunk(slug="a#0", title="A", body="v1", ordinal=0, version=1),
           Chunk(slug="a#0", title="A", body="v2", ordinal=0, version=2)]
    plan = supersede(old, [Chunk(slug="a#0", title="A", body="v3", ordinal=0)])
    assert plan.new_rows[0]["version"] == 3


def test_split_paragraphs_drops_blank_runs() -> None:
    assert split_paragraphs("a\n\n\n\nb") == ["a", "b"]
