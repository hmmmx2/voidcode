"""Tests for the file-backed retrieval corpus. V2.

The corpus used to be a Python list with no validation at all: a typo'd `concept_id` seeded cleanly
and then matched nothing, which at query time is indistinguishable from "no relevant document
exists". These assert that each way a document can be quietly useless is now loud instead.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from features.knowledge_corpus import (  # noqa: E402
    REQUIRED,
    CorpusError,
    coverage,
    load_documents,
)

GOOD = """---
title: A title
concept_id: kv_cache
source_name: Someone et al.
source_url: https://arxiv.org/abs/1234.56789
published_at: 2023-01-15
---

First paragraph.

Second paragraph.
"""


def write(tmp_path: Path, name: str, text: str) -> Path:
    (tmp_path / name).write_text(text, encoding="utf-8")
    return tmp_path


# ── the shipped corpus ───────────────────────────────────────────────────────

def test_the_real_corpus_loads_and_every_concept_resolves():
    """The check the hardcoded list never had. A document tagged with a concept that is not in
    data/concepts.yaml is retrievable in principle and dead in practice."""
    docs = load_documents()
    assert len(docs) >= 30
    assert all(d.concept_id and d.source_url.startswith("https://") for d in docs)


def test_every_document_carries_a_source_and_a_date():
    """Without both, a citation is decoration: nothing says whether the claim was current when it
    was written, and nothing lets a stale entry be found and replaced."""
    for d in load_documents():
        assert d.source_name.strip(), d.slug
        assert d.published_at.strip(), d.slug


def test_bodies_have_paragraph_breaks():
    """`chunk_text` splits on blank lines and never splits mid-paragraph, so a wall of text becomes
    one oversized chunk. Structure here is load-bearing, not cosmetic."""
    for d in load_documents():
        assert "\n\n" in d.body, f"{d.slug} is a single paragraph and will not chunk"


def test_coverage_is_one_document_per_concept_or_more():
    cov = coverage()
    assert len(cov) >= 25
    assert all(slugs for slugs in cov.values())


# ── the refusals ─────────────────────────────────────────────────────────────

def test_an_unknown_concept_id_is_refused(tmp_path):
    """The failure that motivated moving out of Python: it used to seed cleanly and match nothing."""
    root = write(tmp_path, "x.md", GOOD.replace("kv_cache", "not_a_real_concept"))
    with pytest.raises(CorpusError, match=re.escape("not in data/concepts.yaml")):
        load_documents(root)


@pytest.mark.parametrize("field", REQUIRED)
def test_a_missing_required_field_is_refused(tmp_path, field):
    body = "\n".join(line for line in GOOD.splitlines() if not line.startswith(f"{field}:"))
    root = write(tmp_path, "x.md", body + "\n")
    with pytest.raises(CorpusError, match="missing or empty"):
        load_documents(root)


def test_a_non_iso_date_is_refused(tmp_path):
    """Freshness triage is the whole point of the date; an unparseable one silently disables it."""
    root = write(tmp_path, "x.md", GOOD.replace("2023-01-15", "January 2023"))
    with pytest.raises(CorpusError, match="not ISO"):
        load_documents(root)


def test_a_non_http_source_url_is_refused(tmp_path):
    root = write(tmp_path, "x.md", GOOD.replace("https://arxiv.org/abs/1234.56789", "see the paper"))
    with pytest.raises(CorpusError, match="not an http"):
        load_documents(root)


def test_missing_frontmatter_is_refused(tmp_path):
    root = write(tmp_path, "x.md", "Just a body with no metadata at all.\n")
    with pytest.raises(CorpusError, match="frontmatter"):
        load_documents(root)


def test_an_empty_body_is_refused(tmp_path):
    root = write(tmp_path, "x.md", GOOD.split("---\n\n")[0] + "---\n\n   \n")
    with pytest.raises(CorpusError, match="empty body"):
        load_documents(root)


def test_an_empty_directory_is_refused(tmp_path):
    """An empty corpus loading successfully is how retrieval silently becomes a no-op."""
    with pytest.raises(CorpusError, match=re.escape("no *.md documents")):
        load_documents(tmp_path)


def test_published_at_converts_to_datetime_for_the_database(tmp_path):
    """The column is a TIMESTAMP and asyncpg rejects a str for it. Caught in the first seed run;
    this pins the conversion so it cannot regress into a runtime DataError."""
    import datetime

    root = write(tmp_path, "x.md", GOOD)
    kwargs = load_documents(root)[0].as_ingest_kwargs()
    assert isinstance(kwargs["published_at"], datetime.datetime)
