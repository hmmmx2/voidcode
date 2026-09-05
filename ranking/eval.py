"""Offline ranking evaluation: LambdaMART against two baselines. Spec §5.2.

Run:  VC_WAREHOUSE=... python -m ranking.eval --learners 500

Promised at `ranking/split.py:16` and never written, so `make rank-eval` has always exited non-zero.

WHY FEATURES ARE COMPUTED HERE RATHER THAN READ FROM `warehouse_train`
------------------------------------------------------------------------
`split.py` describes a separate `warehouse_train/` built from pre-cutoff data only, with
`assert_temporal_integrity` checking that the Spark run used `--max-created-at`. That works, and it
does not exist: building it needs a Spark rebuild.

This computes features from pre-cutoff rows of `gold_learner_problem` directly, which moves the
leakage question from *"did somebody build the right warehouse"* — a cross-artefact property nothing
in-process can check — to *"does this function filter on the cutoff"*, which is one unit test.
Fewer moving parts, and the guard is where the mistake would be made.

`assert_temporal_integrity` is still the right check if `warehouse_train` is ever built; this does not
replace it, it removes the dependency on it.

THE RANKING TASK, STATED PRECISELY
-------------------------------------
For each learner in the evaluation cohort:

  candidates  every catalogue problem they had NOT attempted before the cutoff
  label       `grade_for(attempts, solved)` from their POST-cutoff rows; 0 for anything they
              never touched
  features    computed from PRE-cutoff rows only

That is deliberately the full catalogue, not a sampled candidate set. Sampling negatives is the usual
shortcut and it inflates every metric: with 99 sampled negatives instead of 11,283 real ones, a
mediocre ranker looks excellent. The cost is paid in learners instead — a SAMPLE OF LEARNERS ranked
against the WHOLE catalogue, rather than every learner against a sampled slice. `--learners` controls
it and the sample size is reported with every number.

WHAT THE BASELINES ARE, AND WHY THESE TWO
--------------------------------------------
**Difficulty-sorted** — ascending `difficulty_beta` from the IRT fit. Reported as specified, and it
scores **0.0000**, which is real and is a finding about the difficulty estimates rather than about
easy-first as a strategy: the ten lowest-beta problems have 1-7 observations each against a catalogue
median of 7. A problem solved by one person gets an extreme easy beta because the fit has almost no
evidence. So this baseline ranks by ESTIMATION ARTEFACT and the top of its list is noise.

**Difficulty-sorted, well-observed** — the same ordering restricted to problems at or above the median
observation count, which is what a real system implementing "recommend easy things first" would
actually do. This is the fair version of the baseline and the one to read.

Both are reported. Dropping the degenerate one would hide why the naive baseline fails, and reporting
only the degenerate one would make the model look better than it is against a strawman.

**Popularity** — descending attempt count, **computed from pre-cutoff rows only**.

NOT `gold_problem_difficulty.n_observations`, which the first version used. That column totals
1,320,382 and correlates 1.0000 with the ALL-TIME row count against 0.9379 with pre-cutoff — the IRT
fit ran over the whole warehouse, so it includes the post-cutoff engagements being predicted. Ranking
by it gave the baseline future information about its own labels and inflated it.

`difficulty_beta` comes from the same all-time fit and leaks identically. It is left as-is and
labelled, because the difficulty baselines score zero regardless, so the leak cannot be flattering
them — but a future feature built on beta must not assume it is clean.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

from features.ranking import build_features, grade_for, ndcg_at_k, train_ranker
from ranking.split import CUTOFF_QUANTILE, _warehouse, compute_cutoff

#: Bootstrap replicates for the confidence intervals. 1,000 is enough for a 95% percentile interval
#: to be stable to about the third decimal, which is finer than any difference worth reporting here.
BOOTSTRAP_REPLICATES = 1000

#: Fixed, so a reported number can be reproduced exactly. An unseeded evaluation that moves between
#: runs cannot be argued about.
SEED = 20260812


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

def _read(table: str, warehouse: str, columns=None) -> pd.DataFrame:
    return pd.read_parquet(os.path.join(warehouse, table),
                           columns=list(columns) if columns else None)


def load_split(warehouse: str, cutoff: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Pre- and post-cutoff learner-problem rows.

    Split on `first_attempt_at`, matching `split.py:compute_cutoff` exactly. A pair whose first
    attempt precedes the cutoff belongs entirely to the past even if the learner returned to it
    later — splitting on `last_attempt_at` instead would put the same pair on both sides.
    """
    rows = _read("gold_learner_problem", warehouse,
                 ["learner_id", "problem_id", "attempts", "solved", "first_attempt_at"])
    return rows[rows.first_attempt_at < cutoff], rows[rows.first_attempt_at >= cutoff]


