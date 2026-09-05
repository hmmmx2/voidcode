"""The composition layer. The bug this pins is one no single module had.

Every module below this one is tested and correct in isolation. The failure only appears when they
are wired together, and it produces a full, plausible, useless list rather than an error.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.mastery import Attempt
from features.recommend import ProblemMeta, recommend

NOW = datetime(2026, 8, 10)

# A small taxonomy: the learner fails `backprop`, which sits on `autograd`. Everything else is
# untouched, standing in for the 143 real gaps.
PREREQS = {"backprop": ["autograd"], "autograd": [], **{f"other{i}": [] for i in range(20)}}
ALL_CONCEPTS = sorted(PREREQS)
BY_CONCEPT = {c: [f"{c}-p"] for c in ALL_CONCEPTS}
META = {f"{c}-p": ProblemMeta(difficulty="medium", n_concepts=1) for c in ALL_CONCEPTS}

FAILED_BACKPROP = [
    Attempt("u1", "p1", ("backprop",), "wrong_answer", datetime(2026, 8, 1)),
    Attempt("u1", "p2", ("backprop",), "wrong_answer", datetime(2026, 8, 2)),
]


def rec(**kw):
    base = {"attempts": FAILED_BACKPROP, "problems_by_concept": BY_CONCEPT,
            "prereq_map": PREREQS, "problem_meta": META, "all_concepts": ALL_CONCEPTS,
            "now": NOW}
    return recommend(**{**base, **kw})


def test_demonstrated_weakness_outranks_every_untouched_concept() -> None:
    """The bug. Raw candidate order put the one concept the learner actually failed at position
    144 of 144, behind every concept they had merely never seen â€” a full list that recommends
    against nothing they have evidence for."""
    out = rec()
    assert out.items[0].concept_id == "backprop"
    assert "weak_concept" in out.items[0].reasons


def test_the_prerequisite_outranks_untouched_concepts_too() -> None:
    """The reason the DAG exists: failing backprop usually means autograd never solidified. That
    has to beat a concept nobody has any evidence about."""
    order = [r.concept_id for r in rec(limit=25).items]
    assert order.index("autograd") < order.index("other0")


def test_coverage_gaps_are_capped() -> None:
    """Uncapped, a two-submission learner drags the whole catalog in and dilutes the evidence."""
    out = rec(limit=100, max_gap_concepts=3)
    # Distinct concepts, not items: `autograd` is both a gap and a prerequisite, and it is reached
    # by the prerequisite walk regardless of the cap.
    gaps = {r.concept_id for r in out.items if "coverage_gap" in r.reasons}
    assert len(gaps) == 3


def test_a_solved_problem_is_never_recommended() -> None:
    out = rec(limit=100, solved_slugs=["backprop-p"])
    assert "backprop-p" not in [r.problem_slug for r in out.items]


def test_no_model_is_labelled_as_no_model() -> None:
    """A heuristic list presented as a model's output is a personalisation claim nobody measured,
    and it is indistinguishable from the real thing at the API boundary."""
    out = rec()
    assert out.ranked_by == "mastery"
    assert all(r.score is None for r in out.items)


def test_a_model_is_labelled_as_a_model_and_changes_the_order() -> None:
    # Scores the LAST feature column, which is 1.0 only for coverage-gap candidates. That makes
    # the model promote exactly what the fallback ranks last, so a reorder cannot be a coincidence
    # of the fixture's ordering — an earlier version of this test scored by position and passed
    # while proving nothing.
    class GapsFirst:
        def predict(self, x):
            return [row[8] for row in x]

    fallback = rec(limit=100).items
    out = rec(model=GapsFirst(), limit=100)
    assert out.ranked_by == "model"
    assert out.items[0].score is not None
    assert fallback[0].reasons == ("weak_concept",)
    assert "coverage_gap" in out.items[0].reasons


def test_a_candidate_with_no_metadata_is_dropped_not_guessed() -> None:
    """Inventing a difficulty feeds the model a value nobody chose; the drop is at least visible."""
    class Zero:
        def predict(self, x):
            return [0.0] * len(x)

    partial = {"backprop-p": META["backprop-p"]}
    out = rec(model=Zero(), problem_meta=partial, limit=100)
    assert [r.problem_slug for r in out.items] == ["backprop-p"]


def test_cold_start_is_flagged_rather_than_dressed_up() -> None:
    """With no attempts the list is pure coverage. Calling that personalised would be a lie."""
    out = rec(attempts=[])
    assert out.cold_start
    assert out.weak_concepts == ()
    assert len(out.items) > 0                       # still useful, just not personalised


def test_a_learner_with_history_is_not_cold_start() -> None:
    assert not rec().cold_start


def test_the_order_is_stable_across_calls() -> None:
    """A list that reshuffles between page loads reads as broken even when both orders defend."""
    assert [r.problem_slug for r in rec(limit=25).items] == \
           [r.problem_slug for r in rec(limit=25).items]


def test_untagged_attempts_do_not_invent_a_profile() -> None:
    out = rec(attempts=[Attempt("u1", "p1", (), "accepted", datetime(2026, 8, 1))])
    assert out.cold_start and out.weak_concepts == ()


def test_explanations_match_the_reason_it_surfaced() -> None:
    out = rec(limit=25)
    by_concept = {r.concept_id: r for r in out.items}
    assert "struggling" in by_concept["backprop"].explain()
    assert "underneath" in by_concept["autograd"].explain()
    assert "not attempted" in by_concept["other0"].explain()
