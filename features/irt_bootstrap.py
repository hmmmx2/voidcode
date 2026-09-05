"""Cluster bootstrap standard errors for problem difficulty. Spec §4.3b.

Run:  VC_WAREHOUSE=... python -m features.irt_bootstrap --replicates 200

This module was referenced three times before it existed — `features/irt.py:241`, `irt.py:277` and
`irt_data.py:3` all name it. Those references described what it would do; this does it.

WHY LEARNERS ARE THE RESAMPLING UNIT
--------------------------------------
Observations are not independent: one learner contributes many rows, and their attempts share
whatever their ability and habits are. Resampling ROWS treats a learner's 200 submissions as 200
independent facts and produces standard errors far too narrow to be true — the classic mistake with
clustered data.

Resampling LEARNERS with replacement keeps each learner's rows together, so the interval reflects
"what if we had surveyed a different set of people", which is the question a standard error answers.

WHY THIS PRODUCES SEs FOR BETA ONLY
-------------------------------------
`features/irt.py:277` had already recorded the constraint: under a learner-level resample, any given
learner appears in only ~63% of replicates, so their `theta` is not identified across them —
averaging over replicates where a learner is absent is not a distribution of their ability, it is a
distribution over whether they were sampled.

Problem difficulty is different. Every problem is present in nearly every replicate, because it is
attempted by many learners and only all of them dropping out removes it. So `beta` has a genuine
sampling distribution here and `theta` does not. Ability SEs stay analytic, as `irt.py` says.

WHAT TO COMPARE IT AGAINST
----------------------------
`gold_problem_difficulty.difficulty_beta_se_analytic` already exists — the penalised observed
information. I predicted the bootstrap would be WIDER, on the grounds that the analytic form assumes
correct specification and `analysis/calibration.py` had already shown the 1PL is misspecified.

**Measured over 200 replicates on 1.32M observations, that prediction was wrong:**

    median bootstrap / analytic SE ratio   0.59
    spearman(bootstrap, analytic)          0.127

Narrower, and barely correlated. The low correlation is the informative part — these are not two
estimates of one quantity. They answer different questions:

    analytic    how tightly does THIS problem's own data pin down its beta?
                Large for a problem with 7 observations.
    bootstrap   how far would beta move if we had sampled different LEARNERS?
                Small, because resampling 117,453 learners usually retains any given problem's
                handful of attempts.

So a population-level cluster bootstrap does **not** capture per-problem estimation uncertainty and
must not be used as a drop-in replacement for the analytic SE. It answers the sampling question spec
§4.3b asks; the analytic SE answers the evidence question a difficulty comparison needs. Report both,
separately, and do not average them.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Spec §4.3b asks for at least 200. Enough for a percentile interval to be stable to roughly the
#: second decimal, which is finer than the difference between a usable and an unusable difficulty.
DEFAULT_REPLICATES = 200

#: Fewer epochs per replicate than the headline fit's 300. A bootstrap needs the SPREAD across
#: replicates, not the last decimal of each one, and 300 x 200 refits is hours for a result that does
#: not change. The cost is recorded rather than hidden: `--epochs` exists and the value used is
#: printed with the output.
BOOTSTRAP_EPOCHS = 120

#: A problem present in fewer than this share of replicates has no distribution worth summarising —
#: its SE would be computed from a handful of values.
MIN_REPLICATE_PRESENCE = 0.5


def _utf8_stdout() -> None:
    """Non-ASCII printing survives a redirected stdout. See analysis/calibration.py for the failure
    this prevents: cp1252 on Windows makes an em dash fatal in CI and invisible in a terminal."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def bootstrap_beta(observations, replicates: int, epochs: int,
                   seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Per-problem (bootstrap SE, replicate count) over resampled learners.

    Returns NaN for problems whose presence falls below `MIN_REPLICATE_PRESENCE` rather than a
    number computed from too few replicates — an SE from 12 values is worse than no SE, because it
    looks the same in a table.
    """
    from features.irt import fit_rasch

    rng = np.random.default_rng(seed)
    n_learners = observations.n_learners
    n_problems = observations.n_problems

    # Rows grouped by learner, so a resampled learner's whole history comes along. Built once:
    # doing it inside the loop is the difference between minutes and hours.
    order = np.argsort(observations.li, kind="stable")
    li_sorted = observations.li[order]
    pi_sorted = observations.pi[order]
    # `observations.target` is the COLUMN NAME ("solved"), not the outcome array — the values live in
    # `observations.lp`. Indexing the name gave a TypeError rather than silently wrong data, which is
    # the good version of this mistake.
    y_sorted = observations.lp[observations.target].to_numpy(dtype=float)[order]
    starts = np.searchsorted(li_sorted, np.arange(n_learners))
    ends = np.searchsorted(li_sorted, np.arange(n_learners), side="right")

    collected = np.full((replicates, n_problems), np.nan)
    for r in range(replicates):
        picked = rng.integers(0, n_learners, n_learners)
        # Relabel each drawn learner as a NEW learner index. Without this, drawing the same learner
        # twice merges their two copies into one theta and the resample stops being a resample.
        idx = np.concatenate([np.arange(starts[p], ends[p]) for p in picked])
        new_li = np.repeat(np.arange(len(picked)), ends[picked] - starts[picked])

        beta, _ = _fit_beta(fit_rasch, new_li, pi_sorted[idx], y_sorted[idx],
                            len(picked), n_problems, epochs, seed + r)
        present = np.bincount(pi_sorted[idx], minlength=n_problems) > 0
        collected[r, present] = beta[present]

        if (r + 1) % 25 == 0 or r == 0:
            print(f"    replicate {r + 1}/{replicates}")

    counts = np.sum(~np.isnan(collected), axis=0)
    with np.errstate(invalid="ignore"):
        se = np.nanstd(collected, axis=0, ddof=1)
    se[counts < replicates * MIN_REPLICATE_PRESENCE] = np.nan
    return se, counts


def _fit_beta(fit_rasch, li, pi, y, n_learners, n_problems, epochs, seed):
    """One replicate's Rasch fit, returning (beta, theta). Verbose off — 200 fits of progress output
    is noise that hides the replicate counter."""
    result = fit_rasch(li, pi, y, n_learners, n_problems,
                       epochs=epochs, seed=seed, verbose=False)
    # fit_rasch returns (theta, beta) or an object depending on version; handle both rather than
    # guessing, because guessing here silently swaps the two parameter vectors.
    if isinstance(result, tuple):
        theta, beta = result[0], result[1]
        # theta is per-learner, beta per-problem: use length to disambiguate rather than position.
        if len(theta) == n_problems and len(beta) == n_learners:
            theta, beta = beta, theta
        return np.asarray(beta), np.asarray(theta)
    return np.asarray(result.beta), np.asarray(result.theta)


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replicates", type=int, default=DEFAULT_REPLICATES)
    parser.add_argument("--epochs", type=int, default=BOOTSTRAP_EPOCHS)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    parser.add_argument("--write", action="store_true",
                        help="write gold_problem_difficulty_bootstrap")
    args = parser.parse_args()

    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    from features.irt_data import load_observations

    observations = load_observations(args.warehouse)
    print(f"  {observations.n_obs:,} observations, {observations.n_learners:,} learners, "
          f"{observations.n_problems:,} problems")
    print(f"  {args.replicates} replicates x {args.epochs} epochs, resampling LEARNERS\n")

    started = time.time()
    se, counts = bootstrap_beta(observations, args.replicates, args.epochs)
    print(f"\n  {time.time() - started:.0f}s for {args.replicates} replicates")

    analytic = pd.read_parquet(os.path.join(args.warehouse, "gold_problem_difficulty"),
                               columns=["problem_id", "difficulty_beta_se_analytic",
                                        "n_observations"])
    frame = pd.DataFrame({
        "problem_id": observations.problems,
        "difficulty_beta_se_bootstrap": se,
        "bootstrap_replicates": counts,
    }).merge(analytic, on="problem_id", how="inner")

    usable = frame.dropna(subset=["difficulty_beta_se_bootstrap"])
    print(f"\n  {len(usable):,}/{len(frame):,} problems present in "
          f">={MIN_REPLICATE_PRESENCE:.0%} of replicates")
    if len(usable) > 1:
        ratio = (usable.difficulty_beta_se_bootstrap
                 / usable.difficulty_beta_se_analytic.replace(0, np.nan))
        spearman = usable.difficulty_beta_se_bootstrap.corr(
            usable.difficulty_beta_se_analytic, method="spearman")
        print(f"  median bootstrap/analytic SE ratio  {ratio.median():.2f}")
        print(f"  spearman(bootstrap, analytic)       {spearman:.4f}")
        print()
        if ratio.median() > 1.3:
            print("  The bootstrap is materially WIDER than the analytic SE. The analytic form")
            print("  assumes the model is correctly specified; analysis/calibration.py already")
            print("  measured that it is not (mid-range overconfidence, MCE 0.171, because a 1PL")
            print("  has no discrimination parameter). So the analytic SE understates uncertainty")
            print("  and should not be used to decide whether two problems differ in difficulty.")
        elif ratio.median() < 0.8 and abs(spearman) < 0.3:
            # MEASURED: ratio 0.59, spearman 0.127. The glib reading is "the prior dominates"; the
            # correlation says something more specific and more useful.
            print("  The bootstrap is NARROWER (ratio "
                  f"{ratio.median():.2f}) and BARELY CORRELATED with the analytic SE "
                  f"(spearman {spearman:.3f}).")
            print("  They are not two estimates of one quantity — they answer different questions:")
            print()
            print("    analytic   how tightly does THIS problem's own data pin down its beta?")
            print("               Large for a problem with 7 observations.")
            print("    bootstrap  how far would beta move if we had sampled different LEARNERS?")
            print("               Small, because resampling 117k learners usually retains any")
            print("               given problem's handful of attempts.")
            print()
            print("  So a population-level cluster bootstrap does NOT capture per-problem estimation")
            print("  uncertainty, and should not be used as a drop-in replacement for the analytic")
            print("  SE. It answers the sampling question spec 4.3b asks; the analytic SE answers")
            print("  the evidence question a difficulty comparison needs. Report both, separately.")
        elif ratio.median() < 0.8:
            print("  The bootstrap is NARROWER than the analytic SE, which usually means the L2")
            print("  prior is doing more work than the data. Treat both as lower bounds.")
        else:
            print("  The two broadly agree, so the analytic SE is trustworthy and much cheaper.")

    if args.write:
        from features.irt_data import write_table
        path = write_table(frame, args.warehouse, "gold_problem_difficulty_bootstrap")
        print(f"\n  wrote {path}")
    else:
        print("\n  not written — pass --write to persist gold_problem_difficulty_bootstrap")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