def assert_no_feature_leakage(pre: pd.DataFrame, cutoff: int) -> None:
    """Refuse to continue if any feature row is from after the cutoff.

    The one check that makes every number below meaningful. A leak here inflates all of them
    plausibly, and nothing downstream reveals it — see `docs/RANKING_DESIGN.md`.
    """
    late = int((pre.first_attempt_at >= cutoff).sum())
    if late:
        raise ValueError(
            f"{late} feature rows are at or after the cutoff ({cutoff}). Every metric computed from "
            "this split would be inflated by future information about the same learners.")


def pre_cutoff_popularity(pre: pd.DataFrame, problem_ids: np.ndarray) -> np.ndarray:
    """Attempts per problem BEFORE the cutoff, aligned to `problem_ids`.

    The whole point of computing it here rather than reading a stored column: a popularity figure
    that includes post-cutoff activity is future information about the labels. See the module
    docstring for the measurement that caught it.
    """
    counts = pre.groupby("problem_id").size()
    return np.array([counts.get(pid, 0) for pid in problem_ids], dtype=float)


def learner_concept_features(pre: pd.DataFrame, problem_concepts: pd.DataFrame) -> pd.DataFrame:
    """Per-(learner, concept) mastery from PRE-CUTOFF rows only.

    WHY THIS EXISTS, AND WHAT IT REPLACES.

    The first version passed one learner-level `solve_rate` for every candidate. That made seven of
    the nine features CONSTANT within a learner's block: only `difficulty` (3 buckets) and
    `n_concepts` (4 values) varied, so the model could emit just 12 distinct scores across 11,272
    candidates and the ranking was decided by tie-breaking.

    `build_features` was not wrong. It is designed for the product path, where candidates come from
    DIFFERENT concepts and `mastery` therefore varies per candidate. Feeding it a learner-level
    aggregate threw away the only signal it has.

    So mastery is computed per concept from the learner's own pre-cutoff rows, and a candidate is
    featurised against the concepts ITS problem teaches.
    """
    joined = pre.merge(problem_concepts, on="problem_id", how="inner")
    grouped = joined.groupby(["learner_id", "concept_id"])
    return pd.DataFrame({
        "attempts_on_concept": grouped.size(),
        "concept_solve_rate": grouped.solved.mean(),
        # Latest pre-cutoff touch, for the recency feature. From `first_attempt_at` rather than
        # `last_attempt_at`: the latter can fall after the cutoff for a pair that started before it,
        # which would leak the very thing the split exists to hide.
        "last_touch": grouped.first_attempt_at.max(),
    })


def learner_features(pre: pd.DataFrame) -> pd.DataFrame:
    """Per-learner aggregates from pre-cutoff rows only. The fallback for an unseen concept."""
    grouped = pre.groupby("learner_id")
    return pd.DataFrame({
        "n_attempted": grouped.size(),
        "n_solved": grouped.solved.sum(),
        "solve_rate": grouped.solved.mean(),
        "mean_attempts": grouped.attempts.mean(),
    })


#: LightGBM refuses a lambdarank query larger than this. Not a tuning knob — it is a hard limit in
#: the library, and hitting it is what forced the training/evaluation asymmetry below.
LIGHTGBM_MAX_QUERY_ROWS = 10000


