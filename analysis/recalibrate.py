"""Recalibrate the 1PL's probabilities. Follow-up to `analysis/calibration.py`.

Run:  VC_WAREHOUSE=... python -m analysis.recalibrate

`analysis/calibration.py` measured the Rasch fit as systematically overconfident in the mid-range —
predicted 0.45 against observed 0.28, MCE 0.171 — while being accurate at the extremes, where 71% of
the mass sits. `features/irt_2pl.py` then established that a 2PL is **not** the answer: it removes the
extreme betas but predicts 6.1% worse held out, because 11,284 discriminations cannot be estimated
from a median of 7 observations each.

So the model stays and its output gets a monotone correction. That keeps the better predictor and
targets the actual defect, which is the reliability curve rather than the ranking — a monotone map
cannot change the order of anything, so nothing that ranks on these values is affected.

THE THREE-WAY SPLIT IS THE WHOLE METHOD
-----------------------------------------
A calibrator fitted and evaluated on the same rows ALWAYS looks excellent. Isotonic regression in
particular can drive training ECE to near zero by construction, so a two-way split would report a
spectacular improvement that means nothing.

    train       fit theta and beta            (the existing train_mask)
    calibrate   fit the correction only       (half the held-out rows)
    test        measure ECE and MCE           (the other half, touched by neither)

Every number below is on `test`. The raw and corrected figures come from the same rows, so the
comparison is paired.

ISOTONIC AND PLATT, BECAUSE THEY FAIL DIFFERENTLY
---------------------------------------------------
**Platt** fits a logistic on the logit — two parameters, so it can only stretch and shift the curve.
It cannot fix a bend, and the measured defect *is* a bend: overconfident in the middle, fine at both
ends.

**Isotonic** fits an arbitrary non-decreasing step function. It can fix a bend, and with few points
per region it overfits — which is exactly what the held-out `test` split is there to expose.

Both are reported. If isotonic wins on held-out data it is the right choice; if the two are close,
Platt is preferable for being smooth and two numbers rather than a step function nobody can inspect.

THIS BASELINE IS NOT docs/METRICS.md's BASELINE. DO NOT COMPARE THEM
---------------------------------------------------------------------
`analysis/calibration.py` reports ECE 0.0348 / MCE 0.1708. The raw 1PL row below is a different and
much smaller number, and the difference is the measurement, not an improvement:

    calibration.py    the PERSISTED warehouse theta/beta, scored on EVERY pair — including the
                      rows those parameters were fitted on. In-sample.
    here              a fresh train-only fit, scored on rows it has never seen. Out-of-sample.

An in-sample number should be BETTER than an out-of-sample one, and it is worse.

**`analysis/recalibrate_kfold.py` resolved this; the answer is not what was guessed here.** The first
hypothesis was a stale warehouse table — a fit nothing in this repo still produces. That is wrong:
β sd is 3.17 with the same 482 extreme values `fit_rasch` produces, and `solved` is clean binary.

The real answer is that scoring parameters on the rows that produced them selects *different rows*
into each bucket. In the 0.35-0.55 band, in-sample reads predicted 0.404 -> observed 0.241 (gap
-0.163) while out-of-fold reads 0.403 -> 0.435 (gap +0.031): same predicted value, opposite error.
So `analysis/calibration.py` measures the fit's memory rather than its calibration, and its ECE
0.0348 / MCE 0.1708 must not be quoted as the platform's calibration figure.

**Prefer `recalibrate_kfold.py` over this module for any reported number.** One 10% holdout leaves the
mid-range buckets with 221-857 rows and a 0.044 noise floor, which is why the mid-range verdict below
comes out "inside the noise". Out-of-fold over all 1.32M rows the floor is 0.010 and the mid-range is
decisively corrected, 0.045 -> 0.006. This module remains the readable two-calibrator comparison and
the place `fit_isotonic` / `fit_platt` live.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Fixed, so a reported improvement can be reproduced exactly.
SEED = 20260813


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def fit_platt(p: np.ndarray, y: np.ndarray):
    """Logistic regression on the logit. Returns a callable mapping raw p -> corrected p."""
    from sklearn.linear_model import LogisticRegression

    logit = np.log(np.clip(p, 1e-9, 1 - 1e-9) / (1 - np.clip(p, 1e-9, 1 - 1e-9)))
    model = LogisticRegression(C=1e6).fit(logit.reshape(-1, 1), y)

    def apply(raw: np.ndarray) -> np.ndarray:
        raw = np.clip(raw, 1e-9, 1 - 1e-9)
        return model.predict_proba(np.log(raw / (1 - raw)).reshape(-1, 1))[:, 1]

    return apply


def fit_isotonic(p: np.ndarray, y: np.ndarray):
    """Non-decreasing step function. `out_of_bounds="clip"` so a test probability outside the
    calibration range maps to the nearest fitted value rather than to NaN."""
    from sklearn.isotonic import IsotonicRegression

    model = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(p, y)
    return lambda raw: model.predict(raw)


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    from analysis.calibration import calibration_error, reliability, sigmoid
    from features.irt import fit_rasch
    from features.irt_data import load_observations

    obs = load_observations(args.warehouse)
    y = obs.lp[obs.target].to_numpy(dtype=float)
    train = obs.train_mask

    # The held-out rows, split in two. See the module docstring: the calibrator must never be
    # measured on the rows it was fitted on.
    held = np.flatnonzero(~train)
    rng = np.random.default_rng(SEED)
    rng.shuffle(held)
    calib, test = np.array_split(held, 2)
    print(f"  {int(train.sum()):,} train / {len(calib):,} calibrate / {len(test):,} test\n")

    theta, beta, _ = fit_rasch(obs.li[train], obs.pi[train], y[train],
                               obs.n_learners, obs.n_problems,
                               epochs=args.epochs, verbose=False)

    def raw(rows):
        return sigmoid(theta[obs.li[rows]] - beta[obs.pi[rows]])

    p_calib, p_test = raw(calib), raw(test)
    y_calib, y_test = y[calib], y[test]

    def score(p, label):
        """ECE, MCE, and separately the MID-RANGE gap — because those can move in opposite
        directions, and the mid-range is the one STATE.md asked to fix. ECE is mass-weighted, so
        71% of the rows sitting at the extremes let a large mid-range error average away to
        almost nothing."""
        table = reliability(p, y_test)
        ece, mce = calibration_error(table)
        mid = table[(table.predicted > 0.15) & (table.predicted < 0.75)]
        # Worst by ABSOLUTE gap: a correction that overshoots into underconfidence is still wrong,
        # and taking the min would score an overshoot as an improvement.
        worst = float(mid.gap.abs().max()) if len(mid) else 0.0
        print(f"  {label:22} ECE {ece:.4f}   MCE {mce:.4f}   worst |mid-range gap| {worst:.3f}")
        return ece, mce, worst, table

    print("  measured on `test`, which neither the model nor the calibrator has seen:")
    raw_scores = score(p_test, "raw 1PL")
    results = {}
    for name, fit in (("Platt", fit_platt), ("isotonic", fit_isotonic)):
        corrected = np.clip(fit(p_calib, y_calib)(p_test), 0.0, 1.0)
        results[name] = score(corrected, name)

    ece_raw, mce_raw, mid_raw, table_raw = raw_scores
    best = min(results, key=lambda k: results[k][0])
    ece_best, mce_best, mid_best, table_best = results[best]

    # The curve, not just its summary. Every collapsed-to-one-number calibration claim in this
    # project has hidden something; the per-bucket rows are what make the shape auditable.
    # `se` is the binomial standard error of the OBSERVED rate, sqrt(o(1-o)/n). Without it this
    # table is unfalsifiable: the mid-range buckets here hold a few hundred rows out of 65,898,
    # because the mass is at the extremes. A gap smaller than ~2*se is noise, and the first version
    # of this module reported a 33.6% mid-range improvement that was exactly that size.
    print(f"\n  reliability curve, raw vs {best} (n is shared — same rows):")
    print(f"    {'bucket':<10} {'n':>7}  {'raw pred':>9} {'raw obs':>8}  "
          f"{'new pred':>9} {'new obs':>8}  {'2*se':>6}")
    merged = table_raw.merge(table_best, on="bucket", suffixes=("_raw", "_new"), how="outer")
    for row in merged.itertuples():
        n = row.n_raw if not np.isnan(row.n_raw) else row.n_new
        o = row.observed_raw
        se2 = 2 * float(np.sqrt(max(o * (1 - o), 0.0) / max(n, 1)))
        print(f"    {row.bucket:<10} {int(n):>7}  {row.predicted_raw:>9.3f} {row.observed_raw:>8.3f}"
              f"  {row.predicted_new:>9.3f} {row.observed_new:>8.3f}  {se2:>6.3f}")

    # Is the mid-range change bigger than the noise in the mid-range buckets it is measured on?
    mid_rows = table_raw[(table_raw.predicted > 0.15) & (table_raw.predicted < 0.75)]
    mid_noise = float(np.sqrt(sum(
        4 * r.observed * (1 - r.observed) / r.n for r in mid_rows.itertuples()
    ) / max(len(mid_rows), 1)))

    print(f"\n  best by ECE: {best}")
    print(f"    ECE                   {ece_raw:.4f} -> {ece_best:.4f}   "
          f"({(ece_raw - ece_best) / ece_raw * 100:+.1f}%)")
    print(f"    MCE                   {mce_raw:.4f} -> {mce_best:.4f}   "
          f"({(mce_raw - mce_best) / mce_raw * 100:+.1f}%)")
    print(f"    worst |mid-range gap| {mid_raw:.3f} -> {mid_best:.3f}   "
          f"({(mid_raw - mid_best) / mid_raw * 100:+.1f}%)")
    print(f"    typical mid-range noise (2*se) {mid_noise:.3f}")
    print()

    # The verdict keys on the MID-RANGE against its own noise floor, which is what was asked for.
    # Two earlier versions of this block were wrong in different ways: the first keyed on MCE and
    # announced the bend fixed while the mid-range gap doubled; the second compared the mid-range
    # gap to a bare 0.7x threshold and cleared it by 0.001 on buckets of 253 rows.
    mid_moved = (mid_raw - mid_best) > mid_noise
    if mid_moved and mid_best < mid_raw:
        print("  The mid-range bend is corrected by more than the noise in those buckets. This is")
        print("  the fix docs/STATE.md item 1 asked for.")
    elif mid_best > mid_raw + mid_noise:
        print("  MID-RANGE GOT WORSE, even though ECE improved. ECE is mass-weighted and 71% of")
        print("  the rows are at the extremes, so a correction can buy a better average by")
        print("  trading away the band that was the entire point.")
    else:
        print("  ECE and MCE improve, and the MID-RANGE CHANGE IS INSIDE THE NOISE. The mid-range")
        print("  buckets hold a few hundred rows each out of 65,898, so this split cannot resolve")
        print("  a change of that size either way.")
        print()
        print("  So: adopt isotonic for the aggregate gain, which is real and out-of-sample and")
        print("  driven by the high-confidence buckets that hold the mass. Do NOT claim the")
        print("  mid-range defect is fixed — this measurement cannot see it. Settling that needs")
        print("  the mid-range measured on the full 1.32M rows, which means k-fold rather than one")
        print("  10% holdout: fit K times, calibrate out-of-fold, pool the predictions.")
    print()
    print("  A monotone map cannot reorder anything, so no ranking result changes. Only code that")
    print("  reads these values AS PROBABILITIES is affected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
