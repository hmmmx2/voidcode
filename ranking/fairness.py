"""Per-segment ranking quality, and whether sparse histories are under-served. Spec §8.3.

Run:  VC_WAREHOUSE=... python -m ranking.fairness --learners 300

WHY AN AGGREGATE NDCG IS NOT ENOUGH
-------------------------------------
`docs/METRICS.md` records NDCG@10 of 0.2143 over the eval cohort. That is a mean, and a mean is
exactly where a badly-served subgroup hides: a ranker can score well overall while failing the
learners who most need help, and nothing in the aggregate says so.

The spec asks for three things and this reports all three:
  * NDCG@10 per learner segment, not only in aggregate
  * a flag on any segment more than 15% below the mean
  * specifically, whether learners with SPARSE HISTORIES are under-served

The third is named in the spec as "the most likely failure mode here", and the mechanism is
concrete: every feature the ranker uses is computed from a learner's past attempts, so a learner
with three of them has features that are mostly noise. A model fitted on learners with hundreds will
have learned to rely on signals the sparse learner does not have.

WHY THE COUNTS AND INTERVALS ARE PRINTED BESIDE EVERY RATE
------------------------------------------------------------
Segmenting divides an already-modest cohort into pieces, so per-segment n falls fast and the
intervals widen. A segment 20% below the mean with an interval spanning the mean is not a finding,
and reporting the gap without the interval is how this kind of audit produces false alarms. The 15%
rule is applied to the point estimate as the spec asks AND the interval is shown, so a flag can be
read as "look here" rather than "this is proven".

WHAT THIS CANNOT TELL YOU
---------------------------
These are **World A** learners — Codeforces handles with no demographic attributes of any kind. So
"fairness" here means quality parity across BEHAVIOURAL segments (how someone practises) and across
history depth. It says nothing about protected characteristics, because nothing in this corpus
carries them, and a segment audit is not a substitute for that.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Spec §8.3: "flag any segment where performance falls more than 15 percent below the mean".
UNDERSERVED_THRESHOLD = 0.15

#: History-depth buckets, in pre-cutoff problems attempted. The lowest bucket is the one the spec
#: singles out; the edges are round numbers rather than tuned, so they cannot be chosen to flatter
#: the result.
DEPTH_BUCKETS = ((1, 5, "1-5 (sparse)"), (6, 20, "6-20"), (21, 60, "21-60"), (61, 10**9, "61+"))


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def per_learner_ndcg(score: np.ndarray, y: np.ndarray, groups: np.ndarray,
                     seed: int) -> list[float]:
    """NDCG@10 for each learner block, rather than the mean over them.

    `ranking.eval.evaluate_rankers` computes exactly these values and returns only their mean. They
    are recomputed here instead of changing that function, because it produces the numbers already
    in the ledger and widening its return type to serve this audit would put those at risk for no
    benefit.

    The tie-break RNG is re-seeded per ranker exactly as `evaluate_rankers` does, so a per-segment
    number here is comparable with the aggregate there.
    """
    from ranking.eval import _ndcg_and_recall, rank_with_random_tiebreak

    rng = np.random.default_rng(seed)
    out, start = [], 0
    for size in groups:
        block = slice(start, start + size)
        order = rank_with_random_tiebreak(score[block], rng)
        _, at10, _ = _ndcg_and_recall(order, y[block])
        out.append(at10)
        start += size
    return out


def bootstrap_ci(values: list[float], replicates: int = 400,
                 seed: int = 0) -> tuple[float, float]:
    """Percentile bootstrap over learners. Returns (nan, nan) below 3 learners.

    A two-learner segment has no usable interval, and inventing one would give the widest, least
    reliable buckets the most confident-looking output.
    """
    if len(values) < 3:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    arr = np.asarray(values, dtype=float)
    draws = [float(np.mean(rng.choice(arr, size=len(arr), replace=True)))
             for _ in range(replicates)]
    return (float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5)))


def audit(ndcg_by_learner: dict[str, float], groups: pd.DataFrame,
          group_col: str, overall_mean: float) -> pd.DataFrame:
    """NDCG@10 per group, with counts, intervals, and the spec's 15% flag.

    `groups` must carry `learner_id` and `group_col`.
    """
    rows = []
    for name, block in groups.groupby(group_col):
        vals = [ndcg_by_learner[i] for i in block.learner_id if i in ndcg_by_learner]
        if not vals:
            continue
        mean = float(np.mean(vals))
        low, high = bootstrap_ci(vals)
        rel = (mean - overall_mean) / overall_mean if overall_mean else float("nan")
        rows.append({
            "group": name,
            "learners": len(vals),
            "ndcg_at_10": round(mean, 4),
            "ci_low": round(low, 4), "ci_high": round(high, 4),
            "vs_mean": round(rel, 4),
            # The spec's rule, on the point estimate. The interval sits beside it so a flag on a
            # tiny group can be read for what it is.
            "underserved": bool(rel < -UNDERSERVED_THRESHOLD),
            # Whether the interval clears the overall mean at all. A flagged group whose interval
            # contains the mean is a place to look, not a demonstrated gap.
            "ci_excludes_mean": bool(high < overall_mean or low > overall_mean),
        })
    return pd.DataFrame(rows).sort_values("ndcg_at_10").reset_index(drop=True)


def depth_bucket(n: int) -> str:
    for lo, hi, label in DEPTH_BUCKETS:
        if lo <= n <= hi:
            return label
    return DEPTH_BUCKETS[-1][2]


#: Strata of post-cutoff SOLVED problems — the items NDCG can actually reward.
POSITIVE_STRATA = ((0, 1, "1"), (2, 3, "2-3"), (4, 8, "4-8"), (9, 10**9, "9+"))


def positive_stratum(n: int) -> str:
    for lo, hi, label in POSITIVE_STRATA:
        if lo <= n <= hi:
            return label
    return POSITIVE_STRATA[-1][2]


def stratified(ndcg_by_learner: dict[str, float], depth: pd.DataFrame,
               positives: pd.DataFrame) -> pd.DataFrame:
    """NDCG@10 by history depth WITHIN strata of positive count.

    WITHOUT THIS THE HEADLINE GAP IS OVERSTATED, and the reason is mechanical. Sparse learners have
    a median of 2 post-cutoff solves against 4 / 8 / 10 for the deeper buckets. Finding 1 of 2
    relevant items in the top 10 of ~11,000 candidates is a harder task than finding 1 of 10, so
    part of the raw difference is the job rather than the ranker.

    Holding the positive count fixed separates the two. Measured on 700 learners, the answer is
    "both": at 1 positive there is NO gap (sparse 0.0945 n=78 against 0.1006 n=33), while at 4-8
    positives sparse learners score 0.1844 n=58 against 0.2561 n=104 for the same task. So a real
    weakness survives the control, and it is roughly half the headline rather than all of it.
    """
    frame = pd.DataFrame({"learner_id": list(ndcg_by_learner), "ndcg": list(ndcg_by_learner.values())})
    frame = frame.merge(depth[["learner_id", "bucket"]], on="learner_id", how="left")
    frame = frame.merge(positives[["learner_id", "n_pos"]], on="learner_id", how="left")
    frame["n_pos"] = frame.n_pos.fillna(0).astype(int)
    frame["stratum"] = frame.n_pos.map(positive_stratum)
    means = frame.pivot_table(index="stratum", columns="bucket", values="ndcg", aggfunc="mean")
    counts = frame.pivot_table(index="stratum", columns="bucket", values="ndcg", aggfunc="size")
    # Cells carry their n. Without it the thin ones read as findings: the first run of this table
    # showed 0.0000 for 21-60 at one positive and 0.4438 for 61+ at two, and both were single
    # learners. Every rate in this repo is quoted beside the count it came from, for that reason.
    order = [s for _, _, s in POSITIVE_STRATA if s in means.index]
    cols = [b for _, _, b in DEPTH_BUCKETS if b in means.columns]
    out = pd.DataFrame(index=order, columns=cols, dtype=object)
    for s in order:
        for b in cols:
            m, c = means.at[s, b], counts.at[s, b]
            out.at[s, b] = "-" if pd.isna(m) else f"{m:.4f}(n={int(c)})"
    return out


def paired_delta(before: dict[str, float], after: dict[str, float], group_of: Mapping[str, str],
                 *, replicates: int = 2000, seed: int = 0) -> pd.DataFrame:
    """Per-learner paired difference between two rankers, bootstrapped within each group.

    USE THIS RATHER THAN COMPARING TWO TABLES BY EYE. Two candidate fixes were evaluated by reading
    per-stratum means side by side, and both times the eye-read said "mixed -- better here, worse
    there" while the paired test said "no effect anywhere". Cells of 40-90 learners carry more noise
    than the movements being interpreted, and the same learners appear in both runs, so pairing
    removes the between-learner variance that was hiding the answer.

    A caveat this cannot remove, so it is printed beside the result: testing k groups at 95% means
    roughly a 1-in-4 chance that one of five groups shows an interval excluding zero under a global
    null. A single flagged small group is not a finding on its own.
    """
    rng = np.random.default_rng(seed)
    shared = [learner for learner in before if learner in after]
    rows = []
    for name in ["ALL", *sorted({group_of.get(i, "?") for i in shared})]:
        members = shared if name == "ALL" else [i for i in shared if group_of.get(i) == name]
        diffs = np.array([after[i] - before[i] for i in members], dtype=float)
        if len(diffs) < 3:
            rows.append({"group": name, "learners": len(diffs), "mean_delta": float("nan"),
                         "ci_low": float("nan"), "ci_high": float("nan"), "verdict": "too few"})
            continue
        boot = np.array([rng.choice(diffs, len(diffs), replace=True).mean()
                         for _ in range(replicates)])
        lo, hi = (float(v) for v in np.percentile(boot, [2.5, 97.5]))
        rows.append({"group": name, "learners": len(diffs), "mean_delta": round(float(diffs.mean()), 4),
                     "ci_low": round(lo, 4), "ci_high": round(hi, 4),
                     "verdict": "no effect" if lo <= 0 <= hi else
                                ("improved" if lo > 0 else "degraded")})
    return pd.DataFrame(rows)


def main() -> int:
    _utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--learners", type=int, default=300)
    ap.add_argument("--k", type=int, default=0, help="segments; 0 uses the silhouette choice")
    ap.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = ap.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    from sklearn.cluster import KMeans

    from features.ranking import LabelledExample, train_ranker
    from features.segment import build_matrix as segment_matrix
    from ranking.eval import (
        CUTOFF_QUANTILE,
        LIGHTGBM_MAX_QUERY_ROWS,
        SEED,
        build_matrix,
        compute_cutoff,
        evaluate_rankers,
        load_split,
    )

    info = compute_cutoff(args.warehouse, quantile=CUTOFF_QUANTILE)
    cutoff = info["cutoff_epoch"]
    pre, post = load_split(args.warehouse, cutoff)
    print(f"  cutoff {cutoff}; {len(pre):,} pre / {len(post):,} post rows")

    eligible = sorted(set(post.learner_id) & set(pre.learner_id))
    rng = np.random.default_rng(SEED)
    chosen = list(rng.choice(eligible, size=min(args.learners, len(eligible)), replace=False))
    print(f"  auditing {len(chosen)} learners of {len(eligible):,} eligible")

    # Same preparation ranking/eval.main does. `build_matrix` needs an `n_concepts` column joined
    # onto the difficulty table; passing the raw table fails deep inside with an AttributeError.
    problems = pd.read_parquet(os.path.join(args.warehouse, "gold_problem_difficulty"))
    concepts = pd.read_parquet(os.path.join(args.warehouse, "gold_problem_concepts"))
    problems = problems.join(
        concepts.groupby("problem_id").size().rename("n_concepts"), on="problem_id"
    ).fillna({"n_concepts": 1})
    x, extras, y, groups = build_matrix(chosen, pre, post, problems, concepts, cutoff=cutoff)

    # Train on learners DISJOINT from the audited ones. Auditing a ranker on its own training
    # learners would measure memorisation, and a fairness gap that only appears out-of-sample is
    # exactly the gap worth finding.
    train_pool = [i for i in eligible if i not in set(chosen)]
    train_sample = list(rng.choice(train_pool, size=min(200, len(train_pool)), replace=False))
    xt, _, yt, gt = build_matrix(train_sample, pre, post, problems, concepts, cutoff,
                                 max_rows_per_learner=LIGHTGBM_MAX_QUERY_ROWS, rng=rng)
    examples: list[LabelledExample] = []
    start = 0
    for learner, size in zip(train_sample, gt, strict=True):
        for i, (row, label) in enumerate(zip(xt[start:start + size], yt[start:start + size],
                                             strict=True)):
            examples.append(LabelledExample(str(learner), str(i), int(label), tuple(row),
                                            info["cutoff_iso"]))
        start += size
    model = train_ranker(examples, num_boost_round=100)
    if model is None:
        print("  train_ranker declined to fit; auditing the difficulty baseline instead")

    results = evaluate_rankers(x, extras, y, groups, model)
    ranker = "lambdamart" if "lambdamart" in results else "difficulty_sorted_observed"
    print(f"  aggregate NDCG@10 ({ranker}): {results[ranker]['ndcg_at_10']:.4f}")

    beta, log_pop = extras[:, 0], extras[:, 1]
    score = (model.predict(x) if model is not None and ranker == "lambdamart"
             else np.where(log_pop >= np.median(log_pop), -beta, -np.inf))
    values = per_learner_ndcg(score, y, groups, SEED)
    ndcg_by_learner = dict(zip(chosen, values, strict=True))
    overall = float(np.mean(values))
    print(f"  per-learner mean: {overall:.4f} over {len(values)} learners\n")

    # ── history depth, the failure mode the spec names ───────────────────────
    depth = (pre[pre.learner_id.isin(chosen)]
             .groupby("learner_id").size().rename("n_pre").reset_index())
    depth["bucket"] = depth.n_pre.map(depth_bucket)
    print("  BY HISTORY DEPTH (pre-cutoff problems attempted)")
    print(audit(ndcg_by_learner, depth, "bucket", overall).to_string(index=False))

    # ── the control that stops the number above being read as all ranker ─────
    # Counted from `y`, not from `post`: these are the graded positives NDCG can actually reward,
    # so the stratum a learner lands in is the task the ranker was set rather than a proxy for it.
    n_pos, start = [], 0
    for size in groups:
        n_pos.append(int((y[start:start + size] > 0).sum()))
        start += size
    positives = pd.DataFrame({"learner_id": chosen, "n_pos": n_pos})
    med = (positives.merge(depth[["learner_id", "bucket"]], on="learner_id", how="left")
           .groupby("bucket").n_pos.median())
    print("\n  MEDIAN POSITIVES PER LEARNER, BY DEPTH")
    print("   ", {k: float(v) for k, v in med.items()})
    print("  Fewer positives is a harder retrieval task at fixed k, so part of the raw gap above")
    print("  is the job rather than the ranker. Holding it fixed separates the two:")
    print("\n  MEAN NDCG@10 BY DEPTH, WITHIN STRATA OF POSITIVE COUNT")
    print(stratified(ndcg_by_learner, depth, positives).to_string())

    # ── behavioural segments from 4.3a ───────────────────────────────────────
    try:
        sx, meta, _ = segment_matrix(args.warehouse, min_concepts=3)
        k = args.k or 2                      # silhouette chose 2; see docs/METRICS.md
        labels = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(sx)
        seg = meta.assign(segment=[f"segment_{v}" for v in labels])
        seg = seg[seg.learner_id.isin(chosen)]
        print(f"\n  BY BEHAVIOURAL SEGMENT (k={k}, from features/segment.py)")
        if seg.empty:
            print("    no overlap between the segmented population and the audited learners")
        else:
            print(audit(ndcg_by_learner, seg, "segment", overall).to_string(index=False))
    except Exception as exc:
        print(f"\n  segment audit unavailable: {type(exc).__name__}: {exc}")

    print(f"\n  Flag rule: more than {UNDERSERVED_THRESHOLD:.0%} below the overall mean.")
    print("  `ci_excludes_mean` is the column that separates a demonstrated gap from a small group.")
    print("  World A (Codeforces) learners: these are BEHAVIOURAL segments, not demographic ones.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
