"""Tests for the cold-start P(solve) prior. V4.

Two things are being defended here, and only one of them is arithmetic.

The arithmetic: the prior returns a real float in [0,1] for every learner/problem pair, including
the ones with no history at all.

The other, which matters more: **the World A Codeforces model must never leak into these numbers.**
The warehouse holds a genuinely good fit — out-of-fold ECE 0.0001 over 1.32M rows — and that quality
is exactly what makes it tempting to apply. It describes competitive DSA problems and says nothing
about "implement FlashAttention in Triton". A test that fails if it is reintroduced is the only
thing standing between a plausible number and a measured one.
"""
from __future__ import annotations

import itertools
import math

import pytest
from src import difficulty_prior
from src.difficulty_prior import (
    BETA_BY_DIFFICULTY,
    beta_for,
    solve_probability,
    theta_from_mastery,
)

DIFFICULTIES = ["easy", "medium", "hard"]


# ── the checklist requirement: 10 learners, no nulls ─────────────────────────

def test_ten_learner_profiles_all_get_a_real_probability():
    """The Definition of Done: 10 sampled learners, 0 nulls.

    The profiles span the full range including both cold-start cases — a learner with no history at
    all (None) and one at each extreme — because those are where a None would reappear.
    """
    profiles = [None, 0.0, 0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.0]
    assert len(profiles) == 10
    for mastery in profiles:
        for difficulty in DIFFICULTIES:
            p = solve_probability(mastery, difficulty)
            assert p is not None
            assert isinstance(p, float)
            assert 0.0 <= p <= 1.0, f"{mastery} / {difficulty} -> {p}"


def test_unknown_or_missing_difficulty_still_returns_a_number():
    """A problem whose difficulty is absent or misspelled must not reintroduce a null."""
    for difficulty in (None, "", "IMPOSSIBLE", "Medium  "):
        assert 0.0 <= solve_probability(0.5, difficulty) <= 1.0


# ── the shape of the prior ───────────────────────────────────────────────────

def test_on_a_medium_problem_the_prior_is_exactly_the_mastery():
    """beta is 0 for medium, so sigmoid(logit(m) - 0) == m. This identity is the whole model, and
    it is what lets anyone reading a number reconstruct where it came from."""
    for m in (0.1, 0.25, 0.5, 0.75, 0.9):
        assert solve_probability(m, "medium") == pytest.approx(m, abs=1e-9)


def test_difficulty_orders_the_probabilities():
    """easy > medium > hard for the same learner. This ordering is the part of the prior that is
    actually trustworthy — the absolute values are a placeholder."""
    for m in (0.2, 0.5, 0.8):
        easy, medium, hard = (solve_probability(m, d) for d in DIFFICULTIES)
        assert easy > medium > hard


def test_mastery_is_monotone():
    """More mastery must never lower the probability, or the ranking it induces is meaningless."""
    probs = [solve_probability(m / 20, "hard") for m in range(21)]
    assert all(b >= a for a, b in itertools.pairwise(probs))


def test_no_history_maps_to_the_population_midpoint_not_to_zero_ability():
    """`None` means "never attempted", not "measured, and weak" — opposite claims. A new learner
    must not be told every problem is beyond them."""
    assert theta_from_mastery(None) == 0.0
    assert solve_probability(None, "medium") == pytest.approx(0.5)
    # Strictly better than the weakest measured learner, which is the point.
    assert solve_probability(None, "medium") > solve_probability(0.0, "medium")


def test_extreme_mastery_does_not_produce_infinity_or_nan():
    """Mastery of exactly 0 or 1 would make logit infinite without the clamp."""
    for m in (0.0, 1.0):
        for d in DIFFICULTIES:
            p = solve_probability(m, d)
            assert math.isfinite(p) and 0.0 < p < 1.0


def test_beta_spacing_is_one_logit_per_step():
    """Pins the documented spacing. If someone retunes these, the docstring claiming "one unit per
    step, odds multiplied by e" becomes false and this catches it."""
    assert beta_for("easy") == -1.0
    assert beta_for("medium") == 0.0
    assert beta_for("hard") == 1.0
    assert set(BETA_BY_DIFFICULTY) == {"easy", "medium", "hard"}


# ── the guard that matters ───────────────────────────────────────────────────

def test_world_a_map_is_not_applied():
    """THE regression test for the World A -> World B transfer error.

    The isotonic map is fitted on Codeforces out-of-fold predictions. Applying it here would be the
    same mistake as mapping platform problems to Codeforces ids, just harder to see. The medium
    identity is the detector: the map is non-trivial (it moves 0.5 measurably), so if it were ever
    applied, sigmoid(logit(m)) would stop equalling m.
    """
    from src.calibration import load_map

    cal = load_map()
    if cal is not None:
        mapped = cal.apply(0.5)
        assert mapped != pytest.approx(0.5, abs=1e-6), (
            "the calibration map no longer moves 0.5, so this test can no longer detect its "
            "application -- pick a different probe point")
        assert solve_probability(0.5, "medium") == pytest.approx(0.5, abs=1e-9)
    assert difficulty_prior.status()["basis"] == "prior"


def test_status_says_it_is_uncalibrated():
    """A placeholder reported as a measurement is the failure this whole module guards against."""
    st = difficulty_prior.status()
    assert st["calibrated"] is False
    assert st["basis"] == "prior"
    assert "chosen, not fitted" in st["reason"]


# ── the path out of the prior ────────────────────────────────────────────────

def test_platform_irt_is_not_ready_on_todays_data():
    """9 users and 2 submissions. Nothing reaches the 7-observation threshold, so the prior stands
    and the API must keep saying so."""
    assert difficulty_prior.platform_irt_ready(None) is False
    assert difficulty_prior.platform_irt_ready({}) is False
    assert difficulty_prior.platform_irt_ready({"two-sum": 2, "grad-clip": 1}) is False


def test_platform_irt_becomes_ready_at_the_threshold():
    """The switch exists and fires on evidence — it is not decoration."""
    n = difficulty_prior.MIN_OBSERVATIONS_FOR_FIT
    assert difficulty_prior.platform_irt_ready({"a": n - 1}) is False
    assert difficulty_prior.platform_irt_ready({"a": n}) is True
