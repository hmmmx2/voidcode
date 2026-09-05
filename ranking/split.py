"""The temporal cutoff, and the guards that stop Phase 3 leaking labels.

This module exists because of a failure mode that produces *better* numbers when it
goes wrong, which is the worst kind. Every gold table in `$VC_DATA/warehouse` — mastery,
IRT ability and difficulty, problem popularity — is computed over the entire corpus,
including submissions that happen after the evaluation cutoff. Feed those to a ranker
as features and it is being told the future: NDCG rises, nothing errors, and the result
is meaningless.

The fix is structural rather than careful:

    warehouse/         features and labels over the whole corpus
    warehouse_train/   the SAME jobs re-run with --max-created-at $CUTOFF

Phase 3 reads features from `warehouse_train` only, and takes labels from post-cutoff
rows in `warehouse`. `assert_temporal_integrity()` is called by `ranking/eval.py` at
runtime — not only by pytest — so a violation fails the actual evaluation rather than
waiting for someone to run the test suite.

    python -m ranking.split            # compute and write the manifest
    python -m ranking.split --check    # verify an existing split
"""
from __future__ import annotations

import argparse
import json
import os

import pandas as pd

CUTOFF_QUANTILE = 0.80
MANIFEST_NAME = "split_manifest.json"


def _warehouse() -> str:
    return os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")),
                     "warehouse"))


def _warehouse_train() -> str:
    return os.environ.get(
        "VC_WAREHOUSE_TRAIN",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")),
                     "warehouse_train"))


def _read_learner_problem(warehouse: str, columns) -> pd.DataFrame:
    return pd.read_parquet(os.path.join(warehouse, "gold_learner_problem"),
                           columns=list(columns))


def compute_cutoff(warehouse: str | None = None,
                   quantile: float = CUTOFF_QUANTILE) -> dict:
    """Cutoff at a quantile of first-attempt time, plus the shape of the split.

    The quantile is taken over `first_attempt_at` rather than raw submission time
    because the evaluation unit is a (learner, problem) pair, not a submission, and a
    pair straddling the cutoff must land on exactly one side.
    """
    warehouse = warehouse or _warehouse()
    lp = _read_learner_problem(
        warehouse, ["learner_id", "problem_id", "first_attempt_at", "contest_id"])

    cutoff = int(lp["first_attempt_at"].quantile(quantile))
    pre = lp["first_attempt_at"] < cutoff
    post = ~pre

    pre_learners = set(lp.loc[pre, "learner_id"])
    post_learners = set(lp.loc[post, "learner_id"])

    # The evaluation cohort: learners with enough signal on BOTH sides. Without a
    # pre-cutoff history there is nothing to build features from; without post-cutoff
    # activity there is nothing to score against.
    pre_n = lp[pre].groupby("learner_id")["problem_id"].nunique()
    post_n = lp[post].groupby("learner_id")["problem_id"].nunique()
    cohort = sorted(set(pre_n[pre_n >= 3].index) & set(post_n[post_n >= 3].index))

    return {
        "cutoff_epoch": cutoff,
        "cutoff_iso": pd.to_datetime(cutoff, unit="s").isoformat(),
        "quantile": quantile,
        "corpus_min_ts": int(lp["first_attempt_at"].min()),
        "corpus_max_ts": int(lp["first_attempt_at"].max()),
        "train_pairs": int(pre.sum()),
        "eval_pairs": int(post.sum()),
        "train_learners": len(pre_learners),
        "eval_learners": len(post_learners),
        "eval_cohort_size": len(cohort),
        "eval_cohort_min_pre_problems": 3,
        "eval_cohort_min_post_problems": 3,
        "median_post_problems_in_cohort": int(post_n.reindex(cohort).median())
        if cohort else 0,
    }


def write_manifest(warehouse: str | None = None,
                   quantile: float = CUTOFF_QUANTILE) -> dict:
    warehouse = warehouse or _warehouse()
    m = compute_cutoff(warehouse, quantile)

    run = json.load(open(os.path.join(warehouse, "run_metrics.json"), encoding="utf-8"))
    m["salt_sha256"] = run.get("salt_sha256")
    m["source_warehouse"] = warehouse
    m["rows_by_ingest_mode"] = _rows_by_ingest_mode(warehouse, m["cutoff_epoch"])

    path = os.path.join(warehouse, MANIFEST_NAME)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2)
    return m


