"""Load the retrieval corpus from versioned files. V2.

    from features.knowledge_corpus import load_documents
    docs = load_documents()          # validates and raises on the first bad file

WHY THE CORPUS MOVED OUT OF PYTHON
------------------------------------
It was a `DOCS: list[dict]` of ten entries inside `scripts/seed_knowledge.py`, with each body as a
triple-quoted string. That works at ten and fails at a hundred, for the same reasons the problem
catalogue was moved to `content/problems/*.yaml`:

  * **A factual correction becomes a code diff.** Retrieval exists precisely because this material
    goes stale — attention variants, quantization schemes and serving stacks churn continuously —
    so editing a claim is the common operation, not the rare one. It should be reviewable by
    someone who does not read Python.
  * **Nothing validated the concept id.** A typo'd `concept_id` seeded cleanly and then matched
    nothing, which looks identical to "no relevant document exists".
  * **A missing date or source could not be caught before it was in the database.** Every claim the
    tutor cites needs a source and a date or the citation is decoration.

THE FORMAT IS MARKDOWN WITH YAML FRONTMATTER
----------------------------------------------
    ---
    title: Grouped-query attention and KV cache size
    concept_id: attention_variants
    source_name: Ainslie et al., GQA (EMNLP 2023)
    source_url: https://arxiv.org/abs/2305.13245
    published_at: 2023-05-22
    ---

    Body paragraphs, blank-line separated.

The slug is the filename, so it cannot disagree with its own metadata — the same rule
`features/content.py` enforces for problems, and for the same reason.

Paragraph structure is load-bearing rather than cosmetic: `features/knowledge_ingest.chunk_text`
splits on blank lines and never splits mid-paragraph, so a wall of text becomes one oversized chunk
and a well-broken document becomes several retrievable ones.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CORPUS_ROOT = ROOT / "data" / "knowledge"

#: Every one is required. A document without a source and a date can still be retrieved, and then
#: the tutor cites something undated — which is worse than not citing, because it looks checked.
REQUIRED = ("title", "concept_id", "source_name", "source_url", "published_at")


class CorpusError(ValueError):
    """Raised on the first bad document. Never skipped: a silently dropped document is
    indistinguishable from one that simply does not match the query."""


@dataclass(frozen=True)
class Document:
    slug: str
    title: str
    concept_id: str
    source_name: str
    source_url: str
    published_at: str
    body: str

    def as_ingest_kwargs(self) -> dict:
        """Shaped for `features.knowledge_ingest.ingest`.

        `published_at` is converted to a `datetime` here rather than passed through as the ISO
        string it is stored as. The column is a TIMESTAMP, and asyncpg rejects a `str` for it —
        loudly, which is the good case. Keeping the string on the dataclass is deliberate: it is
        what the file says and what validation checks, and this is the single boundary where the
        database's type applies.
        """
        return {
            "slug": self.slug, "title": self.title, "text": self.body,
            "concept_id": self.concept_id, "source_url": self.source_url,
            "source_name": self.source_name,
            "published_at": _dt.datetime.fromisoformat(self.published_at),
        }


def _parse(path: Path) -> tuple[dict, str]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        raise CorpusError(f"{path.name}: missing YAML frontmatter")
    _, _, rest = raw.partition("---")
    front, sep, body = rest.partition("\n---")
    if not sep:
        raise CorpusError(f"{path.name}: frontmatter is not terminated by ---")
    meta = yaml.safe_load(front) or {}
    if not isinstance(meta, dict):
        raise CorpusError(f"{path.name}: frontmatter is not a mapping")
    return meta, body.strip()


def load_documents(root: Path | None = None, *, validate_concepts: bool = True) -> list[Document]:
    """Every document, validated. Raises `CorpusError` on the first problem.

    `validate_concepts` reads the taxonomy, which is the check that matters most: a document tagged
    with a concept that does not exist is retrievable in principle and dead in practice, and the
    symptom — no citations for that topic — points at retrieval rather than at the tag.
    """
    root = root or CORPUS_ROOT
    if not root.is_dir():
        raise CorpusError(f"no corpus directory at {root}")

    known: set[str] = set()
    if validate_concepts:
        from features.taxonomy import load_taxonomy

        known = set(load_taxonomy().concepts)

    docs: list[Document] = []
    seen: set[str] = set()
    for path in sorted(root.glob("*.md")):
        meta, body = _parse(path)
        slug = path.stem
        missing = [k for k in REQUIRED if not str(meta.get(k, "")).strip()]
        if missing:
            raise CorpusError(f"{path.name}: missing or empty {missing}")
        if not body:
            raise CorpusError(f"{path.name}: empty body")
        if slug in seen:
            raise CorpusError(f"{path.name}: duplicate slug {slug!r}")
        seen.add(slug)

        published = str(meta["published_at"])
        try:
            _dt.date.fromisoformat(published)
        except ValueError as exc:
            raise CorpusError(
                f"{path.name}: published_at {published!r} is not ISO YYYY-MM-DD") from exc

        concept = str(meta["concept_id"]).strip()
        if validate_concepts and concept not in known:
            raise CorpusError(
                f"{path.name}: concept_id {concept!r} is not in data/concepts.yaml. A document "
                "tagged with an unknown concept seeds cleanly and then matches nothing.")

        url = str(meta["source_url"]).strip()
        if not url.startswith(("http://", "https://")):
            raise CorpusError(f"{path.name}: source_url {url!r} is not an http(s) URL")

        docs.append(Document(
            slug=slug, title=str(meta["title"]).strip(), concept_id=concept,
            source_name=str(meta["source_name"]).strip(), source_url=url,
            published_at=published, body=body,
        ))

    if not docs:
        raise CorpusError(f"no *.md documents in {root}")
    return docs


def coverage(docs: list[Document] | None = None) -> dict[str, list[str]]:
    """concept_id -> slugs. Shows which concepts the tutor can cite anything for at all."""
    docs = docs if docs is not None else load_documents()
    out: dict[str, list[str]] = {}
    for d in docs:
        out.setdefault(d.concept_id, []).append(d.slug)
    return out
