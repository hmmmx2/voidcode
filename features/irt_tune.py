"""Hyperparameter sweep for the Rasch fit, selected on held-out log loss.

Kept in the repository rather than run ad hoc because spec §0 requires every reported
number be regenerable. `features/irt.py` defaults are whatever this script selected;
if you change the corpus, rerun this before trusting them.

    python -m features.irt_tune
"""
from __future__ import annotations

import itertools
import json
import os

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from features.irt import fit_rasch, log_loss, sigmoid

LRS = [0.02, 0.05, 0.1, 0.5]
L2S = [0.5, 2.0, 5.0]


def main():
    wh = os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")),
                      "warehouse")
    lp = pd.read_parquet(
        os.path.join(wh, "gold_learner_problem"),
        columns=["learner_id", "problem_id", "solved", "problem_rating"],
    ).dropna(subset=["solved"])
    lp["solved"] = lp["solved"].astype(float)

    learners = pd.Index(lp["learner_id"].unique())
    problems = pd.Index(lp["problem_id"].unique())
    li = learners.get_indexer(lp["learner_id"]).astype(np.int64)
    pi = problems.get_indexer(lp["problem_id"]).astype(np.int64)
    y = lp["solved"].to_numpy()

    rng = np.random.default_rng(7)          # same seed as irt.py, same split
    va = rng.random(len(y)) < 0.1
    tr = ~va

    rating = lp.groupby("problem_id")["problem_rating"].max().reindex(problems)
    mask = rating.notna().to_numpy()

    print(f"{'lr':>6} {'l2_theta':>9} {'best_ep':>8} {'val_logloss':>12} "
          f"{'spearman_vs_cf':>15}")
    results = []
    for lr, l2 in itertools.product(LRS, L2S):
        theta, beta, hist = fit_rasch(
            li[tr], pi[tr], y[tr], len(learners), len(problems),
            epochs=400, lr=lr, l2_theta=l2,
            val=(li[va], pi[va], y[va]), verbose=False)
        vll = log_loss(y[va], sigmoid(theta[li[va]] - beta[pi[va]]))
        best_ep = min((h for h in hist if "val_log_loss" in h),
                      key=lambda h: h["val_log_loss"])["epoch"]
        sp = float(spearmanr(beta[mask], rating[mask].to_numpy())[0])
        print(f"{lr:6.2f} {l2:9.1f} {best_ep:8d} {vll:12.5f} {sp:15.4f}")
        results.append({"lr": lr, "l2_theta": l2, "best_epoch": best_ep,
                        "val_log_loss": round(vll, 5),
                        "spearman_vs_codeforces": round(sp, 4)})

    best = min(results, key=lambda r: r["val_log_loss"])
    print(f"\nbest by held-out log loss: {best}")
    with open(os.path.join(wh, "irt_tuning.json"), "w") as f:
        json.dump({"grid": results, "best": best}, f, indent=2)


if __name__ == "__main__":
    main()