def load_manifest(warehouse: str | None = None) -> dict:
    warehouse = warehouse or _warehouse()
    with open(os.path.join(warehouse, MANIFEST_NAME), encoding="utf-8") as f:
        return json.load(f)


def _rows_by_ingest_mode(warehouse: str, cutoff: int) -> dict:
    """Rows and time ranges per ingest mode, either side of the cutoff.

    Breadth rows are a chronological slice of recent contests; depth rows span a
    learner's whole history over years. A single global cutoff can therefore put
    almost all of one population on one side, which would make the split look fine
    and behave badly.

    An earlier version of this counted *files* — 301 contest files against 1,000 user
    files — which says nothing about rows or time coverage and so did not actually
    make the asymmetry visible. Rows and [min_ts, max_ts] are the quantities that do.
    """
    lp = _read_learner_problem(
        warehouse, ["ingest_mode", "first_attempt_at", "learner_id"])
    out: dict[str, dict] = {}
    for mode, g in lp.groupby("ingest_mode", dropna=False):
        pre = g["first_attempt_at"] < cutoff
        out[str(mode)] = {
            "pairs": len(g),
            "learners": int(g["learner_id"].nunique()),
            "pairs_pre_cutoff": int(pre.sum()),
            "pairs_post_cutoff": int((~pre).sum()),
            "pct_pre_cutoff": round(100 * float(pre.mean()), 1),
            "min_ts": int(g["first_attempt_at"].min()),
            "max_ts": int(g["first_attempt_at"].max()),
            "span_days": round(
                (int(g["first_attempt_at"].max()) - int(g["first_attempt_at"].min()))
                / 86400, 1),
        }
    return out


def assert_temporal_integrity(warehouse: str | None = None,
                              warehouse_train: str | None = None) -> dict:
    """Raise unless the split is sound. Called by eval.py before it scores anything."""
    warehouse = warehouse or _warehouse()
    warehouse_train = warehouse_train or _warehouse_train()
    m = load_manifest(warehouse)
    cutoff = m["cutoff_epoch"]
    problems = []

    train_run_path = os.path.join(warehouse_train, "run_metrics.json")
    if not os.path.exists(train_run_path):
        raise FileNotFoundError(
            f"{warehouse_train} has no run_metrics.json — build it with "
            f"`make features-train CUTOFF={cutoff}` before evaluating")
    train_run = json.load(open(train_run_path, encoding="utf-8"))

    window = train_run.get("feature_window_end")
    if window is None:
        problems.append(
            "warehouse_train was built WITHOUT --max-created-at, so its features see "
            "the whole corpus. This is the leak the split exists to prevent.")
    elif window > cutoff:
        problems.append(f"feature_window_end {window} is after cutoff {cutoff}")

    # A differing salt silently changes every learner_id, so cross-warehouse joins
    # return fewer rows instead of failing. Cheap to check, expensive to miss.
    full_run = json.load(open(os.path.join(warehouse, "run_metrics.json"),
                              encoding="utf-8"))
    if train_run.get("salt_sha256") != full_run.get("salt_sha256"):
        problems.append(
            f"salt mismatch: warehouse {full_run.get('salt_sha256')} vs "
            f"warehouse_train {train_run.get('salt_sha256')} — learner_id is not "
            f"comparable between them")

    max_train = int(_read_learner_problem(
        warehouse_train, ["first_attempt_at"])["first_attempt_at"].max())
    if max_train >= cutoff:
        problems.append(f"warehouse_train contains a first attempt at {max_train}, "
                        f"at or after the cutoff {cutoff}")

    if problems:
        raise AssertionError("temporal split is unsound:\n  - " +
                             "\n  - ".join(problems))
    return {"cutoff_epoch": cutoff, "max_train_first_attempt": max_train,
            "checks_passed": 4}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warehouse", default=None)
    ap.add_argument("--quantile", type=float, default=CUTOFF_QUANTILE)
    ap.add_argument("--check", action="store_true",
                    help="verify an existing split instead of computing one")
    a = ap.parse_args()

    if a.check:
        print(json.dumps(assert_temporal_integrity(a.warehouse), indent=2))
        print("temporal split OK")
        return

    m = write_manifest(a.warehouse, a.quantile)
    for k, v in m.items():
        print(f"{k:32s} {v}")
    print(f"\nnext:  make features-train CUTOFF={m['cutoff_epoch']}")


if __name__ == "__main__":
    main()
