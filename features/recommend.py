"""What the learner should do next: the layer that composes the other four.

`mastery` -> `candidates` -> `ranking` each work in isolation and are each tested. This joins them,
and it exists because **the composition had a bug that none of them had alone**.

THE ORDERING BUG THIS LAYER EXISTS TO FIX
--------------------------------------------
`candidates.generate` sorts never-attempted concepts ahead of merely-weak ones. That is correct in
isolation: absence of evidence should outrank mediocrity, because a concept scoring 0.6 is not a
better recommendation than one the learner has never seen.

It inverts for a new learner. Measured against the real taxonomy, for someone who has failed
`backpropagation` twice and touched nothing else:

    143 of 144 concepts are coverage gaps
    the concept they demonstrably failed ranks 144th

Every never-touched concept sorts ahead of the one piece of evidence the learner produced. The list
is full, plausible, and useless — which is why this needed measuring rather than reasoning about.

So the fallback order here is by **source**, not by mastery alone:

    1. weak_concept   demonstrated failure       the strongest signal a learner can give
    2. prerequisite   the gap underneath it      why the DAG exists
    3. coverage_gap   never attempted            real, but weakest

and within a tier, mastery ascending. Coverage gaps are also capped (`MAX_GAP_CONCEPTS`) so a
learner with two submissions does not drag the entire catalog into the candidate set.

WHEN THERE IS NO MODEL, SAY THERE IS NO MODEL
------------------------------------------------
`ranking.train_ranker` returns None below two learners or ten examples. On this platform's real
data — 9 users, 2 submissions — that is what it does, and that is correct rather than a bug to
route around. The recommendations still come back, ordered by the rule above, and `ranked_by` says
`"mastery"` instead of `"model"`.

That field is not decoration. A heuristic list presented as a model's output is a personalisation
claim nobody measured, and it is indistinguishable from the real thing at the API boundary.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from .candidates import Candidate, generate
from .mastery import Attempt, Mastery, coverage_gaps, mastery_for_learner, weakest_concepts
from .ranking import build_features

#: Ordering tiers for the fallback. Lower sorts first. See the module docstring — this is the fix
#: for the 144th-place bug, and reordering these silently changes what every learner sees.
SOURCE_RANK = {"weak_concept": 0, "prerequisite": 1, "coverage_gap": 2}

#: How many never-attempted concepts may enter the candidate set. A new learner has ~143 gaps
#: against this taxonomy; without a cap every problem in the catalog becomes a candidate and the
#: few concepts carrying actual evidence are diluted to nothing. Ten is enough to keep breadth
#: available without letting absence-of-evidence outweigh evidence.
MAX_GAP_CONCEPTS = 10

#: Default recommendations returned. A learner acts on the first few; a longer list is a menu.
DEFAULT_LIMIT = 10


@dataclass(frozen=True)
class ProblemMeta:
    """What the ranker needs about a problem beyond its concepts."""

    difficulty: str
    n_concepts: int


@dataclass(frozen=True)
class Recommendation:
    problem_slug: str
    concept_id: str
    #: Why it surfaced, from `candidates`. Carried to the UI because a recommendation nobody can
    #: explain is one nobody can debug — and because the learner deserves the reason.
    reasons: tuple[str, ...]
    #: The model's score, or None when no model ranked this. Not zero: zero is a score.
    score: float | None
    #: The learner's mastery of `concept_id`, or None if never attempted.
    mastery: float | None

    def explain(self) -> str:
        """One sentence a learner can read. Ordered by strength of signal, same as SOURCE_RANK."""
        if "weak_concept" in self.reasons:
            return f"You have been struggling with {self.concept_id.replace('_', ' ')}."
        if "prerequisite" in self.reasons:
            return (f"This builds {self.concept_id.replace('_', ' ')}, which sits underneath "
                    "something you have been finding hard.")
        return f"You have not attempted {self.concept_id.replace('_', ' ')} yet."


@dataclass(frozen=True)
class Recommendations:
    items: tuple[Recommendation, ...]
    #: `"model"` or `"mastery"`. See the module docstring — a heuristic list labelled as a model's
    #: output is a personalisation claim nobody measured.
    ranked_by: str
    #: Concepts driving the list, weakest first. Surfaced so the reason is inspectable rather than
    #: inferred from the results.
    weak_concepts: tuple[str, ...]
    #: True when the learner has produced no attempts at all. The list is then pure coverage, and
    #: calling that personalised would be a lie.
    cold_start: bool

    def __len__(self) -> int:
        return len(self.items)

    def __iter__(self):
        # Defined because `__len__` alone is a trap: `len(recs)` works, `for r in recs` raises, and
        # the two look equally reasonable at a call site. A test of mine tripped on exactly that.
        return iter(self.items)


def _fallback_sort_key(c: Candidate) -> tuple:
    """Strongest evidence first, then weakest mastery, then slug for determinism."""
    tier = min((SOURCE_RANK.get(s, len(SOURCE_RANK)) for s in c.sources), default=len(SOURCE_RANK))
    # Within a tier, lower mastery first. None means never attempted, which only occurs in the
    # coverage tier where every value is None — so it cannot reorder against a real score here.
    return (tier, c.mastery if c.mastery is not None else 0.0, c.problem_slug)


def recommend(
    *,
    attempts: Iterable[Attempt],
    problems_by_concept: Mapping[str, Sequence[str]],
    prereq_map: Mapping[str, Sequence[str]],
    problem_meta: Mapping[str, ProblemMeta],
    all_concepts: Sequence[str],
    solved_slugs: Iterable[str] = (),
    model=None,
    now: datetime | None = None,
    limit: int = DEFAULT_LIMIT,
    max_gap_concepts: int = MAX_GAP_CONCEPTS,
) -> Recommendations:
    """The whole path: submissions in, an ordered list with reasons out.

    `model` is optional and may legitimately be None — see the module docstring. Passing one that
    was trained on different features would be worse than passing none, so the feature vector is
    built here by the same `build_features` the trainer used rather than reconstructed.
    """
    attempts = list(attempts)
    profile: dict[str, Mastery] = mastery_for_learner(attempts, now=now)
    weak = weakest_concepts(profile)
    weak_ids = [m.concept_id for m in weak]

    # Capped, and taken in taxonomy order so the same learner gets the same gaps every time. An
    # uncapped gap list buries demonstrated weakness under everything untouched.
    gaps = coverage_gaps(profile, all_concepts)[:max_gap_concepts]

    candidates = generate(
        weak_concepts=weak_ids,
        gap_concepts=gaps,
        mastery={c: m.score for c, m in profile.items()},
        problems_by_concept=problems_by_concept,
        prereq_map=prereq_map,
        solved_slugs=solved_slugs,
    )

    cold_start = not any(a.concepts for a in attempts)

    if model is None:
        ordered = sorted(candidates, key=_fallback_sort_key)
        items = tuple(
            Recommendation(problem_slug=c.problem_slug, concept_id=c.concept_id,
                           reasons=c.sources, score=None, mastery=c.mastery)
            for c in ordered[:limit]
        )
        return Recommendations(items=items, ranked_by="mastery",
                               weak_concepts=tuple(weak_ids), cold_start=cold_start)

    import numpy as np

    rows, keep = [], []
    for c in candidates:
        meta = problem_meta.get(c.problem_slug)
        if meta is None:
            # A candidate with no metadata cannot be featurised, and inventing a difficulty would
            # feed the model a value nobody chose. Dropping is visible; guessing is not.
            continue
        m = profile.get(c.concept_id)
        rows.append(build_features(
            mastery=m.score if m else None,
            attempts_on_concept=m.attempts if m else 0,
            first_attempt_rate=m.first_attempt_rate if m else None,
            difficulty=meta.difficulty,
            n_concepts=meta.n_concepts,
            sources=c.sources,
        ))
        keep.append(c)

    if not rows:
        return Recommendations(items=(), ranked_by="mastery",
                               weak_concepts=tuple(weak_ids), cold_start=cold_start)

    scores = model.predict(np.array(rows, dtype=float))
    # Descending score, then slug: ties must not depend on candidate iteration order, or the same
    # learner gets a different list on different days and no complaint is reproducible.
    # strict=True: `keep` and `scores` are built in the same loop, so a divergence would mean a
    # bug that silently drops candidates off the end of the shorter one.
    ordered = sorted(zip(keep, scores, strict=True),
                     key=lambda p: (-float(p[1]), p[0].problem_slug))
    items = tuple(
        Recommendation(problem_slug=c.problem_slug, concept_id=c.concept_id,
                       reasons=c.sources, score=float(s), mastery=c.mastery)
        for c, s in ordered[:limit]
    )
    return Recommendations(items=items, ranked_by="model",
                           weak_concepts=tuple(weak_ids), cold_start=cold_start)
