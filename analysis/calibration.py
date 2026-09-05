"""Is the IRT fit's probability actually a probability? Spec §4.3b.

Run:  VC_WAREHOUSE=... python -m analysis.calibration

The Rasch model predicts P(learner solves problem) = sigmoid(theta - beta), and
`docs/METRICS.md` records a held-out log loss of 0.22661 for it. **Log loss does not tell you the
probabilities are usable.** A model can score well on log loss while being systematically
overconfident — the errors it makes on the confident predictions are exactly where log loss is least
sensitive, and every downstream consumer treats 0.9 as "90% likely".

Calibration asks the different question: of everything predicted at 0.9, did about 90% actually
happen? That is what a recommender needs, because it thresholds and ranks on these values.

WHAT IT FOUND, AND IT WAS NOT WHAT I EXPECTED
------------------------------------------------
The hypothesis going in: `quality/contracts.py` had just found 482 problems with |beta| > 10 and 83% of
those with two or fewer observations, so the thin tail should be wrecking calibration.

**Backwards.** The thinly-observed subset is BETTER calibrated (ECE 0.0224) than the well-observed one
(ECE 0.0352). The real pattern is systematic overconfidence in the MID-RANGE:

    predicted 0.45  ->  observed 0.28    gap -0.177
    predicted 0.35  ->  observed 0.19    gap -0.164
    predicted 0.55  ->  observed 0.39    gap -0.160

and slight UNDER-confidence at the top (predicted 0.96 -> observed 0.98).

That shape is what a 1PL model does. Rasch gives every learner a single `theta` and every problem a
single `beta`, with no discrimination parameter — so it cannot express that outcomes near a learner's
ability threshold depend on which topic the problem is, not just how hard it is. Far from the
threshold the single parameter is enough and the fit is good; in the uncertain band it averages over
topics the learner is strong and weak at, and over-predicts success.

The corpus makes this easy to miss: 71% of outcomes fall in the 0.9-1.0 bucket, where the model is
accurate, so the aggregate ECE of 0.0348 looks fine while the 0.2-0.7 band is off by up to 0.18.

**The consequence for consumers.** These values are usable as a RANKING signal — the ordering is right
even where the level is wrong. They are not usable as probabilities in the 0.2-0.7 band, so nothing
should threshold on them there without recalibration. A 2PL fit with per-problem discrimination is the
principled fix.

WHY EXPECTED CALIBRATION ERROR AND NOT JUST A PLOT
-----------------------------------------------------
ECE is the average gap between confidence and accuracy, weighted by how many predictions fall in each
bucket. It collapses the reliability curve to one number that can go in the ledger and be tracked.
Maximum calibration error is reported alongside it because a small ECE can hide one badly-broken
bucket: if 2% of predictions are wrong by 0.4, ECE moves by 0.008 and the reliability curve has a
cliff in it.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Ten equal-width buckets, matching the deciles spec §4.3b asks for.
N_BUCKETS = 10

#: Below this many observations, a problem's beta is a boundary artefact rather than an estimate — the
#: threshold `quality/contracts.py` established from the catalogue median. Used to split the report,
#: NOT to filter the corpus: `docs/METRICS.md` limitation 6 records that filtering on observation
#: count biases evaluation toward easy problems.
MIN_OBSERVATIONS = 7


def _utf8_stdout() -> None:
    """Make printing non-ASCII safe when stdout is not a terminal.

    On Windows, Python picks cp1252 for a redirected stdout, so any print containing an em dash, a
    section sign or a box-drawing character raises UnicodeEncodeError. The failure is invisible
    interactively and fatal in CI or under a pipe — this module crashed halfway through its report the
    first time its output was redirected to a file, after printing 45 correct lines.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            # Already wrapped, or not a real stream. Nothing to do and nothing worth failing over.
            pass

def sigmoid(x: np.ndarray) -> np.ndarray:
    # Clipped before exp: a beta of 15 against a theta of -3 gives an exponent of 18, and the
    # un-clipped version overflows to inf on the tail this analysis exists to examine.
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def reliability(predicted: np.ndarray, actual: np.ndarray,
                n_buckets: int = N_BUCKETS) -> pd.DataFrame:
    """Per-bucket predicted vs observed rate.

    Equal-width buckets rather than equal-count. Equal-count quantile buckets hide the tails, and the
    tails are the question here — a bucket spanning 0.0 to 0.4 because that is where the mass sits
    tells you nothing about whether 0.05 predictions are honest.
    """
    edges = np.linspace(0.0, 1.0, n_buckets + 1)
    index = np.clip(np.digitize(predicted, edges[1:-1]), 0, n_buckets - 1)
    rows = []
    for b in range(n_buckets):
        mask = index == b
        if not mask.any():
            continue
        rows.append({
            "bucket": f"{edges[b]:.1f}-{edges[b + 1]:.1f}",
            "n": int(mask.sum()),
            "predicted": float(predicted[mask].mean()),
            "observed": float(actual[mask].mean()),
            "gap": float(actual[mask].mean() - predicted[mask].mean()),
        })
    return pd.DataFrame(rows)


