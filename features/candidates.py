"""Candidate generation: which problems should this learner see next?

Stage one of the two-stage ranker (spec §5.1). This narrows the catalog to a few hundred plausible
problems; the LambdaMART model then orders them. Recall matters here and precision does not — a
problem this stage drops can never be recommended, whatever the ranker would have done with it.

THREE SOURCES, BECAUSE ONE IS NOT ENOUGH
-------------------------------------------
**Concept match** finds problems teaching what the learner is weakest at. Obvious, and insufficient
on its own: it recommends more of exactly what the learner keeps failing, which is how a learner
gets stuck.

**Prerequisite walk** is the interesting one. When someone fails `backpropagation`, the useful
recommendation is often not another backprop problem — it is `autograd`, the thing underneath that
they never solidified. Failing at depth usually means a gap at the level below, and the DAG in
`data/concepts.yaml` is what makes that gap findable. This is the reason the taxonomy has
prerequisite edges at all.

**Coverage gaps** surface concepts never attempted. Not weakness — absence of evidence — but a
learner who has never touched quantization will not have it recommended by weakness-matching,
because there is no weakness to match on.

WHAT THIS DELIBERATELY DOES NOT DO
-------------------------------------
No collaborative signal. Spec §5.1 lists it, and it needs learners with overlapping histories; with
nine users and two submissions it would produce confident noise. Recorded as absent rather than
faked, and the hook is a `sources` field on each candidate so adding it later does not change the
shape.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

#: How far up the prerequisite chain to walk from a weak concept. Two levels, because the direct
#: prerequisite is usually the real gap and the grandparent is usually too basic to be useful — a
#: learner failing `flash_attention` wants `attention_scaled_dot`, not `arrays_and_indexing`.
PREREQ_DEPTH = 2

#: Candidates to return. Spec §5.1 asks for 200-500; this catalog holds 77 problems, so the cap is
#: effectively "all of them" and exists to stop the number growing silently with the catalog.
DEFAULT_LIMIT = 300


@dataclass(frozen=True)
class Candidate:
    problem_slug: str
    concept_id: str
    #: Why this problem surfaced. Kept because a recommendation nobody can explain is one nobody
    #: can debug — and because "we suggested this because you are weak at X" is a better product
    #: than an unexplained list.
    sources: tuple[str, ...] = field(default=())
    #: Lower is weaker, so lower sorts first. `None` for concepts never attempted, which is not
    #: the same as scoring zero.
    mastery: float | None = None


def prerequisites_of(concept_id: str, prereq_map: Mapping[str, Sequence[str]],
                     depth: int = PREREQ_DEPTH) -> list[str]:
    """Concepts underneath `concept_id`, breadth-first, to `depth` levels.

    Breadth-first rather than depth-first so nearer prerequisites come out first — they are the
    likelier gap. The visited set is not an optimisation: `features/taxonomy.py` asserts the graph
    is acyclic, but this function is also called with hand-built maps in tests and a cycle there
    would hang rather than fail.
    """
    seen = {concept_id}
    frontier = [concept_id]
    out: list[str] = []
    for _ in range(depth):
        nxt: list[str] = []
        for c in frontier:
            for p in prereq_map.get(c, ()):
                if p not in seen:
                    seen.add(p)
                    out.append(p)
                    nxt.append(p)
        frontier = nxt
        if not frontier:
            break
    return out


def generate(
    *,
    weak_concepts: Sequence[str],
    gap_concepts: Sequence[str] = (),
    mastery: Mapping[str, float] | None = None,
    problems_by_concept: Mapping[str, Sequence[str]],
    prereq_map: Mapping[str, Sequence[str]],
    solved_slugs: Iterable[str] = (),
    limit: int = DEFAULT_LIMIT,
    prereq_depth: int = PREREQ_DEPTH,
) -> list[Candidate]:
    """Build the candidate set for one learner.

    `solved_slugs` are excluded. A learner who has already solved a problem gains little from
    seeing it again, and a recommendation list that opens with something they finished last week
    reads as broken regardless of what the ranker thought.

    Ordering is by mastery ascending, then by slug — deterministic, so the same profile always
    yields the same list. A recommendation that reshuffles between page loads looks broken even
    when both orderings are defensible.
    """
    mastery = mastery or {}
    solved = set(solved_slugs)
    # slug -> the reasons it surfaced. A problem reached by two routes is stronger evidence, and
    # merging rather than duplicating keeps that visible instead of double-counting it.
    reasons: dict[str, set[str]] = {}
    concept_of: dict[str, str] = {}

    def add(slug: str, concept: str, source: str) -> None:
        if slug in solved:
            return
        reasons.setdefault(slug, set()).add(source)
        # First concept wins, so a problem's attributed concept is stable across runs.
        concept_of.setdefault(slug, concept)

    for c in weak_concepts:
        for slug in problems_by_concept.get(c, ()):
            add(slug, c, "weak_concept")

    for c in weak_concepts:
        for p in prerequisites_of(c, prereq_map, depth=prereq_depth):
            for slug in problems_by_concept.get(p, ()):
                add(slug, p, "prerequisite")

    for c in gap_concepts:
        for slug in problems_by_concept.get(c, ()):
            add(slug, c, "coverage_gap")

    out = [
        Candidate(problem_slug=slug, concept_id=concept_of[slug],
                  sources=tuple(sorted(reasons[slug])), mastery=mastery.get(concept_of[slug]))
        for slug in reasons
    ]
    # None sorts first: a never-attempted concept is a stronger candidate than one the learner is
    # merely mediocre at, and `None` cannot be compared with a float without saying which.
    out.sort(key=lambda c: (0 if c.mastery is None else 1,
                            c.mastery if c.mastery is not None else 0.0,
                            c.problem_slug))
    return out[:limit]
