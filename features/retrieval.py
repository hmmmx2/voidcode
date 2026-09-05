"""V2 — retrieve citable documents, and refuse to serve stale ones.

The corpus lives in `knowledge_documents` (see `apps/api/src/models/knowledge.py`). This module is
the read path: turn a query embedding into a small set of documents the tutor may cite.

WHAT THIS DELIBERATELY DOES NOT DO
-------------------------------------
It does not talk to the database, and it does not embed. Both are injected. That is not
architectural taste — it is what makes the ranking testable without Postgres, pgvector, or a model,
and the ranking is where the mistakes live. A retrieval layer that can only be tested end-to-end
gets tested rarely.

THE THREE RULES THAT MATTER, AND WHY EACH IS HERE RATHER THAN IN THE CALLER
-----------------------------------------------------------------------------
1. **Superseded documents never rank.** A citation to something the corpus itself replaced is
   worse than no citation: it carries identical authority and is wrong. Filtering in the caller
   means every caller must remember; filtering here means none can forget.

2. **A minimum similarity, not just a top-k.** Top-k always returns k things. Ask about something
   the corpus does not cover and you get the k least-irrelevant documents, which the tutor will
   then cite — manufacturing a confident answer from unrelated material. Returning nothing is the
   correct behaviour for an uncovered question, and it is the behaviour that lets the tutor say
   "I don't have a source for that".

3. **Dimension mismatches raise rather than rank.** Swapping embedding models is routine, and a
   corpus holding two dimensionalities silently returns meaningless neighbours — cosine similarity
   between vectors of different length is not a smaller number, it is a different question. This
   is the failure that looks like "retrieval got worse" for weeks.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Protocol

#: Measured, not guessed. Against nomic-embed-text on this corpus:
#:
#:   on-topic  top-1 similarity   0.560 - 0.739   (6 real questions)
#:   off-topic top-1 similarity   0.357 - 0.496   (sourdough, tyres, football, hiking)
#:
#: The first value here was 0.35, chosen by intuition before the corpus existed. It admitted
#: 4 of 4 off-topic queries — the tutor would have cited a KV-cache paper at someone asking about
#: bread.
#:
#: IT WAS THEN 0.50, AND 0.50 SAT ON THE EDGE OF A CLIFF. Re-measured against the live corpus and
#: embedder (8 on-topic, 5 off-topic questions):
#:
#:     worst on-topic   0.563   "is speculative decoding lossy?"
#:     best off-topic   0.496   "what is the best sourdough hydration ratio"
#:
#: 0.50 is the LOWEST value admitting zero off-topic queries, which is how it was originally picked —
#: and it leaves **0.004 of margin**. The sourdough question was four thousandths away from being
#: cited as a source. Any corpus edit that nudged one document's embedding could flip it, and the
#: symptom would be the tutor confidently citing bread.
#:
#: 0.53 is the MIDPOINT of the separating gap, so the margin is even in both directions (0.034 each
#: way) instead of all of it being spent on one side. It still keeps 8/8 on-topic — the worst is
#: 0.563 — and still rejects 5/5.
#:
#: The gap itself is only 0.068, which is not comfortable and is embedder- and corpus-specific.
#: **Re-measure when either changes** — `scripts/measure_retrieval_threshold.py` exists for exactly
#: that, and a threshold carried over from a different embedder is one that silently stopped working.
#: RE-MEASURED 2026-08-13 ON THE 30-DOCUMENT CORPUS. THE CLEAN SEPARATION IS GONE.
#:
#: The 0.034-either-side margin recorded below was measured on 10 documents with 8 on-topic and 5
#: off-topic probes. With 30 documents, 28 on-topic probes (one per document) and 10 off-topic:
#:
#:     worst on-topic 0.478 | best off-topic 0.506 | gap -0.028   <- OVERLAPPING
#:
#: No threshold keeps every real question and rejects every unrelated one. **0.53 is kept anyway**,
#: because it still admits 0 of 10 off-topic while keeping 25 of 28 on-topic, and the failure
#: directions are not symmetric: a rejected question costs a citation and the tutor still answers
#: (fail-open, with the ungrounded instruction telling it to hedge), while an admitted junk document
#: makes it cite a paper at someone who asked about something else.
#:
#: The overlap has a legible cause, and it is not the corpus size:
#:   * **Acronyms score LOW** — triton 0.478, grpo 0.513, fsdp/ddp 0.519, rmsnorm 0.535. The
#:     embedder has weak representations for ML acronyms.
#:   * **Polysemous domain words score HIGH off-topic** — "how much attention should I give a new
#:     puppy" 0.506 and "what transformer do I need for european appliances" 0.501 beat four real
#:     questions. `attention` and `transformer` are ordinary English.
#:
#: So the fix is the embedder, not this number. Raising it rejects more real acronym questions;
#: lowering it admits the polysemy cases. Do not tune it in place of that decision.
#:
#: The earlier measurement did not catch this because the probe set never grew with the corpus:
#: the same 8 queries about the original 10 documents returned an IDENTICAL 0.068 gap after the
#: corpus tripled. An unchanged number from an unchanged probe set is not evidence.
MIN_SIMILARITY = 0.53


class Document(Protocol):
    """The shape retrieval needs. `KnowledgeDocument` satisfies it; so does a test double."""

    slug: str
    title: str
    body: str
    is_current: bool
    embedding: str | None
    embedding_dim: int | None

    def citation(self) -> str: ...


@dataclass(frozen=True)
class Hit:
    document: Document
    similarity: float

    def cited(self) -> str:
        """Body plus attribution. The tutor must never surface one without the other — a retrieved
        fact stripped of its citation is indistinguishable from one the model invented."""
        return f"{self.document.body}\n\n[{self.document.citation()}]"


def parse_embedding(raw: str | None) -> list[float] | None:
    """`[0.1, 0.2, ...]` -> floats. Returns None on anything unparseable.

    Tolerant rather than raising, because a malformed embedding is a corrupt row, not a caller
    error — and one bad row should drop out of the pool rather than take down every query that
    touches the corpus.
    """
    if not raw:
        return None
    try:
        inner = raw.strip().lstrip("[").rstrip("]")
        if not inner.strip():
            return None
        return [float(x) for x in inner.split(",")]
    except (ValueError, AttributeError):
        return None


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity in [-1, 1]. Raises on a dimension mismatch — see rule 3."""
    if len(a) != len(b):
        raise ValueError(
            f"embedding dimension mismatch: {len(a)} vs {len(b)}. Two embedding models are mixed "
            "in one corpus; their similarities are not comparable and ranking them together "
            "returns meaningless neighbours rather than worse ones.")
    # strict=True even though the length check above already guarantees equal lengths. Without
    # it, removing that check would make this silently truncate to the shorter vector and return a
    # plausible similarity for two incomparable embeddings — the exact failure the check prevents.
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        # A zero vector has no direction, so it has no similarity to anything. 0.0 keeps it below
        # any sensible threshold rather than raising on a row that is merely useless.
        return 0.0
    return dot / (na * nb)