def calibration_error(table: pd.DataFrame) -> tuple[float, float]:
    """(expected, maximum) calibration error.

    ECE weights each bucket's gap by its share of predictions; MCE takes the worst bucket outright.
    Reporting both because a small ECE can hide one badly-broken bucket.
    """
    total = table.n.sum()
    ece = float((table.n / total * table.gap.abs()).sum())
    mce = float(table.gap.abs().max())
    return ece, mce


def load_pairs(warehouse: str) -> pd.DataFrame:
    """Learner-problem outcomes joined to their Rasch parameters."""
    rows = pd.read_parquet(os.path.join(warehouse, "gold_learner_problem"),
                           columns=["learner_id", "problem_id", "solved"])
    ability = pd.read_parquet(os.path.join(warehouse, "gold_learner_ability"),
                              columns=["learner_id", "ability_theta"])
    difficulty = pd.read_parquet(os.path.join(warehouse, "gold_problem_difficulty"),
                                 columns=["problem_id", "difficulty_beta", "n_observations"])
    joined = rows.merge(ability, on="learner_id").merge(difficulty, on="problem_id")
    joined["predicted"] = sigmoid(joined.ability_theta - joined.difficulty_beta)
    return joined


def report(warehouse: str) -> int:
    pairs = load_pairs(warehouse)
    print(f"  {len(pairs):,} learner-problem outcomes with both parameters fitted\n")

    def block(label: str, frame: pd.DataFrame) -> tuple[float, float]:
        table = reliability(frame.predicted.to_numpy(), frame.solved.to_numpy().astype(float))
        ece, mce = calibration_error(table)
        print(f"  {label}  ({len(frame):,} outcomes)")
        print(f"  {'bucket':>12} {'n':>9} {'predicted':>10} {'observed':>9} {'gap':>8}")
        for _, r in table.iterrows():
            flag = "  <-- overconfident" if r.gap < -0.10 else (
                "  <-- underconfident" if r.gap > 0.10 else "")
            print(f"  {r.bucket:>12} {r.n:>9,} {r.predicted:>10.3f} {r.observed:>9.3f} "
                  f"{r.gap:>+8.3f}{flag}")
        print(f"    ECE {ece:.4f}   MCE {mce:.4f}\n")
        return ece, mce

    ece_all, _ = block("ALL problems", pairs)

    # Split, not filtered. The comparison is the point: if the well-observed subset is calibrated and
    # the whole corpus is not, the fault is the thin tail rather than the model.
    observed = pairs[pairs.n_observations >= MIN_OBSERVATIONS]
    thin = pairs[pairs.n_observations < MIN_OBSERVATIONS]
    ece_observed, _ = block(f"problems with >={MIN_OBSERVATIONS} observations", observed)
    if len(thin):
        block(f"problems with <{MIN_OBSERVATIONS} observations", thin)

    # The reading is driven by WHERE the error sits, not by the aggregate. An ECE under 0.05 with an
    # MCE of 0.18 is a corpus whose mass sits in the accurate region, not a calibrated model.
    table = reliability(pairs.predicted.to_numpy(), pairs.solved.to_numpy().astype(float))
    mid = table[(table.predicted > 0.15) & (table.predicted < 0.75)]
    worst_mid = float(mid.gap.min()) if len(mid) else 0.0
    top_share = float(pairs.predicted.gt(0.9).mean())

    print("  ── reading ────────────────────────────────────────────────────────")
    print(f"  ECE {ece_all:.4f} overall, and {top_share * 100:.0f}% of outcomes sit above 0.9 where")
    print("  the model is accurate. The aggregate is therefore flattered by the corpus shape.")
    if ece_observed > ece_all:
        print()
        print(f"  The thin tail is NOT the problem: ECE {ece_observed:.4f} where beta is estimable")
        print(f"  against {ece_all:.4f} overall. Thinly-observed problems are better calibrated,")
        print("  which is the opposite of what the |beta| > 10 finding suggested.")
    if worst_mid < -0.10:
        print()
        print(f"  The error is MID-RANGE OVERCONFIDENCE, worst {worst_mid:+.3f}. That is what a 1PL")
        print("  model does: one theta and one beta cannot express that outcomes near a learner's")
        print("  threshold depend on WHICH topic, so the uncertain band averages over their strong")
        print("  and weak concepts and over-predicts success.")
        print()
        print("  Usable as a RANKING signal — the ordering holds where the level does not. NOT")
        print("  usable as a probability in the 0.2-0.7 band. A 2PL fit with per-problem")
        print("  discrimination is the principled fix.")
    return 0


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2
    return report(args.warehouse)


if __name__ == "__main__":
    raise SystemExit(main())
