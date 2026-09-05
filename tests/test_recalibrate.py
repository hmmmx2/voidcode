"""Tests for the probability calibrators in analysis/recalibrate.py.

These test the calibrators on synthetic data where the correct answer is KNOWN, which is the only way
to tell a working calibrator from one that merely produces plausible numbers. The 2PL fit in
`features/irt_2pl.py` had a scale-gauge bug that left beta and theta recovering above 0.94 while
discrimination recovered at 0.39 with a threefold inflation — nothing about the fit looked wrong on
real data. Synthetic recovery is what caught it.

The construction below is deliberate: a KNOWN monotone distortion is applied to well-calibrated
probabilities, and the calibrator has to undo it. That gives a ground truth to assert against
instead of "the number got smaller".
"""
from __future__ import annotations

import numpy as np
import pytest

from analysis.calibration import calibration_error, reliability
from analysis.recalibrate import fit_isotonic, fit_platt


def miscalibrated(n=40_000, seed=0):
    """Well-calibrated probabilities, then a known monotone squash toward 0.5.

    `true` is honest: outcomes are drawn AT that rate, so a perfect calibrator maps `distorted` back
    to `true`. The distortion is monotone, so it destroys calibration while preserving ranking — which
    is exactly the defect the 1PL was measured to have.
    """
    rng = np.random.default_rng(seed)
    true = rng.uniform(0.02, 0.98, n)
    y = (rng.uniform(size=n) < true).astype(float)
    distorted = 0.5 + (true - 0.5) * 0.55          # squash: overconfident near 0.5, compressed tails
    return distorted, y, true


def split(n, seed=0):
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    return np.array_split(idx, 2)


@pytest.mark.parametrize("fit", [fit_isotonic, fit_platt], ids=["isotonic", "platt"])
def test_calibrator_reduces_error_on_data_it_did_not_see(fit):
    """The claim that matters: fitted on one half, it must improve the OTHER half.

    A calibrator scored on its own fitting rows always improves — isotonic can drive training ECE to
    near zero by construction. This is the assertion that would fail if the split leaked.
    """
    p, y, _ = miscalibrated()
    a, b = split(len(y))
    ece_before, _ = calibration_error(reliability(p[b], y[b]))
    corrected = fit(p[a], y[a])(p[b])
    ece_after, _ = calibration_error(reliability(corrected, y[b]))
    assert ece_after < ece_before / 2, f"{ece_before:.4f} -> {ece_after:.4f}"


@pytest.mark.parametrize("fit", [fit_isotonic, fit_platt], ids=["isotonic", "platt"])
def test_calibration_recovers_the_known_true_probability(fit):
    """Stronger than ECE: the corrected value must approach the rate outcomes were DRAWN at.

    ECE is bucket-averaged, so a curve can score well while individual predictions are wrong. Here
    `true` is the generating probability, so this asserts the mapping is right pointwise.
    """
    p, y, true = miscalibrated()
    a, b = split(len(y))
    corrected = fit(p[a], y[a])(p[b])
    assert np.abs(corrected - true[b]).mean() < np.abs(p[b] - true[b]).mean() / 2


def test_isotonic_is_monotone_so_ranking_is_untouched():
    """The load-bearing property behind "no ranking result changes".

    Every recommendation ranks on these values. If a calibrator could reorder them, applying it would
    silently invalidate the measured NDCG in docs/METRICS.md, and the recalibration would have to be
    re-justified as a ranking change rather than a reporting fix.
    """
    p, y, _ = miscalibrated(n=8_000)
    a, b = split(len(y))
    corrected = fit_isotonic(p[a], y[a])(p[b])
    order = np.argsort(p[b], kind="stable")
    assert np.all(np.diff(corrected[order]) >= -1e-12)


def test_platt_cannot_fix_a_bend_but_isotonic_can():
    """The measured difference between them, as an executable claim.

    On real data Platt made the mid-range WORSE than raw (|gap| 0.091 against 0.052) while still
    improving overall ECE. Two parameters can stretch and shift a curve but cannot unbend one. This
    pins that reasoning to a case where the bend is constructed, so the asymmetry is not just an
    observation about one dataset.
    """
    rng = np.random.default_rng(1)
    n = 60_000
    true = rng.uniform(0.02, 0.98, n)
    y = (rng.uniform(size=n) < true).astype(float)
    # A bend a logistic in logit space cannot represent: mid-range pushed up, tails left alone.
    bent = np.clip(true + 0.18 * np.exp(-((true - 0.45) ** 2) / 0.02), 0.001, 0.999)
    a, b = split(n)
    err = {}
    for name, fit in (("isotonic", fit_isotonic), ("platt", fit_platt)):
        corrected = fit(bent[a], y[a])(bent[b])
        mid = (true[b] > 0.3) & (true[b] < 0.6)
        err[name] = float(np.abs(corrected[mid] - true[b][mid]).mean())
    assert err["isotonic"] < err["platt"], err


def test_out_of_range_input_does_not_produce_nan():
    """`out_of_bounds="clip"` in fit_isotonic. Without it a test probability beyond the calibration
    range returns NaN, which propagates into ECE as a silently missing bucket rather than an error."""
    p, y, _ = miscalibrated(n=4_000)
    apply = fit_isotonic(p, y)
    out = apply(np.array([0.0, 1.0, 0.5]))
    assert np.isfinite(out).all()
    assert ((out >= 0.0) & (out <= 1.0)).all()
