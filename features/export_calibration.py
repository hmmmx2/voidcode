"""Freeze the isotonic calibration map into an artifact the API can load. Spec §4.3b.

Run:  VC_WAREHOUSE=... python -m features.export_calibration --write

WHAT IS BEING SHIPPED, AND WHY IT IS A TABLE OF KNOTS RATHER THAN A PICKLE
---------------------------------------------------------------------------
`analysis/recalibrate_kfold.py` measured that an isotonic correction on sigmoid(theta - beta) takes
ECE from 0.0138 to 0.0001 and log loss from 0.229407 to 0.222866 — out-of-fold over all 1,320,382
rows. This writes that correction down so something other than an analysis script can apply it.

A fitted `sklearn.isotonic.IsotonicRegression` pickle would tie the API to a scikit-learn version and
make the mapping unreadable. An isotonic fit IS just a non-decreasing step function, so it serialises
completely as its knots. The JSON is diffable, reviewable, and applies with `bisect` from the standard
library — no numpy, no sklearn, no warehouse mount at request time.

THE CALIBRATOR IS FITTED ON OUT-OF-FOLD PREDICTIONS. THIS IS NOT AN IMPLEMENTATION DETAIL
-------------------------------------------------------------------------------------------
It would be easier to fit on the full-data theta/beta the warehouse already holds. That would be
wrong, and `analysis/recalibrate_kfold.py` measured how wrong: scoring parameters on the rows that
produced them reads the 0.35-0.55 band as predicted 0.404 -> observed 0.241, while out-of-fold reads
0.403 -> 0.435. Same predicted value, **opposite sign**. A calibrator fitted on the in-sample curve
would learn to push mid-range probabilities DOWN, when out-of-sample they need to go UP.

So the mapping is fitted on out-of-fold predictions, and it is applied at serving time to predictions
from the full-data fit. That asymmetry is deliberate and it is the correct pairing, because of what
serving actually asks:

    the API predicts for problems a learner has NOT attempted

An unattempted (learner, problem) pair contributed no row to the fit. That is precisely the
out-of-fold case, so the out-of-fold mapping is the one that describes it. Applying this map to a pair
the learner HAS already attempted would be the mismatch — and that pair needs no prediction, because
the outcome is known.

WHAT THIS ARTIFACT CANNOT DO, WHICH MATTERS MORE THAN WHAT IT CAN
------------------------------------------------------------------
theta and beta are fitted on **World A**: 117,453 Codeforces handles over 11,284 Codeforces problems.
The product's catalogue is **World B**: hand-authored ML items whose `difficulty` is the enum
`easy | medium | hard`. The two share no identifier — no platform problem has a Codeforces id, no
platform user has a handle.

**So this map cannot produce a solve probability for a platform problem, and nothing here pretends
otherwise.** Mapping "medium" onto a beta drawn from the Codeforces distribution would be inventing
the input, and docs/STATE.md already records that no model fitted on World A transfers to World B.
`apps/api/src/calibration.py` therefore refuses when the identifiers do not resolve, rather than
falling back to the raw sigmoid — a wrong probability served confidently is the failure mode this
project keeps finding, and a null is recoverable where a plausible number is not.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Bumped whenever the MEANING of the map changes (different model, different target, different
#: fitting protocol) so a stale artifact is detectable rather than silently applied. The API refuses
#: a version it does not know.
SCHEMA_VERSION = 1

#: Where the API looks by default. Overridable with VC_CALIBRATION_PATH; kept in the repo rather than
#: the warehouse because the API container has no warehouse mount, and a 5 KB step function is
#: configuration, not data.
DEFAULT_OUT = ROOT / "apps" / "api" / "data" / "calibration_map.json"



def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def assert_reconstructs(xs, ys, model, p: np.ndarray) -> float:
    """Fail unless linear interpolation over the shipped knots reproduces the fit EXACTLY.

    This is the check that caught the first two versions of this exporter. Both resampled the fitted
    curve onto a uniform grid and then thinned it, which is lossy wherever the real breakpoints are
    dense — and the loss is not benign. Interpolating across a jump emits values the fit never
    produces, and since isotonic assigns each group its own mean, a blended value is no longer that
    mean, so `predicted == observed` stops holding. The first version drove **MCE from 0.0712 to
    0.1411** and recorded an improved ECE while doing it; the second, with error-bounded thinning,
    still reached 0.1382.

    Shipping `X_thresholds_` / `y_thresholds_` removes the problem rather than bounding it:
    `IsotonicRegression.predict` IS linear interpolation over those arrays, so the API performs the
    identical operation and the tolerance is 0, not "small enough".
    """
    err = float(np.max(np.abs(np.interp(p, xs, ys) - model.predict(p))))
    if err > 1e-12:
        raise AssertionError(
            f"shipped knots do not reproduce the fit: max error {err:.3e}. Refusing to write a map "
            "the API would apply differently from how it was measured.")
    return err


def out_of_fold_quality(p_oof: np.ndarray, y: np.ndarray, fold: np.ndarray) -> dict:
    """Estimate what the SHIPPED map will achieve, by calibrating out-of-fold.

    The shipped map is fitted on every row, which is right for serving — more data, and it is applied
    to pairs that contributed no row. But scoring that map on the rows it was fitted on is
    meaningless: isotonic assigns each group its observed mean, so in-sample ECE and MCE come out at
    **exactly 0.0**. Recording that would be the most flattering number in the project and the least
    informative.

    So quality is estimated the way `analysis/recalibrate_kfold.py` measures it — fit the correction
    on other folds, score the held fold — and the artifact carries that instead.
    """
    from sklearn.isotonic import IsotonicRegression

    from analysis.calibration import calibration_error, reliability

    corrected = np.full(len(y), np.nan)
    for k in np.unique(fold):
        tr, te = fold != k, fold == k
        m = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(p_oof[tr], y[tr])
        corrected[te] = np.clip(m.predict(p_oof[te]), 0.0, 1.0)
    assert not np.isnan(corrected).any()

    before = calibration_error(reliability(p_oof, y))
    after = calibration_error(reliability(corrected, y))
    if after[0] > before[0] or after[1] > before[1]:
        raise AssertionError(
            f"out-of-fold calibration does not improve: ECE {before[0]:.6f}->{after[0]:.6f}, "
            f"MCE {before[1]:.6f}->{after[1]:.6f}. Refusing to write it.")
    return {"ece_before": round(before[0], 6), "ece_after": round(after[0], 6),
            "mce_before": round(before[1], 6), "mce_after": round(after[1], 6)}


def build_map(p_oof: np.ndarray, y: np.ndarray, fold: np.ndarray) -> dict:
    """Fit the shipped isotonic map and return it with the provenance needed to audit it."""
    from sklearn.isotonic import IsotonicRegression

    model = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(p_oof, y)
    # The fit's OWN breakpoints. `predict` is linear interpolation over these, so shipping them makes
    # the API's `apply` the same function rather than an approximation of it. See assert_reconstructs.
    xs = np.asarray(model.X_thresholds_, dtype=float)
    ys = np.asarray(model.y_thresholds_, dtype=float)
    reconstruction_error = assert_reconstructs(xs, ys, model, p_oof)
    measured = out_of_fold_quality(p_oof, y, fold)
    return {
        "schema_version": SCHEMA_VERSION,
        "model": "rasch-1pl-isotonic",
        "fitted_on": "out-of-fold predictions, 5 folds x 300 epochs",
        "n_observations": len(y),
        "domain": "codeforces",
        "identifier_space": {
            "learner": "codeforces_handle",
            "problem": "codeforces_problem_id",
            "note": ("World A only. No platform problem or user has one of these identifiers; see "
                     "the module docstring in features/export_calibration.py."),
        },
        # Estimated OUT-OF-FOLD, not on the rows the shipped map was fitted on. See
        # out_of_fold_quality: the in-sample figures are exactly 0.0 and mean nothing.
        "measured": {
            **measured,
            "estimated_how": ("out-of-fold: the correction was fitted on other folds and scored on "
                              "the held fold. The SHIPPED map is fitted on all rows, which is "
                              "correct for serving unseen pairs but cannot be scored in-sample."),
            # How closely linear interpolation over the shipped knots reproduces the fit. Exactly 0
            # by construction; recorded so a future change that breaks it is visible in the diff.
            "knot_reconstruction_error": reconstruction_error,
        },
        "knots": {"x": [round(float(v), 6) for v in xs],
                  "y": [round(float(v), 6) for v in ys]},
    }


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true",
                        help="write the artifact; default is a dry run that prints what it would do")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--cache", default=str(ROOT / ".cache" / "oof_predictions.npz"),
                        help="where the out-of-fold predictions are cached between runs")
    parser.add_argument("--refit", action="store_true",
                        help="ignore the cache and recompute the out-of-fold predictions")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    from analysis.recalibrate_kfold import fold_assignment, out_of_fold_predictions
    from features.irt_data import load_observations

    # The five Rasch fits take ~10 minutes, and every iteration on the KNOTS needs the same
    # predictions. Caching them turns a 10-minute loop into a 2-second one; the first version of this
    # module discarded them, so diagnosing a thinning bug meant refitting from scratch.
    cache = Path(args.cache)
    if cache.exists() and not args.refit:
        data = np.load(cache)
        p_oof, y = data["p_oof"], data["y"]
        # A cache written before fold labels were stored can still be used: the assignment is a pure
        # function of (n, folds, seed), so it reconstructs exactly rather than needing a refit.
        fold = (data["fold"] if "fold" in data.files
                else fold_assignment(len(y), args.folds))
        print(f"  reusing cached out-of-fold predictions from {cache} ({len(y):,} rows)")
        print("  pass --refit to recompute them\n")
    else:
        obs = load_observations(args.warehouse)
        y = obs.lp[obs.target].to_numpy(dtype=float)
        print(f"  {len(y):,} observations; {args.folds} folds x {args.epochs} epochs\n")
        p_oof, _, fold = out_of_fold_predictions(obs, y, folds=args.folds, epochs=args.epochs)
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache, p_oof=p_oof, y=y, fold=fold)
        print(f"\n  cached out-of-fold predictions to {cache}")

    artifact = build_map(p_oof, y, fold)
    m = artifact["measured"]
    print(f"\n  {len(artifact['knots']['x'])} knots — the fit's own breakpoints, reproduced exactly")
    print(f"  ECE {m['ece_before']:.6f} -> {m['ece_after']:.6f}")
    print(f"  MCE {m['mce_before']:.6f} -> {m['mce_after']:.6f}")
    print("  (estimated out-of-fold; the shipped map is fitted on all rows)")

    if not args.write:
        print(f"\n  DRY RUN. Pass --write to save to {args.out}")
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"\n  wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
