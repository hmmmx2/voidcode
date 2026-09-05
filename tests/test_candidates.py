"""Candidate generation. Recall matters here; precision does not.

A problem this stage drops can never be recommended, whatever the ranker would have done with it.
So the tests are mostly about what must NOT be lost, and about the prerequisite walk — the piece
that makes this more than a filter.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.candidates import generate, prerequisites_of

# autograd <- backpropagation <- optimizers_sgd, plus a deep chain to test depth limiting
PREREQS = {
    "backpropagation": ["autograd", "loss_functions"],
    "autograd": ["tensors_and_shapes"],
    "tensors_and_shapes": ["arrays_and_indexing"],
    "optimizers_sgd": ["backpropagation"],
}
BY_CONCEPT = {
    "backpropagation": ["p-backprop"],
    "autograd": ["p-autograd"],
    "loss_functions": ["p-loss"],
    "tensors_and_shapes": ["p-tensors"],
    "arrays_and_indexing": ["p-arrays"],
    "quantization_basics": ["p-quant"],
}


def test_weak_concepts_surface_their_problems() -> None:
    out = generate(weak_concepts=["backpropagation"], problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS)
    assert "p-backprop" in [c.problem_slug for c in out]


def test_the_prerequisite_walk_surfaces_the_gap_underneath() -> None:
    """The reason this module is not just a filter. A learner failing backpropagation often needs
    autograd — the thing underneath they never solidified — not another backprop problem."""
    out = generate(weak_concepts=["backpropagation"], problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS)
    slugs = [c.problem_slug for c in out]
    assert "p-autograd" in slugs and "p-loss" in slugs


def test_the_walk_is_depth_limited() -> None:
    """A learner failing backpropagation wants autograd, not arrays-and-indexing. Walking to the
    root recommends material so basic it reads as insulting."""
    out = generate(weak_concepts=["backpropagation"], problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS, prereq_depth=2)
    slugs = [c.problem_slug for c in out]
    assert "p-tensors" in slugs        # depth 2
    assert "p-arrays" not in slugs     # depth 3, excluded


def test_breadth_first_reaches_nearer_prerequisites_first() -> None:
    """Nearer prerequisites are the likelier gap."""
    order = prerequisites_of("optimizers_sgd", PREREQS, depth=3)
    assert order.index("backpropagation") < order.index("autograd")


def test_a_cycle_terminates_rather_than_hanging() -> None:
    """taxonomy.py asserts the real graph is acyclic, but this is also called with hand-built maps
    and a cycle there should fail fast rather than spin."""
    assert prerequisites_of("a", {"a": ["b"], "b": ["a"]}, depth=5) == ["b"]


def test_solved_problems_are_excluded() -> None:
    """A list opening with something the learner finished last week reads as broken regardless of
    what the ranker thought."""
    out = generate(weak_concepts=["backpropagation"], problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS, solved_slugs=["p-backprop"])
    assert "p-backprop" not in [c.problem_slug for c in out]


def test_coverage_gaps_reach_concepts_weakness_matching_cannot() -> None:
    """A learner who has never touched quantization has no weakness to match on, so weakness
    matching alone can never surface it."""
    out = generate(weak_concepts=["backpropagation"], gap_concepts=["quantization_basics"],
                   problems_by_concept=BY_CONCEPT, prereq_map=PREREQS)
    assert "p-quant" in [c.problem_slug for c in out]


def test_a_problem_reached_twice_is_merged_not_duplicated() -> None:
    """Two routes to one problem is stronger evidence. Merging keeps that visible; duplicating
    would double-count it in whatever the ranker does next."""
    out = generate(weak_concepts=["backpropagation", "autograd"],
                   problems_by_concept=BY_CONCEPT, prereq_map=PREREQS)
    autograd = [c for c in out if c.problem_slug == "p-autograd"]
    assert len(autograd) == 1
    assert set(autograd[0].sources) == {"weak_concept", "prerequisite"}


def test_never_attempted_outranks_merely_mediocre() -> None:
    """Absence of evidence sorts ahead of a middling score — and None cannot be compared with a
    float without deciding which."""
    out = generate(weak_concepts=["backpropagation"], gap_concepts=["quantization_basics"],
                   mastery={"backpropagation": 0.5}, problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS)
    slugs = [c.problem_slug for c in out]
    # The claim is relative, not absolute. Several concepts here have no mastery entry, so they
    # all tie at None and slug order decides among them — asserting a specific winner would be
    # asserting the alphabet. What matters is that the SCORED concept ranks below every unscored
    # one, since absence of evidence is a stronger candidate than a middling score.
    assert slugs.index("p-quant") < slugs.index("p-backprop")
    assert all(c.mastery is None for c in out[:slugs.index("p-backprop")])
    assert out[slugs.index("p-backprop")].mastery == 0.5


def test_output_is_deterministic() -> None:
    """A recommendation that reshuffles between page loads looks broken even when both orderings
    are defensible."""
    kw = {"weak_concepts": ["backpropagation"], "problems_by_concept": BY_CONCEPT,
          "prereq_map": PREREQS}
    assert [c.problem_slug for c in generate(**kw)] == [c.problem_slug for c in generate(**kw)]


def test_every_candidate_explains_itself() -> None:
    """A recommendation nobody can explain is one nobody can debug — and 'because you are weak at
    X' is a better product than an unexplained list."""
    out = generate(weak_concepts=["backpropagation"], problems_by_concept=BY_CONCEPT,
                   prereq_map=PREREQS)
    assert all(c.sources for c in out)
