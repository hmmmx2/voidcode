"""2PL: add a per-problem discrimination parameter. Spec §4.3b follow-up.

Run:  VC_WAREHOUSE=... python -m features.irt_2pl

    1PL (Rasch)  P(solve) = sigmoid(theta_i - beta_j)
    2PL          P(solve) = sigmoid(a_j * (theta_i - beta_j))

WHY, AND IT IS TWO MEASUREMENTS RATHER THAN A PREFERENCE
----------------------------------------------------------
`analysis/calibration.py` measured the Rasch fit as systematically **overconfident in the mid-range**
— predicted 0.45 against observed 0.28, MCE 0.171 — and accurate at the extremes. That is the
signature of a model with no discrimination parameter: one theta and one beta cannot express that
outcomes near a learner's threshold depend on *which* topic, so the uncertain band averages over
concepts they are strong and weak at.

`quality/contracts.py` separately found **16 problems with >=7 observations and |beta| > 10** — a fit
that failed to converge where it had evidence.

`a_j` addresses both. A low discrimination lets a problem be genuinely noisy rather than forcing an
extreme beta to explain inconsistent outcomes, and it lets the curve be shallow in the mid-range
instead of uniformly steep.

WHY THIS IS A NEW MODULE AND NOT AN EDIT TO fit_rasch
-------------------------------------------------------
`features/irt.py` produces every difficulty estimate the warehouse holds, and `irt_bootstrap.py`,
`irt_tune.py` and `ranking/eval.py` all read its output. Changing it in place would invalidate
`docs/METRICS.md`'s recorded 1PL numbers with no way to compare against them. This fits alongside, so
the two can be scored on the same held-out split — which is the only way to claim the 2PL is better
rather than merely newer.

THE IDENTIFIABILITY PROBLEM, AND THE PRIOR THAT SOLVES IT
-----------------------------------------------------------
2PL is not identified without constraints: scaling every `a` down and every `(theta - beta)` up leaves
every probability unchanged. Rasch fixes the gauge by anchoring `beta.mean() = 0`; that is necessary
here too and no longer sufficient.

So `a` is parameterised as `exp(log_a)` — which keeps it strictly positive, because a negative
discrimination means "more able learners are LESS likely to solve this", an artefact rather than a
finding — with an L2 prior on `log_a` pulling it toward 0, i.e. `a` toward 1, i.e. toward Rasch. A
problem with little data therefore stays near the 1PL answer instead of taking an extreme
discrimination to fit noise, which is the 2PL's characteristic failure on sparse items.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Pulls `a` toward 1 (Rasch). The 2PL's failure mode on a thinly-observed problem is an extreme
#: discrimination that fits noise perfectly; this is what makes such a problem fall back to the 1PL
#: answer rather than inventing one.
L2_LOG_A = 2.0

#: Same gauge anchor Rasch uses, still required and no longer sufficient — see the module docstring.
L2_THETA = 0.5
L2_BETA = 0.1


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def fit_2pl(learner_idx, problem_idx, y, n_learners, n_problems, *,
            epochs: int = 300, lr: float = 0.05, l2_theta: float = L2_THETA,
            l2_beta: float = L2_BETA, l2_log_a: float = L2_LOG_A,
            seed: int = 0, val=None, verbose: bool = True):
    """Joint MAP by full-batch Adam, mirroring `features/irt.fit_rasch`'s structure.

    Returns `(theta, beta, a, history)`. Deliberately the same shape as `fit_rasch` plus `a`, so a
    caller can swap one for the other.

    `lr` is 0.05 against Rasch's 0.5. The gradient for `theta` and `beta` is now scaled by `a`, so the
    same step size that was stable at a=1 overshoots once discriminations spread — a fit that
    diverges silently produces finite, wrong parameters rather than an error.
    """
    rng = np.random.default_rng(seed)
    theta = rng.normal(0, 0.01, n_learners)
    beta = rng.normal(0, 0.01, n_problems)
    # log a = 0 means a = 1: start AT Rasch and let the data move it.
    log_a = np.zeros(n_problems)

    state = {name: (np.zeros_like(v), np.zeros_like(v))
             for name, v in (("theta", theta), ("beta", beta), ("log_a", log_a))}
    b1, b2, eps = 0.9, 0.999, 1e-8
    history: list[dict] = []
    best = {"val_log_loss": float("inf"), "epoch": 0,
            "theta": theta.copy(), "beta": beta.copy(), "log_a": log_a.copy()}

    def step(name, value, grad, ep):
        m, v = state[name]
        m = b1 * m + (1 - b1) * grad
        v = b2 * v + (1 - b2) * grad ** 2
        state[name] = (m, v)
        return value + lr * (m / (1 - b1 ** ep)) / (np.sqrt(v / (1 - b2 ** ep)) + eps)

    for ep in range(1, epochs + 1):
        a = np.exp(log_a)
        a_obs = a[problem_idx]
        diff = theta[learner_idx] - beta[problem_idx]
        p = sigmoid(a_obs * diff)
        resid = y - p                                     # dLL/dz, z = a * diff

        # Chain rule through z = a*(theta - beta). The `a_obs` factor is the whole difference from
        # Rasch: a problem the model finds uninformative now contributes a SMALLER gradient to the
        # learner's ability, which is the behaviour a single-parameter model cannot express.
        g_theta = np.bincount(learner_idx, weights=resid * a_obs, minlength=n_learners)
        g_beta = np.bincount(problem_idx, weights=-resid * a_obs, minlength=n_problems)
        # dz/d(log a) = a * diff, since a = exp(log a).
        g_log_a = np.bincount(problem_idx, weights=resid * a_obs * diff, minlength=n_problems)

        g_theta -= l2_theta * theta
        g_beta -= l2_beta * beta
        g_log_a -= l2_log_a * log_a                       # toward a = 1, i.e. toward Rasch

        theta = step("theta", theta, g_theta, ep)
        beta = step("beta", beta, g_beta, ep)
        log_a = step("log_a", log_a, g_log_a, ep)
        beta -= beta.mean()                               # fix the LOCATION gauge, as Rasch does
        # AND fix the SCALE gauge. Without this line the fit is degenerate in a way the L2 prior on
        # log_a does not remove: `l2_theta` shrinks theta, and `a` inflates to undo the shrinkage,
        # leaving every probability nearly unchanged. Measured on synthetic data from a known 2PL,
        # un-anchored: a recovered at corr 0.39 with mean 2.99 against a true 1.09 — a threefold
        # systematic inflation — while beta recovered at 0.98 and theta at 0.94. The scale had
        # nowhere to be pinned, so it drifted, and nothing about the fit looked wrong.
        log_a -= log_a.mean()

        if ep % 10 == 0 or ep == 1:
            record = {"epoch": ep, "train_log_loss": round(log_loss(y, p), 6),
                      "mean_a": round(float(np.exp(log_a).mean()), 4)}
            if val is not None:
                vl, vp, vy = val
                v_ll = log_loss(vy, sigmoid(np.exp(log_a)[vp] * (theta[vl] - beta[vp])))
                record["val_log_loss"] = round(v_ll, 6)
                if v_ll < best["val_log_loss"]:
                    best = {"val_log_loss": v_ll, "epoch": ep, "theta": theta.copy(),
                            "beta": beta.copy(), "log_a": log_a.copy()}
            history.append(record)
            if verbose:
                extra = (f"  val logloss {record['val_log_loss']:.6f}"
                         if val is not None else "")
                print(f"  epoch {ep:4d}  train logloss {record['train_log_loss']:.6f}  "
                      f"mean a {record['mean_a']:.3f}{extra}")

    if val is not None:
        if verbose:
            print(f"  early stop: best val log loss {best['val_log_loss']:.6f} "
                  f"at epoch {best['epoch']}")
        return best["theta"], best["beta"], np.exp(best["log_a"]), history
    return theta, beta, np.exp(log_a), history


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

    from features.irt import fit_rasch
    from features.irt_data import load_observations

    obs = load_observations(args.warehouse)
    y = obs.lp[obs.target].to_numpy(dtype=float)
    train = obs.train_mask
    val = (obs.li[~train], obs.pi[~train], y[~train])
    print(f"  {int(train.sum()):,} train / {int((~train).sum()):,} held out; "
          f"{obs.n_learners:,} learners, {obs.n_problems:,} problems\n")

    # SAME held-out split for both, which is the only way the comparison means anything.
    print("  1PL (Rasch)")
    theta_r, beta_r, _ = fit_rasch(obs.li[train], obs.pi[train], y[train],
                                   obs.n_learners, obs.n_problems,
                                   epochs=args.epochs, val=val, verbose=False)
    ll_1pl = log_loss(val[2], sigmoid(theta_r[val[0]] - beta_r[val[1]]))
    print(f"    held-out log loss {ll_1pl:.6f}")

    print("\n  2PL")
    theta, beta, a, _ = fit_2pl(obs.li[train], obs.pi[train], y[train],
                                obs.n_learners, obs.n_problems,
                                epochs=args.epochs, val=val, verbose=False)
    ll_2pl = log_loss(val[2], sigmoid(a[val[1]] * (theta[val[0]] - beta[val[1]])))
    print(f"    held-out log loss {ll_2pl:.6f}")
    print(f"    discrimination a: mean {a.mean():.3f}, "
          f"p5 {np.percentile(a, 5):.3f}, p95 {np.percentile(a, 95):.3f}")

    extreme_1pl = int((np.abs(beta_r) > 10).sum())
    extreme_2pl = int((np.abs(beta) > 10).sum())
    print(f"\n  |beta| > 10:  1PL {extreme_1pl}   2PL {extreme_2pl}")

    delta = (ll_1pl - ll_2pl) / ll_1pl * 100
    print(f"  held-out log loss change: {delta:+.2f}%")
    if ll_2pl < ll_1pl:
        print("\n  The 2PL fits the held-out data better. Whether it also fixes the MID-RANGE")
        print("  calibration error is a separate question — log loss can improve while the")
        print("  reliability curve stays bent. Re-run analysis/calibration.py against these")
        print("  parameters before claiming that.")
    else:
        print("\n  The 2PL does NOT beat the 1PL on held-out log loss. Reported as measured;")
        print("  the extra parameter is not paying for itself at this evidence density.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
