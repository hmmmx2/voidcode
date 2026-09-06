"""Estimator tests for `scripts/rl_eval.py`.

These run on CPU and import nothing that needs a GPU, so the arithmetic that turns per-problem
success counts into pass@k is covered by CI rather than validated once by eye on a rented pod.

The point of the harness is that pass@1 was previously *unrecoverable* — the loop stored only an
aggregate `solved_any`. So the property that matters most here is the one asserted first: the
unbiased estimator at k=1 must reduce exactly to c/n, and `any(correct)` must NOT be mistaken for
it, because that is the substitution that inflates the number.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

# Repo convention: tests put the root on sys.path themselves rather than relying on how pytest
# was invoked.
#
# Import `rl.estimators`, NOT `scripts.rl_eval`. Two `scripts` packages exist (root and
# apps/api), pytest.ini puts apps/api on the path, and whichever is imported first wins for the
# whole session — importing scripts.rl_eval here broke test_seeders_use_loader.py three tests
# later with ModuleNotFoundError: No module named 'scripts.seed_problems'.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.estimators import bootstrap_ci, pass_at_k, wilson


def test_pass_at_1_is_exactly_c_over_n():
    """pass@1 = 1 - C(n-c,1)/C(n,1) = c/n. If this drifts, every pass@1 number is wrong."""
    for n in (1, 4, 8, 16):
        for c in range(n + 1):
            assert pass_at_k(n, c, 1) == pytest.approx(c / n, abs=1e-12)


def test_any_correct_is_not_pass_at_1():
    """The trap this harness exists to avoid.

    With 1 success in 8 samples, `any(correct)` reads 1.0 while pass@1 is 0.125 — an 8x
    overstatement. `solved_any` in the training loop is this quantity, which is why it cannot be
    reinterpreted as pass@1 after the fact.
    """
    any_correct = 1.0
    assert pass_at_k(8, 1, 1) == pytest.approx(0.125)
    assert any_correct != pytest.approx(pass_at_k(8, 1, 1))


def test_pass_at_k_edges():
    assert pass_at_k(8, 0, 1) == 0.0          # never solved
    assert pass_at_k(8, 8, 1) == 1.0          # always solved
    assert pass_at_k(8, 1, 8) == 1.0          # k == n and one success: certain to be drawn
    assert pass_at_k(8, 1, 2) == pytest.approx(0.25)


def test_pass_at_k_is_monotone_in_k():
    """More draws cannot lower the chance of seeing a success."""
    vals = [pass_at_k(8, 2, k) for k in (1, 2, 4, 8)]
    assert vals == sorted(vals)
    assert vals[0] < vals[-1]


def test_pass_at_k_matches_closed_form():
    n, c, k = 10, 3, 4
    expected = 1.0 - math.comb(n - c, k) / math.comb(n, k)
    assert pass_at_k(n, c, k) == pytest.approx(expected)


def test_wilson_matches_the_published_interval():
    """4/60 is the base greedy pass@1 already recorded in METRICS.md as [0.026, 0.159].

    Pinned so the ledger and the harness cannot silently disagree.
    """
    lo, hi = wilson(4, 60)
    assert (round(lo, 3), round(hi, 3)) == (0.026, 0.159)


def test_wilson_brackets_the_point_estimate_and_stays_in_range():
    for k, n in ((0, 60), (1, 60), (30, 60), (60, 60)):
        lo, hi = wilson(k, n)
        assert 0.0 <= lo <= k / n <= hi <= 1.0


def test_wilson_of_zero_successes_excludes_nothing_below_zero():
    lo, hi = wilson(0, 60)
    assert lo == 0.0 and hi > 0.0


def test_bootstrap_on_a_constant_has_zero_width():
    lo, hi = bootstrap_ci([0.5] * 60, iters=500, seed=1)
    assert lo == pytest.approx(0.5) and hi == pytest.approx(0.5)


def test_bootstrap_brackets_the_mean_and_is_deterministic_under_seed():
    vals = [i / 60 for i in range(60)]
    lo, hi = bootstrap_ci(vals, iters=1000, seed=7)
    mean = sum(vals) / len(vals)
    assert lo < mean < hi
    assert bootstrap_ci(vals, iters=1000, seed=7) == (lo, hi)


def test_empty_inputs_do_not_raise():
    """A harness that crashes on an empty arm loses the other arm's results too."""
    assert wilson(0, 0) == (0.0, 0.0)
    assert bootstrap_ci([]) == (0.0, 0.0)