def retrieve(query_embedding: Sequence[float], documents: Iterable[Document], *,
             top_k: int = 4, min_similarity: float = MIN_SIMILARITY,
             on_skip: Callable[[Document, str], None] | None = None) -> list[Hit]:
    """Rank retrievable documents against the query, keeping only confident matches.

    `min_similarity` defaults deliberately high enough to return *nothing* for an uncovered
    question. That is the point: an empty result lets the tutor say it has no source, where a
    forced top-k hands it unrelated material to cite confidently.

    `on_skip` reports why a document was excluded. Silent filtering is how a corpus ends up
    answering every query with nothing while looking correctly configured — the operator needs to
    distinguish "no good match" from "nothing was embedded".
    """
    hits: list[Hit] = []
    for doc in documents:
        if not doc.is_current:
            # Rule 1. Never rank a document the corpus has replaced.
            if on_skip:
                on_skip(doc, "superseded")
            continue
        vec = parse_embedding(doc.embedding)
        if vec is None:
            if on_skip:
                on_skip(doc, "not embedded")
            continue
        if doc.embedding_dim is not None and doc.embedding_dim != len(query_embedding):
            # Rule 3, checked against the declared dimension before the vector is even compared,
            # so a mislabelled row is caught rather than silently ranked.
            raise ValueError(
                f"document {doc.slug!r} declares dim {doc.embedding_dim}, query is "
                f"{len(query_embedding)}")
        score = cosine_similarity(query_embedding, vec)
        if score < min_similarity:
            if on_skip:
                on_skip(doc, f"below threshold ({score:.3f})")
            continue
        hits.append(Hit(document=doc, similarity=score))

    # Sort by similarity, then slug: ties must not depend on iteration order, or the same query
    # returns different citations on different days and nobody can reproduce a complaint.
    hits.sort(key=lambda h: (-h.similarity, h.document.slug))
    return hits[:top_k]


#: Appended when documents were retrieved. Two instructions, and the second is the load-bearing one.
GROUNDED_INSTRUCTION = """
You have been given reference material below. Follow two rules when using it:

1. **Cite what you take from it.** Every factual claim drawn from this material must name its
   source. A learner preparing for an interview cannot tell a sourced claim from an invented one,
   and the citation is what makes a stale entry findable and correctable later.
2. **Prefer it over your own recollection where they disagree.** This material is dated and
   current; your training data is neither. Attention variants, quantization schemes and kernel
   guidance change, and confidently teaching a superseded version is the specific failure this
   material exists to prevent.

REFERENCE MATERIAL
------------------
{context}
"""

#: Appended when nothing was retrieved. Not an error state — the honest one.
UNGROUNDED_INSTRUCTION = """
No reference material was found for this question.

Answer from your own knowledge, and **say so** where the answer depends on details that change
over time — model families, quantization schemes, kernel APIs, library behaviour. Do not invent a
citation. "I don't have a current source for this, and it may have changed" is a more useful
answer to someone preparing for an interview than a confident one that is two years stale.
"""


def ground_prompt(system_prompt: str, hits: Sequence[Hit]) -> str:
    """Compose the tutor's system prompt with whatever was retrieved.

    **The empty case is handled explicitly rather than by omission.** Appending nothing when
    retrieval finds nothing leaves the model in exactly the state V2 exists to fix: answering from
    weights, with no signal that it should hedge. The instruction it gets instead is to answer but
    flag time-sensitivity, which is the honest behaviour and is why `build_context` returning "" is
    a real state rather than a failure.

    Note this composes rather than replaces. The mode-specific prompts (`PE_TEACHING_PROMPT` and
    friends) carry the teaching behaviour, and the fine-tuned adapter is bound to their exact text
    — appending is safe where editing them is not.
    """
    context = build_context(hits)
    suffix = GROUNDED_INSTRUCTION.format(context=context) if context else UNGROUNDED_INSTRUCTION
    return f"{system_prompt.rstrip()}\n{suffix}"


def build_context(hits: Sequence[Hit]) -> str:
    """The block handed to the model. Empty when nothing matched, on purpose.

    An empty context is what lets the tutor answer "I don't have a source for that" instead of
    reasoning from whatever happened to rank fourth. The prompt that consumes this must treat
    empty as a real state rather than a failure to be papered over.
    """
    if not hits:
        return ""
    return "\n\n---\n\n".join(h.cited() for h in hits)
