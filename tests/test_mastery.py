"""Mastery from real submissions. The weighting decisions are where the mistakes hide.

None of these is about arithmetic. Each pins a choice that, made the other way, produces a profile
that looks reasonable and describes the wrong learner.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.mastery import (
    Attempt,
    coverage_gaps,
    mastery_for_learner,
    weakest_concepts,
)

NOW = datetime(2026, 8, 10)


def a(problem: str, concepts, status: str, days_ago: int = 0) -> Attempt:
    return Attempt(user_id="u1", problem_id=problem, concepts=tuple(concepts),
                   status=status, created_at=NOW - timedelta(days=days_ago))


def test_a_solved_attempt_gives_full_mastery() -> None:
    p = mastery_for_learner([a("p1", ["autograd"], "accepted")], now=NOW)
    assert p["autograd"].score == 1.0
    assert p["autograd"].attempts == 1


def test_credit_is_divided_across_an_items_concepts() -> None:
    """One submission is one observation however many concepts it carries. Counting it once per
    concept would let a heavily-tagged problem dominate a profile, and would make tagging decisions
    silently change mastery estimates."""
    two = mastery_for_learner([a("p1", ["autograd", "backpropagation"], "accepted")], now=NOW)
    one = mastery_for_learner([a("p1", ["autograd"], "accepted")], now=NOW)
    # Score is a ratio so both are 1.0 — the division shows up in the WEIGHT each contributes.
    assert two["autograd"].score == one["autograd"].score == 1.0
    # A three-tagged failure must not outweigh a one-tagged success on a shared concept.
    mixed = mastery_for_learner([
        a("p1", ["autograd"], "accepted"),
        a("p2", ["autograd", "backpropagation", "linear_layers"], "runtime_error"),
    ], now=NOW)
    assert mixed["autograd"].score > 0.5


def test_recent_evidence_outweighs_old() -> None:
    """A profile that never forgets keeps recommending against weaknesses the learner has fixed."""
    improved = mastery_for_learner([
        a("p1", ["autograd"], "runtime_error", days_ago=180),
        a("p2", ["autograd"], "accepted", days_ago=1),
    ], now=NOW)
    assert improved["autograd"].score > 0.9


def test_first_attempt_rate_is_tracked_separately() -> None:
    """Overall pass rate rewards persistence; persistence is not knowledge. A learner who fails
    then passes has demonstrated something, but not mastery."""
    p = mastery_for_learner([
        a("p1", ["autograd"], "runtime_error", days_ago=2),
        a("p1", ["autograd"], "accepted", days_ago=1),
    ], now=NOW)
    assert p["autograd"].score > 0.0          # eventually solved
    assert p["autograd"].first_attempt_rate == 0.0   # but not first time


def test_first_attempt_is_read_from_time_order_not_list_order() -> None:
    """'First attempt' is a property of the sequence. Reading it off an unsorted list silently
    picks an arbitrary submission."""
    out_of_order = mastery_for_learner([
        a("p1", ["autograd"], "accepted", days_ago=1),      # later, listed first
        a("p1", ["autograd"], "runtime_error", days_ago=5),  # actually first
    ], now=NOW)
    assert out_of_order["autograd"].first_attempt_rate == 0.0


def test_estimates_carry_their_sample_size() -> None:
    """0.0 from one attempt and 0.0 from thirty are not the same claim."""
    thin = mastery_for_learner([a("p1", ["autograd"], "runtime_error")], now=NOW)
    assert thin["autograd"].score == 0.0 and thin["autograd"].attempts == 1


def test_untagged_problems_contribute_nothing() -> None:
    """A submission against an untagged problem is not evidence about any concept. Attributing it
    somewhere would be inventing data — and it is why an unpopulated join yields an empty profile
    rather than a wrong one."""
    assert mastery_for_learner([a("p1", [], "accepted")], now=NOW) == {}


def test_weakest_concepts_ignores_thin_evidence() -> None:
    """The weakest-looking concept is almost always the one with a single failed attempt.
    Recommending heavily against that is the sparse-history failure the risk register names."""
    p = mastery_for_learner([
        a("p1", ["autograd"], "runtime_error"),                      # 1 attempt, score 0
        a("p2", ["kv_cache"], "runtime_error", days_ago=3),
        a("p3", ["kv_cache"], "runtime_error", days_ago=2),          # 2 attempts, score 0
    ], now=NOW)
    weakest = weakest_concepts(p, limit=5, min_attempts=2)
    assert [m.concept_id for m in weakest] == ["kv_cache"]


def test_weakest_is_deterministic_on_ties() -> None:
    """A recommendation that reshuffles between page loads reads as broken even when both
    orderings are defensible."""
    p = mastery_for_learner([
        a("p1", ["zebra"], "runtime_error"), a("p2", ["zebra"], "runtime_error"),
        a("p3", ["alpha"], "runtime_error"), a("p4", ["alpha"], "runtime_error"),
    ], now=NOW)
    assert [m.concept_id for m in weakest_concepts(p)] == ["alpha", "zebra"]


def test_never_attempted_is_not_the_same_as_weak() -> None:
    """Absence of evidence, not evidence of weakness. Conflating them buries genuinely weak
    concepts under every topic the learner has not reached yet."""
    p = mastery_for_learner([a("p1", ["autograd"], "accepted")], now=NOW)
    assert coverage_gaps(p, ["autograd", "kv_cache", "rope"]) == ["kv_cache", "rope"]
