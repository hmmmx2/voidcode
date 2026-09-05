"""Learner segmentation. Spec §4.3a.

Run:  VC_WAREHOUSE=... python -m features.segment

k-means and a Gaussian mixture over the learner x concept mastery matrix, with k chosen by silhouette
and BIC rather than by eye, and stability measured by adjusted Rand index across bootstrap resamples.

THE TRAP THIS MODULE IS MOSTLY ABOUT
--------------------------------------
`docs/METRICS.md` limitation 3 records that the mastery matrix is **over 85% missing** — the median
learner has attempted 7 concepts of 67 observed. Cluster that matrix naively and you do not segment
learners by ability, you segment them by **how many concepts they have touched**, because the
dominant axis of variation is presence and absence.

The result looks identical either way: k clusters, a silhouette score, a tidy paragraph per segment.
So this module measures which one it found rather than assuming:

* **No zero-filling.** Zero mastery and never-attempted are opposite situations — one wants
  remediation, the other introduction — and `features/ranking.py` keeps `mastery_known` as a separate
  feature precisely so a model cannot confuse them. Filling with zeros here would reintroduce exactly
  that confusion into the clustering.
* **Coverage is reported as a cluster property.** If the clusters differ mostly in `n_concepts_attempted`
  and barely in mean mastery, the segmentation is a coverage segmentation and says so.
* **A learner floor.** `--min-concepts` restricts to learners with enough observed concepts for a
  mastery vector to mean anything, and the retained fraction is printed with every result — spec §4.3a
  asks for segments, not for segments of everybody.

WHY BOTH k-MEANS AND A GAUSSIAN MIXTURE
-----------------------------------------
Spec §4.3a names both, and they disagree in a useful way. k-means assumes roughly spherical,
equal-size clusters; a GMM allows different shapes and sizes and scores by BIC, which penalises
parameters. If the two pick very different k, the structure is not robust and neither number should be
quoted on its own.
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

#: Candidate cluster counts. Spec §4.3a does not name a range; this spans "a couple of broad types" to
#: "more segments than a curriculum could act on differently".
K_RANGE = (2, 3, 4, 5, 6, 7, 8)

#: Bootstrap resamples for the stability check. Spec §4.3a asks for stability; 20 is enough to tell a
#: mean ARI of 0.3 from one of 0.8, which is the distinction that matters.
STABILITY_RESAMPLES = 20

#: A learner needs at least this many observed concepts for a mastery vector to carry information.
#: The median learner has 7, so this keeps roughly half the cohort — reported, not hidden.
DEFAULT_MIN_CONCEPTS = 8


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def build_matrix(warehouse: str, min_concepts: int) -> tuple[np.ndarray, pd.DataFrame, list[str]]:
    """(features, per-learner metadata, concept order).

    The feature vector is mastery per concept, MEAN-IMPUTED per concept for the entries a learner has
    not attempted — not zero-filled. Imputing the concept mean says "no information, assume typical";
    zero says "attempted and failed everything", which is a different and much stronger claim about a
    learner who simply has not got there yet.
    """
    mastery = pd.read_parquet(
        os.path.join(warehouse, "gold_learner_concept_mastery"),
        columns=["learner_id", "concept_id", "recency_weighted_mastery", "attempt_count"])

    counts = mastery.groupby("learner_id").concept_id.nunique()
    keep = counts[counts >= min_concepts].index
    retained = len(keep) / max(len(counts), 1)
    print(f"  {len(keep):,} of {len(counts):,} learners have >={min_concepts} observed concepts "
          f"({retained:.0%} retained)")

    subset = mastery[mastery.learner_id.isin(keep)]
    wide = subset.pivot_table(index="learner_id", columns="concept_id",
                             values="recency_weighted_mastery")
    concepts = list(wide.columns)
    # Per-concept mean, so a learner missing a concept sits at that concept's average rather than at
    # zero. The clustering then separates on relative strength, not on presence.
    filled = wide.fillna(wide.mean())

    meta = pd.DataFrame({
        "learner_id": wide.index,
        "n_concepts_attempted": subset.groupby("learner_id").concept_id.nunique().reindex(wide.index),
        "mean_mastery": wide.mean(axis=1).to_numpy(),
        "total_attempts": subset.groupby("learner_id").attempt_count.sum().reindex(wide.index),
    }).reset_index(drop=True)
    return filled.to_numpy(dtype=float), meta, concepts


def choose_k(x: np.ndarray, seed: int = 0) -> pd.DataFrame:
    """Silhouette for k-means and BIC for a GMM, across `K_RANGE`."""
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.mixture import GaussianMixture

    # Silhouette is O(n^2) in memory, so it is scored on a subsample while the fit uses everything.
    rng = np.random.default_rng(seed)
    sample = rng.choice(len(x), min(4000, len(x)), replace=False)

    rows = []
    for k in K_RANGE:
        km = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(x)
        gmm = GaussianMixture(n_components=k, covariance_type="diag", random_state=seed).fit(x)
        rows.append({
            "k": k,
            "silhouette": float(silhouette_score(x[sample], km.labels_[sample])),
            "inertia": float(km.inertia_),
            "bic": float(gmm.bic(x)),
        })
    return pd.DataFrame(rows)


def stability(x: np.ndarray, k: int, resamples: int = STABILITY_RESAMPLES,
              seed: int = 0) -> float:
    """Mean adjusted Rand index between a full fit and fits on bootstrap resamples.

    ARI on the OVERLAP only. A resample omits ~37% of learners, and scoring agreement on learners one
    of the two fits never saw would measure sampling, not stability.
    """
    from sklearn.cluster import KMeans
    from sklearn.metrics import adjusted_rand_score

    rng = np.random.default_rng(seed)
    reference = KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(x)

    scores = []
    for r in range(resamples):
        idx = rng.integers(0, len(x), len(x))
        labels = KMeans(n_clusters=k, n_init=10, random_state=seed + r + 1).fit_predict(x[idx])
        unique, first = np.unique(idx, return_index=True)
        scores.append(adjusted_rand_score(reference[unique], labels[first]))
    return float(np.mean(scores))


def describe(x: np.ndarray, meta: pd.DataFrame, k: int, seed: int = 0) -> pd.DataFrame:
    from sklearn.cluster import KMeans

    labels = KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(x)
    meta = meta.assign(segment=labels)
    return meta.groupby("segment").agg(
        learners=("learner_id", "size"),
        mean_mastery=("mean_mastery", "mean"),
        concepts_attempted=("n_concepts_attempted", "mean"),
        total_attempts=("total_attempts", "mean"),
    ).reset_index()


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-concepts", type=int, default=DEFAULT_MIN_CONCEPTS)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    x, meta, concepts = build_matrix(args.warehouse, args.min_concepts)
    print(f"  matrix {x.shape[0]:,} learners x {len(concepts)} concepts\n")

    scores = choose_k(x)
    print(f"  {'k':>3} {'silhouette':>12} {'BIC':>16}")
    best_sil = scores.loc[scores.silhouette.idxmax(), "k"]
    best_bic = scores.loc[scores.bic.idxmin(), "k"]
    for _, r in scores.iterrows():
        marks = []
        if r.k == best_sil:
            marks.append("best silhouette")
        if r.k == best_bic:
            marks.append("best BIC")
        print(f"  {int(r.k):>3} {r.silhouette:>12.4f} {r.bic:>16,.0f}"
              + (f"   <- {', '.join(marks)}" if marks else ""))

    print(f"\n  k-means picks k={int(best_sil)} by silhouette; GMM picks k={int(best_bic)} by BIC")
    if best_sil != best_bic:
        print("  THEY DISAGREE. The structure is not robust to the choice of model, so neither k")
        print("  should be quoted on its own — see the module docstring.")

    k = int(best_sil)
    ari = stability(x, k)
    print(f"\n  stability at k={k}: mean ARI {ari:.4f} over {STABILITY_RESAMPLES} resamples")
    sil = float(scores.loc[scores.k == k, "silhouette"].iloc[0])
    if ari > 0.8 and sil < 0.2:
        # Both numbers are true and they say different things. Reporting only the ARI oversells it.
        print(f"  Note the pair: ARI {ari:.2f} with silhouette {sil:.2f} means the SAME WEAKLY")
        print("  SEPARATED split is found every time. Highly reproducible, not sharply divided -")
        print("  usable for describing a population, too soft to route an individual learner on.")
    if ari < 0.5:
        print("  Below 0.5 — the segment assignment moves substantially between resamples, so these")
        print("  are not stable populations and should not be used to make different decisions.")

    table = describe(x, meta, k)
    print(f"\n  segments at k={k}")
    print(f"  {'seg':>4} {'learners':>10} {'mean mastery':>14} {'concepts':>10} {'attempts':>10}")
    for _, r in table.iterrows():
        print(f"  {int(r.segment):>4} {int(r.learners):>10,} {r.mean_mastery:>14.3f} "
              f"{r.concepts_attempted:>10.1f} {r.total_attempts:>10.1f}")

    # THE CHECK THE MODULE EXISTS FOR. If the segments differ far more in coverage than in mastery,
    # this is a coverage segmentation wearing an ability label.
    mastery_spread = table.mean_mastery.max() - table.mean_mastery.min()
    coverage_ratio = table.concepts_attempted.max() / max(table.concepts_attempted.min(), 1e-9)
    print(f"\n  mastery spread across segments   {mastery_spread:.3f}")
    print(f"  coverage ratio across segments   {coverage_ratio:.2f}x")
    if mastery_spread < 0.15 and coverage_ratio > 2.0:
        print("\n  THIS IS A COVERAGE SEGMENTATION, NOT AN ABILITY ONE. The segments barely differ in")
        print("  mastery and differ several-fold in how many concepts they have attempted, which is")
        print("  the failure docs/METRICS.md limitation 3 predicts for an 85%-missing matrix.")
        print("  Do not describe these as ability tiers.")
    else:
        print("\n  The segments differ in mastery as well as coverage, so this is not purely a")
        print("  coverage artefact — but read both numbers before calling them ability tiers.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
