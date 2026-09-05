"""K-fold recalibration: measure the mid-range on all 1.32M rows, and settle the sign flip.

Run:  VC_WAREHOUSE=... python -m analysis.recalibrate_kfold

WHY THIS EXISTS RATHER THAN A FLAG ON recalibrate.py
------------------------------------------------------
`analysis/recalibrate.py` established that isotonic recalibration helps out-of-sample (ECE 0.0131 ->
0.0027) and left two questions it could not answer, both for the same reason: one 10% holdout puts
only 65,898 rows on the curve, and 71% of those sit above 0.8.

1. **The mid-range was unmeasurable.** Its buckets held 221-857 rows, a 2*se noise floor of ~0.044,
   against an apparent improvement of 0.017. Two drafts of that module reported success anyway.
2. **The sign flip was unexplained.** `analysis/calibration.py` records the mid-range as
   OVERconfident (predicted 0.45 -> observed 0.28, MCE 0.1708). The held-out fit came out
   UNDERconfident (0.656 -> 0.708, 0.758 -> 0.791). Both cannot describe the same curve.

K-fold fixes the first directly: every row gets an out-of-fold prediction, so the curve is measured on
the full 1,320,382 rather than a 5% slice, and the mid-range noise floor drops by ~sqrt(20).

It addresses the second by construction rather than by argument. The in-sample and out-of-sample
curves get printed together, from the same bucketing, so "in-sample vs out-of-sample" stops being a
hypothesis about why two numbers differ and becomes a row-by-row comparison.

THE NESTING, WHICH IS THE PART THAT IS EASY TO GET WRONG
---------------------------------------------------------
Two things must be out-of-sample, not one: the ABILITY/DIFFICULTY fit and the CALIBRATOR.

    for each fold k:
        fit theta/beta on folds != k          ->  predict fold k        (K Rasch fits)
    pool  ->  p_oof, an out-of-sample prediction for every row

    for each fold k:
        fit isotonic on p_oof[folds != k]     ->  apply to fold k       (no extra Rasch fits)
    pool  ->  calibrated, also out-of-sample for every row

The calibrator for fold k is fitted on *out-of-fold* predictions from the other folds. Fitting it on
in-sample predictions instead would train the correction on a distribution the model does not produce
at prediction time, which is the subtle version of the mistake the three-way split was guarding
against.

COLD START IS MEASURED SEPARATELY, BECAUSE IT IS A CANDIDATE ANSWER
--------------------------------------------------------------------
Out-of-fold, a row whose PROBLEM appears in no training fold gets beta at its initial value, so the
prediction is sigmoid(theta - ~0) and for a typical learner that is near 0.5. Those rows land in the
mid-range carrying no information about difficulty at all.

In-sample, that category does not exist: every problem was seen. So a mid-range populated by
cold-start rows out-of-sample and by genuine estimates in-sample is a mechanism that would produce
exactly the observed sign flip. It is reported as its own curve so the possibility is settled by
measurement rather than left as a plausible story.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: 5 folds: each fit still sees 80% of the data, and 5 Rasch fits is the runtime ceiling worth
#: paying here. More folds would tighten the per-fold fit and not change the pooled curve, which is
#: what is being measured.
N_FOLDS = 5

SEED = 20260813


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def curve(predicted, actual, label, *, quiet=False):
    """Reliability curve plus the noise floor of its own mid-range buckets.

    The 2*se column is not decoration. Without it a mid-range gap cannot be told from binomial noise,
    and `analysis/recalibrate.py` twice reported an improvement that was smaller than its own error
    bars.
    """
    from analysis.calibration import calibration_error, reliability

    table = reliability(np.asarray(predicted), np.asarray(actual))
    ece, mce = calibration_error(table)
    mid = table[(table.predicted > 0.15) & (table.predicted < 0.75)]
    worst = float(mid.gap.abs().max()) if len(mid) else 0.0
    noise = float(np.sqrt(sum(4 * r.observed * (1 - r.observed) / r.n
                             for r in mid.itertuples()) / max(len(mid), 1)))
    if not quiet:
        print(f"\n  {label}")
        print(f"    {'bucket':<10} {'n':>9}  {'pred':>6} {'obs':>6} {'gap':>7}  {'2*se':>6}")
        for r in table.itertuples():
            se2 = 2 * float(np.sqrt(max(r.observed * (1 - r.observed), 0.0) / max(r.n, 1)))
            flag = "" if abs(r.gap) <= se2 else "  <- outside noise"
            print(f"    {r.bucket:<10} {r.n:>9,}  {r.predicted:>6.3f} {r.observed:>6.3f} "
                  f"{r.gap:>+7.3f}  {se2:>6.3f}{flag}")
        print(f"    ECE {ece:.4f}   MCE {mce:.4f}   worst |mid-range gap| {worst:.3f}   "
              f"mid-range noise {noise:.3f}")
    return {"ece": ece, "mce": mce, "worst_mid": worst, "mid_noise": noise, "table": table}


def fold_assignment(n: int, folds: int = N_FOLDS, seed: int = SEED) -> np.ndarray:
    """Which fold each row belongs to. A pure function of `(n, folds, seed)`.

    Separated out so it can be reconstructed exactly without refitting — `features/export_calibration`
    caches the out-of-fold predictions to avoid five 2-minute Rasch fits, and a cache written before
    the fold labels were stored can recover them from here instead of recomputing everything.
    """
    fold = np.empty(n, dtype=int)
    order = np.random.default_rng(seed).permutation(n)
    for k, chunk in enumerate(np.array_split(order, folds)):
        fold[chunk] = k
    return fold


def out_of_fold_predictions(obs, y, *, folds=N_FOLDS, epochs=300, seed=SEED, verbose=True):
    """Out-of-sample sigmoid(theta - beta) for EVERY row, plus which rows had an estimable problem.

    Returns `(p_oof, problem_seen, fold)`. Extracted so `features/export_calibration.py` fits the
    shipped calibrator on exactly the predictions this module measures — a second implementation
    would be free to drift, and the artifact would then be calibrating something other than what the
    ledger reports.
    """
    from analysis.calibration import sigmoid
    from features.irt import fit_rasch

    n = len(y)
    fold = fold_assignment(n, folds, seed)
    p_oof = np.full(n, np.nan)
    problem_seen = np.zeros(n, dtype=bool)
    for k in range(folds):
        tr, te = fold != k, fold == k
        theta, beta, _ = fit_rasch(obs.li[tr], obs.pi[tr], y[tr],
                                   obs.n_learners, obs.n_problems,
                                   epochs=epochs, verbose=False)
        p_oof[te] = sigmoid(theta[obs.li[te]] - beta[obs.pi[te]])
        counts = np.bincount(obs.pi[tr], minlength=obs.n_problems)
        problem_seen[te] = counts[obs.pi[te]] > 0
        if verbose:
            print(f"  fold {k}: fitted on {int(tr.sum()):,}, predicted {int(te.sum()):,}; "
                  f"{int((~problem_seen[te]).sum()):,} rows had an unseen problem")

    assert not np.isnan(p_oof).any(), "every row must receive an out-of-fold prediction"
    return p_oof, problem_seen, fold


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folds", type=int, default=N_FOLDS)
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    from analysis.calibration import load_pairs
    from analysis.recalibrate import fit_isotonic, fit_platt
    from features.irt import log_loss
    from features.irt_data import load_observations

    obs = load_observations(args.warehouse)
    y = obs.lp[obs.target].to_numpy(dtype=float)
    n = len(y)
    print(f"  {n:,} observations, {obs.n_learners:,} learners, {obs.n_problems:,} problems")
    print(f"  {args.folds} folds x {args.epochs} epochs\n")

    # `problem_seen` records whether the row's problem was estimable from the training folds at all:
    # a problem seen zero times leaves beta at its initial value, so the prediction is prior-only.
    p_oof, problem_seen, fold = out_of_fold_predictions(
        obs, y, folds=args.folds, epochs=args.epochs)

    # Second level: the calibrator is fitted out-of-fold too, on other folds' out-of-fold predictions.
    corrected = {name: np.full(n, np.nan) for name in ("isotonic", "Platt")}
    for k in range(args.folds):
        tr, te = fold != k, fold == k
        for name, fit in (("isotonic", fit_isotonic), ("Platt", fit_platt)):
            corrected[name][te] = np.clip(fit(p_oof[tr], y[tr])(p_oof[te]), 0.0, 1.0)

    print("\n" + "=" * 78)
    print("  OUT-OF-SAMPLE, pooled over every row. This is the honest curve.")
    print("=" * 78)
    raw = curve(p_oof, y, f"raw 1PL, out-of-fold ({n:,} rows)")
    results = {name: curve(p, y, f"{name}, out-of-fold") for name, p in corrected.items()}

    print("\n" + "=" * 78)
    print("  IN-SAMPLE, for the sign flip. Same bucketing; persisted warehouse parameters")
    print("  scored on the rows they were fitted on — exactly what analysis/calibration.py does.")
    print("=" * 78)
    pairs = load_pairs(args.warehouse)
    ins = curve(pairs.predicted.to_numpy(), pairs.solved.to_numpy(dtype=float),
                f"warehouse theta/beta, in-sample ({len(pairs):,} rows)")

    print("\n" + "=" * 78)
    print("  COLD START: does the mid-range differ because out-of-fold rows have no difficulty?")
    print("=" * 78)
    print(f"  {int((~problem_seen).sum()):,} of {n:,} rows "
          f"({(~problem_seen).mean() * 100:.2f}%) had a problem no training fold saw.")
    if (~problem_seen).any():
        curve(p_oof[~problem_seen], y[~problem_seen], "raw 1PL, UNSEEN problems only")
    seen = curve(p_oof[problem_seen], y[problem_seen], "raw 1PL, seen problems only")

    print("\n" + "=" * 78)
    print("  VERDICT")
    print("=" * 78)
    ll_raw = log_loss(y, p_oof)
    print(f"\n  out-of-fold log loss: raw {ll_raw:.6f}")
    for name, p in corrected.items():
        ll = log_loss(y, p)
        print(f"                        {name} {ll:.6f} "
              f"({(ll_raw - ll) / ll_raw * 100:+.2f}% vs raw)")

    best = min(results, key=lambda k: results[k]["ece"])
    b = results[best]
    print(f"\n  best by ECE: {best}")
    print(f"    ECE                   {raw['ece']:.4f} -> {b['ece']:.4f}")
    print(f"    MCE                   {raw['mce']:.4f} -> {b['mce']:.4f}")
    print(f"    worst |mid-range gap| {raw['worst_mid']:.3f} -> {b['worst_mid']:.3f}")
    print(f"    mid-range noise floor {raw['mid_noise']:.3f} "
          f"(was 0.044 on the single 10% holdout)")

    moved = raw["worst_mid"] - b["worst_mid"]
    if moved > raw["mid_noise"]:
        print(f"\n  MID-RANGE RESOLVED: improves by {moved:.3f} against a noise floor of "
              f"{raw['mid_noise']:.3f}.")
        print("  This is the measurement docs/STATE.md item 1 asked for, and it now has the mass")
        print("  behind it to support the claim.")
    elif moved < -raw["mid_noise"]:
        print(f"\n  MID-RANGE GETS WORSE by {-moved:.3f}, outside the {raw['mid_noise']:.3f} noise")
        print("  floor. Do not apply this as a mid-range fix.")
    else:
        print(f"\n  MID-RANGE STILL UNRESOLVED: moves {moved:+.3f} against a floor of "
              f"{raw['mid_noise']:.3f}.")
        print("  With the full 1.32M rows on the curve this is no longer a sample-size problem —")
        print("  the mid-range is simply where the correction has little to fix.")

    print(f"\n  the sign flip: in-sample MCE {ins['mce']:.4f} vs out-of-fold "
          f"{raw['mce']:.4f}")
    ins_mid = ins["table"][(ins["table"].predicted > 0.35) & (ins["table"].predicted < 0.55)]
    oof_mid = raw["table"][(raw["table"].predicted > 0.35) & (raw["table"].predicted < 0.55)]
    for label, t in (("in-sample", ins_mid), ("out-of-fold", oof_mid)):
        if len(t):
            print(f"    {label:12} 0.35-0.55 band: predicted {t.predicted.mean():.3f} -> "
                  f"observed {t.observed.mean():.3f}  (gap {t.gap.mean():+.3f})")
    if (~problem_seen).any():
        print(f"    cold-start rows are {(~problem_seen).mean() * 100:.2f}% of the data; the "
              f"seen-only curve has MCE {seen['mce']:.4f}")
        print("    against the all-rows out-of-fold MCE above. If those differ little, cold start")
        print("    is NOT the explanation for the flip.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
