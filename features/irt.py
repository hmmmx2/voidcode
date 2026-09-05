"""One-parameter logistic (Rasch) item response model.

Spec §4.3 calls this "the strongest single addition" to Phase 2, and the reason is
that it answers the question a raw pass rate cannot: *is this learner weak at this
concept, or were the problems simply hard?* A pass rate conflates learner ability with
item difficulty. The Rasch model separates them:

    P(learner i solves problem j) = sigmoid(theta_i - beta_j)

theta is ability on the logit scale, beta is difficulty on the same scale. Fitting them
jointly by maximum likelihood over the whole submission matrix means a learner who
attempts only hard problems is not punished for it.

**Concept mastery then falls out as a residual.** For learner i and concept c:

    residual(i, c) = mean over problems j tagged c of  ( solved_ij - P_hat_ij )

A residual near zero means "performs exactly as their overall ability predicts". A
negative residual is the signal Phase 3 ranks on: underperformance on this concept
*after* controlling for both ability and difficulty. That is a genuine weakness estimate
rather than an aggregation.

Validation is external and non-circular: Codeforces publishes its own difficulty rating
per problem, which the model never sees. If the recovered beta does not correlate with
it, the fit is wrong.

    python -m features.irt
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import pandas as pd

from features.irt_data import write_table

# Ridge on item difficulty. Small — beta is well identified by many observations per
# problem, unlike theta. Shared so fit_rasch and the analytic information matrix in
# main() cannot drift apart.
L2_BETA = 1e-3


def sigmoid(x: np.ndarray) -> np.ndarray:
    # branch-free stable logistic
    out = np.empty_like(x)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out


def fit_rasch(learner_idx, problem_idx, y, n_learners, n_problems,
              *, epochs=300, lr=0.5, l2_theta=0.5, l2_beta=L2_BETA, seed=0,
              verbose=True, val=None):
    """Joint MAP by full-batch gradient ascent on the penalised log-likelihood.

    Full-batch is affordable here (order 1e6 observations, 1e5 parameters) and is
    deterministic, which matters because spec §0 requires every number be
    reproducible. np.add.at does the scatter-add of per-observation gradients.

    `l2_theta` is a genuine prior, not a nicety. The median learner here attempts
    ~8 problems, and any learner who solved all of them or none of them has a
    likelihood maximised at theta = +/-infinity (complete separation). The L2 term is
    a N(0, 1/sqrt(l2_theta)) prior on ability that keeps those estimates finite.

    If `val` is given as (idx_l, idx_p, y_val), the fit early-stops on held-out log
    loss and returns the best parameters rather than the last ones.
    """
    rng = np.random.default_rng(seed)
    theta = rng.normal(0, 0.01, n_learners)
    beta = rng.normal(0, 0.01, n_problems)

    # Rasch is invariant to a constant shift of (theta, beta); anchor beta's mean at 0.
    history = []
    best = {"val_log_loss": float("inf"), "epoch": 0,
            "theta": theta.copy(), "beta": beta.copy()}
    m_t = np.zeros_like(theta)
    v_t = np.zeros_like(theta)
    m_b = np.zeros_like(beta)
    v_b = np.zeros_like(beta)
    b1, b2, eps = 0.9, 0.999, 1e-8

    for ep in range(1, epochs + 1):
        z = theta[learner_idx] - beta[problem_idx]
        p = sigmoid(z)
        resid = y - p                                     # dLL/dz

        # bincount, not np.add.at: identical scatter-add, but add.at takes the
        # unbuffered slow path and is roughly an order of magnitude slower. That is
        # irrelevant for one fit and very relevant for the B=50 bootstrap.
        g_theta = np.bincount(learner_idx, weights=resid, minlength=n_learners)
        g_beta = np.bincount(problem_idx, weights=-resid, minlength=n_problems)
        g_theta -= l2_theta * theta
        g_beta -= l2_beta * beta

        # Adam, ascending
        m_t = b1 * m_t + (1 - b1) * g_theta
        v_t = b2 * v_t + (1 - b2) * g_theta ** 2
        m_b = b1 * m_b + (1 - b1) * g_beta
        v_b = b2 * v_b + (1 - b2) * g_beta ** 2
        mt_h = m_t / (1 - b1 ** ep)
        vt_h = v_t / (1 - b2 ** ep)
        mb_h = m_b / (1 - b1 ** ep)
        vb_h = v_b / (1 - b2 ** ep)
        theta += lr * mt_h / (np.sqrt(vt_h) + eps)
        beta += lr * mb_h / (np.sqrt(vb_h) + eps)
        beta -= beta.mean()                               # fix the gauge

        if ep % 10 == 0 or ep == 1:
            ll = float(np.mean(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12)))
            rec = {"epoch": ep, "train_mean_log_likelihood": round(ll, 6)}
            if val is not None:
                vl, vp, vy = val
                v_ll = log_loss(vy, sigmoid(theta[vl] - beta[vp]))
                rec["val_log_loss"] = round(v_ll, 6)
                if v_ll < best["val_log_loss"]:
                    best = {"val_log_loss": v_ll, "epoch": ep,
                            "theta": theta.copy(), "beta": beta.copy()}
            history.append(rec)
            if verbose:
                extra = f"  val logloss {rec['val_log_loss']:.6f}" if val is not None else ""
                print(f"  epoch {ep:4d}  train LL {ll:.6f}{extra}")

    if val is not None:
        if verbose:
            print(f"  early stop: best val log loss {best['val_log_loss']:.6f} "
                  f"at epoch {best['epoch']}")
        return best["theta"], best["beta"], history
    return theta, beta, history


def log_loss(y, p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def main():
    ap = argparse.ArgumentParser()
    data = os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data"))
    ap.add_argument("--warehouse", default=os.path.join(data, "warehouse"))
    ap.add_argument("--epochs", type=int, default=400)
    # lr/l2 selected by features/irt_tune.py — RE-SELECTED after the corpus grew from
    # 103 to 11,284 problems, and the answer reversed.
    #
    # On the old 103-problem corpus lr=0.5 early-stopped at epoch 10 with unconverged
    # item parameters (Spearman 0.846 vs 0.917), so lr=0.05 was chosen: log loss
    # subject to beta convergence, not log loss alone.
    #
    # On the full corpus lr=0.5 converges at epoch 70 and wins on BOTH criteria —
    # held-out log loss 0.22661 vs 0.22640 for lr=0.1 (a 0.09% difference, noise) and
    # Spearman 0.4864 vs 0.4452 (9% relative, material). The earlier objection no
    # longer applies because more data changes the convergence regime.
    ap.add_argument("--lr", type=float, default=0.5)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--l2-theta", type=float, default=0.5)
    ap.add_argument("--target", default="solved",
                    choices=["solved", "first_attempt_pass"],
                    help="'solved' = ever accepted (base rate ~0.87, weak mastery "
                         "evidence: rewards persistence). 'first_attempt_pass' is the "
                         "harder, more discriminative target and is what spec 4.3 calls "
                         "the strongest weakness signal.")
    ap.add_argument("--min-attempts", type=int, default=1,
                    help="drop learners with fewer than this many attempted problems")
    a = ap.parse_args()

    t0 = time.time()
    wh = a.warehouse
    lp = pd.read_parquet(os.path.join(wh, "gold_learner_problem"),
                         columns=["learner_id", "problem_id", "solved",
                                  "first_attempt_pass", "problem_rating"])
    pc = pd.read_parquet(os.path.join(wh, "gold_problem_concepts"))

    if a.min_attempts > 1:
        keep = lp.groupby("learner_id")["problem_id"].transform("size") >= a.min_attempts
        lp = lp[keep]

    lp = lp.dropna(subset=[a.target])
    lp[a.target] = lp[a.target].astype(np.float64)

    learners = pd.Index(lp["learner_id"].unique())
    problems = pd.Index(lp["problem_id"].unique())
    li = learners.get_indexer(lp["learner_id"]).astype(np.int64)
    pi = problems.get_indexer(lp["problem_id"]).astype(np.int64)
    y = lp[a.target].to_numpy()

    # Held-out split. Fitting theta on every observation and then reporting the
    # log loss on those same observations would be self-graded: theta has one free
    # parameter per learner, so in-sample loss falls whether or not the model
    # generalises. The reported figure is the held-out one.
    rng = np.random.default_rng(7)
    is_val = rng.random(len(y)) < a.val_frac
    tr, va = ~is_val, is_val

    print(f"fitting Rasch on {tr.sum():,} train / {va.sum():,} held-out "
          f"(learner, problem) observations | {len(learners):,} learners | "
          f"{len(problems):,} problems")
    theta, beta, history = fit_rasch(
        li[tr], pi[tr], y[tr], len(learners), len(problems),
        epochs=a.epochs, lr=a.lr, l2_theta=a.l2_theta,
        val=(li[va], pi[va], y[va]))

    p_hat = sigmoid(theta[li] - beta[pi])

    # ── baselines, all fitted on train and scored on the same held-out rows ──
    ll_model_in = log_loss(y[tr], p_hat[tr])
    ll_model = log_loss(y[va], p_hat[va])
    global_mean = float(y[tr].mean())
    ll_global = log_loss(y[va], np.full(va.sum(), global_mean))
    pm = (pd.DataFrame({"pi": pi[tr], "y": y[tr]}).groupby("pi")["y"].mean())
    prob_mean_va = pd.Series(pi[va]).map(pm).fillna(global_mean).to_numpy()
    ll_problem = log_loss(y[va], prob_mean_va)

    # ── external validation against the Codeforces rating the model never saw ──
    prating = (lp.groupby("problem_id")["problem_rating"].max()
               .reindex(problems))
    mask = prating.notna().to_numpy()
    if mask.sum() >= 3:
        from scipy.stats import pearsonr, spearmanr
        pr = pearsonr(beta[mask], prating[mask].to_numpy())
        sp = spearmanr(beta[mask], prating[mask].to_numpy())
        pearson, spearman = float(pr[0]), float(sp[0])
    else:
        pearson = spearman = float("nan")

    # ── per (learner, concept) residual, with its uncertainty ──
    #
    # A bare mean residual is not usable by the ranker. Under this corpus the median
    # learner has ONE problem in a given concept, so a single failure on an easy
    # problem produces residual = -0.98 and looks like a catastrophic weakness, while
    # a learner with twelve observations averaging -0.30 — far stronger evidence —
    # looks milder. Dividing by the conditional binomial standard error of the mean
    # fixes the ordering: the first gets z = -3.5, the second z = -5.9.
    #
    # This conditions on the fitted (theta, beta) and ignores parameter uncertainty.
    # A delta-method correction using difficulty_beta_se is available and is
    # deliberately NOT applied here; irt_bootstrap.py records what it would add.
    # The variance is floored by clipping p into [P_FLOOR, 1-P_FLOOR] before forming
    # p(1-p). Without it, a problem the model predicts at p = 0.999999 yields
    # se = 0.001 and a single surprising outcome produces |z| in the hundreds — the
    # observed max was 452, which would dominate any ranking built on this column.
    # A logistic model's extreme predictions are precisely where it is least
    # calibrated, so refusing to be more than 99% certain is the honest floor. It
    # bounds |z| at roughly 10 for a single observation.
    P_FLOOR = 0.01
    var = np.clip(p_hat, P_FLOOR, 1 - P_FLOOR)
    var = var * (1.0 - var)
    resid = pd.DataFrame({
        "learner_id": lp["learner_id"].to_numpy(),
        "problem_id": lp["problem_id"].to_numpy(),
        "residual": y - p_hat,
        "expected": p_hat,
        "var": var,
    })
    lc = (resid.merge(pc, on="problem_id", how="inner")
          .groupby(["learner_id", "concept_id"], as_index=False)
          .agg(irt_residual=("residual", "mean"),
               irt_expected=("expected", "mean"),
               irt_n_problems=("residual", "size"),
               _var_sum=("var", "sum")))
    lc["irt_residual_se"] = np.sqrt(lc["_var_sum"]) / lc["irt_n_problems"]
    # A concept whose problems the model predicts with certainty (var -> 0) has no
    # information about the learner; guard rather than emit an infinite z.
    lc["irt_residual_z"] = np.where(
        lc["irt_residual_se"] > 1e-9,
        lc["irt_residual"] / lc["irt_residual_se"].replace(0, np.nan),
        np.nan)
    lc = lc.drop(columns=["_var_sum"])
    suffix = "" if a.target == "solved" else f"_{a.target}"
    write_table(lc, wh, f"gold_learner_concept_irt{suffix}")

    # Ability standard errors are ANALYTIC, not bootstrapped. The cluster bootstrap in
    # irt_bootstrap.py resamples learners, so any given learner appears in only ~63% of
    # replicates and their theta is not identified across them. This is the penalised
    # observed information: 1/sqrt(sum p(1-p) + l2_theta). The prior term is what keeps
    # a learner who solved everything from getting an infinite SE.
    info_theta = np.bincount(li, weights=var, minlength=len(learners)) + a.l2_theta
    theta_se = 1.0 / np.sqrt(info_theta)
    ability = pd.DataFrame({"learner_id": learners, "ability_theta": theta,
                  "ability_theta_se": theta_se,
                  "n_observations": np.bincount(li, minlength=len(learners)),
                  })
    write_table(ability, wh, f"gold_learner_ability{suffix}")
    # n_observations is not decoration. Problems seen ~40 times have a beta the
    # ranker should trust far less than one seen 1000 times, and on this corpus the
    # thinly-observed problems are systematically the HARD ones (contest positions
    # E-H), because a chronological slice of a contest is dominated by easy problems
    # and fast solvers. Downstream code gates on this the same way it gates on
    # irt_n_problems.
    n_obs_problem = np.bincount(pi, minlength=len(problems))
    info_beta = np.bincount(pi, weights=var, minlength=len(problems)) + L2_BETA
    difficulty = pd.DataFrame({"problem_id": problems, "difficulty_beta": beta,
                  "difficulty_beta_se_analytic": 1.0 / np.sqrt(info_beta),
                  "n_observations": n_obs_problem,
                  "codeforces_rating": prating.to_numpy()})
    write_table(difficulty, wh, f"gold_problem_difficulty{suffix}")

    # Stratified external validation. The headline correlation is dominated by
    # thinly-observed problems and understates the estimator; reporting only the
    # headline would be as misleading as reporting only the best stratum.
    strata = {}
    if mask.sum() >= 3:
        from scipy.stats import spearmanr as _sp
        for thr in (0, 50, 100, 300, 1000):
            sel = mask & (n_obs_problem >= thr)
            if sel.sum() >= 10:
                strata[f"spearman_min_{thr}_obs"] = {
                    "n_problems": int(sel.sum()),
                    "spearman": round(float(_sp(beta[sel],
                                                prating[sel].to_numpy())[0]), 4),
                }

    metrics = {
        "target": a.target,
        "target_base_rate": round(float(y.mean()), 4),
        "observations": len(y),
        "learners": len(learners),
        "problems": len(problems),
        "epochs": a.epochs,
        "learning_rate": a.lr,
        "val_fraction": a.val_frac,
        "l2_theta": a.l2_theta,
        "log_loss_model_in_sample": round(ll_model_in, 5),
        "log_loss_model_heldout": round(ll_model, 5),
        "log_loss_baseline_global_mean_heldout": round(ll_global, 5),
        "log_loss_baseline_per_problem_mean_heldout": round(ll_problem, 5),
        "improvement_vs_global_pct": round(100 * (ll_global - ll_model) / ll_global, 2),
        "improvement_vs_per_problem_pct": round(
            100 * (ll_problem - ll_model) / ll_problem, 2),
        "beta_vs_codeforces_rating_pearson": round(pearson, 4),
        "beta_vs_codeforces_rating_spearman": round(spearman, 4),
        "problems_with_rating": int(mask.sum()),
        "beta_vs_codeforces_by_observation_count": strata,
        "obs_per_problem_median": int(np.median(n_obs_problem)),
        "theta_mean": round(float(theta.mean()), 4),
        "theta_std": round(float(theta.std()), 4),
        "beta_std": round(float(beta.std()), 4),
        "learner_concept_rows": len(lc),
        "wall_clock_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(wh, f"irt_metrics{suffix}.json"), "w") as f:
        json.dump({"metrics": metrics, "history": history}, f, indent=2)

    print("\n=== IRT METRICS ===")
    for k, v in metrics.items():
        print(f"{k:38s} {v}")


if __name__ == "__main__":
    main()