def build_matrix(learners: list, pre: pd.DataFrame, post: pd.DataFrame,
                 problems: pd.DataFrame, problem_concepts: pd.DataFrame, cutoff: int = 0,
                 max_rows_per_learner: int | None = None,
                 rng: np.random.Generator | None = None
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """`(features, baseline_columns, labels, group_sizes)`.

    One block per learner: every catalogue problem they had not attempted pre-cutoff.

    `max_rows_per_learner` SUBSAMPLES NEGATIVES, AND IS FOR TRAINING ONLY.

    LightGBM rejects a lambdarank query above 10,000 rows, and a full-catalogue block is ~11,272. So
    training keeps every positive and samples negatives down to the limit.

    That asymmetry is deliberate and it is the right way round. Sampling negatives at TRAINING time
    changes what the model sees and is standard practice; sampling them at EVALUATION time changes
    what the metric MEANS — with 99 sampled negatives instead of 11,283 real ones, a mediocre ranker
    scores like an excellent one. Evaluation therefore passes `max_rows_per_learner=None` and ranks
    the whole catalogue.

    THE BASELINE COLUMNS ARE KEPT OUT OF THE FEATURE MATRIX. An earlier version appended raw
    `difficulty_beta` and log popularity to the model's vector so the baselines could read them back
    out, and LightGBM rejected it: `train_ranker` declares exactly `FEATURE_NAMES`, nine columns.
    That error was the right one to get. The model's feature contract has to match the product path
    in `features/recommend.py` exactly, or this harness measures a ranker the product cannot run.
    """
    per_concept = learner_concept_features(pre, problem_concepts)
    # One primary concept per problem, so a candidate has a single mastery value to be scored
    # against. First by concept_id for determinism; a problem's concepts are unordered in storage.
    primary_concept = (problem_concepts.sort_values("concept_id")
                       .drop_duplicates("problem_id").set_index("problem_id").concept_id.to_dict())
    attempted_before = pre.groupby("learner_id").problem_id.apply(set).to_dict()
    post_by_learner = dict(post.groupby("learner_id").__iter__())

    problem_ids = problems.problem_id.to_numpy()
    difficulty = problems.difficulty_beta.to_numpy()
    # Pre-cutoff only. Using the stored n_observations here leaked the labels — see the docstring.
    popularity = pre_cutoff_popularity(pre, problem_ids)
    n_concepts = problems.n_concepts.to_numpy()

    rows, extras, labels, groups = [], [], [], []
    for learner in learners:
        seen = attempted_before.get(learner, set())
        mask = ~np.isin(problem_ids, list(seen))
        candidate_ids = problem_ids[mask]

        outcome = post_by_learner.get(learner)
        graded = {}
        if outcome is not None:
            for pid, attempts, solved in zip(outcome.problem_id, outcome.attempts,
                                             outcome.solved, strict=True):
                graded[pid] = grade_for(int(attempts), bool(solved))

        block_beta, block_pop, block_ncon = difficulty[mask], popularity[mask], n_concepts[mask]

        if max_rows_per_learner and len(candidate_ids) > max_rows_per_learner:
            # Keep every graded problem — they are the entire signal, and dropping one would train
            # the model on a learner who never engaged with anything.
            positives = np.array([pid in graded for pid in candidate_ids])
            keep = np.flatnonzero(positives)
            budget = max_rows_per_learner - len(keep)
            negatives = np.flatnonzero(~positives)
            if budget > 0 and len(negatives) > budget:
                generator = rng or np.random.default_rng(SEED)
                keep = np.concatenate([keep, generator.choice(negatives, budget, replace=False)])
            elif budget > 0:
                keep = np.concatenate([keep, negatives])
            keep = np.sort(keep)
            candidate_ids = candidate_ids[keep]
            block_beta, block_pop, block_ncon = block_beta[keep], block_pop[keep], block_ncon[keep]

        # The learner's own per-concept history, as a plain dict for a fast inner loop.
        try:
            concept_stats = per_concept.loc[learner].to_dict("index")
        except KeyError:
            # The learner attempted only problems with no concept tags.
            concept_stats = {}

        for pid, beta, pop, ncon in zip(candidate_ids, block_beta, block_pop, block_ncon,
                                        strict=True):
            concept = primary_concept.get(pid)
            seen_concept = concept_stats.get(concept)
            rows.append(build_features(
                # None when the learner has never touched this concept — which is a DIFFERENT state
                # from scoring zero on it, and `build_features` encodes that in `mastery_known`.
                mastery=float(seen_concept["concept_solve_rate"]) if seen_concept else None,
                attempts_on_concept=int(seen_concept["attempts_on_concept"]) if seen_concept else 0,
                first_attempt_rate=(float(seen_concept["concept_solve_rate"])
                                    if seen_concept else None),
                # The IRT difficulty, bucketed into the three names build_features knows. Mapping
                # rather than passing beta directly keeps one feature contract between this harness
                # and the product path in features/recommend.py.
                difficulty="easy" if beta < -0.5 else ("hard" if beta > 0.5 else "medium"),
                n_concepts=int(ncon),
                # The two features spec §5.2 names, populated at last. log1p because attempt counts
                # span four orders of magnitude.
                catalog_popularity=float(np.log1p(pop)),
                # Days from the learner's last pre-cutoff touch of this concept to the cutoff.
                # None for an untouched concept, which build_features maps to the furthest value
                # rather than to zero.
                concept_recency_days=((cutoff - float(seen_concept["last_touch"])) / 86400.0
                                      if seen_concept else None),
                # The candidate source a real request would carry: a concept the learner has
                # attempted is weakness-driven, an untouched one is a coverage gap.
                sources=["weak_concept"] if seen_concept else ["coverage_gap"],
            ))
            extras.append((float(beta), float(np.log1p(pop))))
            labels.append(graded.get(pid, 0))
        groups.append(len(candidate_ids))

    return (np.array(rows, dtype=float), np.array(extras, dtype=float),
            np.array(labels, dtype=int), np.array(groups))


def rank_with_random_tiebreak(score: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Descending score, ties broken RANDOMLY rather than by row order.

    THIS IS NOT A DETAIL. With `np.argsort(-score, kind="stable")` a tie is resolved by position in
    the array, which here is parquet row order. Measured on this corpus: a model emitting only 12
    distinct scores across 11,272 candidates scored NDCG@10 = 0.3142 in row order and 0.0200 once
    tied rows were shuffled — so 94% of the apparent result was the catalogue's ordering correlating
    with engagement, not ranking skill.

    A stable sort is the default and it is the wrong default for evaluation. Random tie-breaking makes
    a tie worth what a tie is worth: nothing.
    """
    return np.lexsort((rng.random(len(score)), -score))


def _ndcg_and_recall(order: np.ndarray, labels: np.ndarray) -> tuple[float, float, float]:
    """NDCG@5, NDCG@10 and Recall@100 for one learner's ranked block."""
    ranked = labels[order]
    relevant = int((labels > 0).sum())
    # Recall@100 against problems the learner subsequently engaged with. 0.0 when there are none,
    # and those learners are excluded by the caller rather than counted as perfect recall.
    recall = float((ranked[:100] > 0).sum() / relevant) if relevant else float("nan")
    return ndcg_at_k(ranked.tolist(), 5), ndcg_at_k(ranked.tolist(), 10), recall


def bootstrap_ci(values: list[float], replicates: int = BOOTSTRAP_REPLICATES) -> tuple[float, float]:
    """Percentile 95% interval over LEARNERS, which is the unit of independence here.

    Resampling rows instead would treat one learner's 11,000 candidate rows as 11,000 independent
    observations and produce an interval far too narrow to be true.
    """
    clean = [v for v in values if not np.isnan(v)]
    if len(clean) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(SEED)
    arr = np.array(clean)
    means = [arr[rng.integers(0, len(arr), len(arr))].mean() for _ in range(replicates)]
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def evaluate_rankers(x: np.ndarray, extras: np.ndarray, y: np.ndarray,
                     groups: np.ndarray, model) -> dict:
    """Score every ranker over the same blocks, so the comparison is paired.

    Paired matters: the same learners, the same candidate sets, the same labels. An unpaired
    comparison over different learner samples confounds ranker quality with who was sampled.
    """
    beta, log_pop = extras[:, 0], extras[:, 1]
    # The median log-popularity over the rows actually being ranked, so "well observed" is defined
    # against this candidate pool rather than a number typed in.
    well_observed = log_pop >= np.median(log_pop)

    scores = {
        "lambdamart": model.predict(x) if model is not None else None,
        # Ascending difficulty: easiest first. Negated because every ranker here sorts descending.
        "difficulty_sorted": -beta,
        # Same ordering, but thinly-observed problems pushed to the bottom instead of the top. Their
        # extreme betas are artefacts of having almost no evidence, not statements about difficulty.
        "difficulty_sorted_observed": np.where(well_observed, -beta, -np.inf),
        "popularity": log_pop,
    }

    results: dict[str, dict] = {}
    for name, score in scores.items():
        if score is None:
            continue
        at5, at10, recall, start = [], [], [], 0
        # Seeded per ranker so every ranker gets the same tie-break draws — the comparison stays
        # paired, and a ranker cannot win by luck of the shuffle.
        rng = np.random.default_rng(SEED)
        for size in groups:
            block = slice(start, start + size)
            order = rank_with_random_tiebreak(score[block], rng)
            a, b, r = _ndcg_and_recall(order, y[block])
            at5.append(a)
            at10.append(b)
            recall.append(r)
            start += size
        results[name] = {
            "ndcg_at_5": float(np.mean(at5)),
            "ndcg_at_10": float(np.mean(at10)),
            "ndcg_at_10_ci": bootstrap_ci(at10),
            "recall_at_100": float(np.nanmean(recall)),
            "recall_at_100_ci": bootstrap_ci(recall),
        }
    return results


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--learners", type=int, default=500,
                        help="learners to rank against the FULL catalogue")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    warehouse = _warehouse()
    if not os.path.isdir(warehouse):
        print(f"no warehouse at {warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    info = compute_cutoff(warehouse, quantile=CUTOFF_QUANTILE)
    cutoff = info["cutoff_epoch"]
    pre, post = load_split(warehouse, cutoff)
    assert_no_feature_leakage(pre, cutoff)

    problems = _read("gold_problem_difficulty", warehouse,
                     ["problem_id", "difficulty_beta", "n_observations"])
    problem_concepts = _read("gold_problem_concepts", warehouse)
    concept_counts = problem_concepts.groupby("problem_id").size().rename("n_concepts")
    problems = problems.join(concept_counts, on="problem_id").fillna({"n_concepts": 1})

    # The cohort split.py defines: >= 3 problems on each side of the cutoff.
    pre_counts = pre.groupby("learner_id").size()
    post_counts = post.groupby("learner_id").size()
    cohort = sorted(set(pre_counts[pre_counts >= 3].index) & set(post_counts[post_counts >= 3].index))

    rng = np.random.default_rng(SEED)
    sample = [cohort[i] for i in rng.choice(len(cohort), min(args.learners, len(cohort)),
                                            replace=False)]

    # Trained on a DISJOINT set of learners, so the model is never scored on anyone it fitted on.
    train_pool = [learner for learner in cohort if learner not in set(sample)]
    train_sample = [train_pool[i] for i in rng.choice(len(train_pool),
                                                     min(args.learners, len(train_pool)),
                                                     replace=False)]

    print(f"cutoff {info['cutoff_iso']}  cohort {len(cohort):,} learners  "
          f"sampled {len(sample)} for eval, {len(train_sample)} for training\n")

    # Negatives sampled to LightGBM's query ceiling; see build_matrix.
    xt, _, yt, gt = build_matrix(train_sample, pre, post, problems, problem_concepts, cutoff,
                                 max_rows_per_learner=LIGHTGBM_MAX_QUERY_ROWS,
                                 rng=np.random.default_rng(SEED))
    from features.ranking import LabelledExample

    # Grouped by learner: train_ranker derives the ranking groups from user_id, and a flat list
    # would make LightGBM treat every row as its own group — which is pointwise regression wearing
    # a lambdarank objective's name.
    examples: list[LabelledExample] = []
    start, i = 0, 0
    for learner, size in zip(train_sample, gt, strict=True):
        for row, label in zip(xt[start:start + size], yt[start:start + size], strict=True):
            examples.append(LabelledExample(str(learner), str(i), int(label), tuple(row),
                                            info["cutoff_iso"]))
            i += 1
        start += size

    model = train_ranker(examples, num_boost_round=100)
    if model is None:
        print("train_ranker declined to fit — too few learners or examples.")
        return 1

    x, extras, y, groups = build_matrix(sample, pre, post, problems, problem_concepts, cutoff)
    results = evaluate_rankers(x, extras, y, groups, model)

    if args.json:
        print(json.dumps({"cutoff": info, "n_eval_learners": len(sample), "results": results},
                         indent=2, default=str))
        return 0

    print(f"{'ranker':20} {'NDCG@5':>8} {'NDCG@10':>8}  {'95% CI':>18} {'Recall@100':>11}")
    for name, r in results.items():
        lo, hi = r["ndcg_at_10_ci"]
        print(f"  {name:18} {r['ndcg_at_5']:8.4f} {r['ndcg_at_10']:8.4f}  "
              f"[{lo:.4f}, {hi:.4f}] {r['recall_at_100']:11.4f}")

    best_baseline = max((r["ndcg_at_10"] for n, r in results.items() if n != "lambdamart"),
                        default=0.0)
    model_score = results["lambdamart"]["ndcg_at_10"]
    lo, hi = results["lambdamart"]["ndcg_at_10_ci"]
    print()
    if model_score > best_baseline and lo > best_baseline:
        print(f"  LambdaMART beats every baseline, and its CI lower bound ({lo:.4f}) clears the "
              f"best baseline ({best_baseline:.4f}).")
    elif model_score > best_baseline:
        print(f"  LambdaMART leads ({model_score:.4f} vs {best_baseline:.4f}) but its CI lower "
              f"bound ({lo:.4f}) does NOT clear it — the lead is inside sampling noise.")
    else:
        # Spec §5.4 asks the ranker to beat both baselines. Reporting the result you got is the
        # requirement; tuning until it wins is not. See docs/RANKING_DESIGN.md.
        print(f"  LambdaMART does NOT beat the best baseline ({model_score:.4f} vs "
              f"{best_baseline:.4f}). That is the result, reported as measured.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
