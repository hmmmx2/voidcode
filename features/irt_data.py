"""Shared observation loading and train/held-out splitting for the IRT models.

`irt.py`, `irt_tune.py` and `irt_bootstrap.py` all need the same matrix and, more
importantly, the *same split*. Duplicating the indexing and the RNG seed across three
files is how a tuning run ends up selecting hyperparameters against rows the final fit
then trains on. One definition, imported everywhere.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

DEFAULT_SEED = 7
DEFAULT_VAL_FRAC = 0.1


def write_table(df: pd.DataFrame, warehouse: str, name: str) -> str:
    """Write a pandas frame as a single-part Parquet *directory*.

    Spark writes tables as directories; `pandas.to_parquet` writes a bare file. A
    warehouse containing both cannot be registered uniformly in Hive, whose `LOCATION`
    clause expects a directory — the file-backed tables are silently skipped and the
    catalog looks incomplete for no visible reason.

    Keeping every table a directory costs nothing: both `pd.read_parquet` and
    `spark.read.parquet` read a directory transparently.
    """
    out = os.path.join(warehouse, name)
    if os.path.isfile(out):
        os.remove(out)                 # migrate a legacy single-file table
    os.makedirs(out, exist_ok=True)
    # Clear stale parts so a rerun producing fewer rows cannot leave orphans behind
    # that would then be read back as part of the table.
    for f in os.listdir(out):
        if f.endswith(".parquet"):
            os.remove(os.path.join(out, f))
    df.to_parquet(os.path.join(out, "part-0.parquet"), index=False)
    return out


@dataclass
class Observations:
    """A (learner, problem) response matrix in index form, plus its split."""

    learners: pd.Index           # position -> learner_id
    problems: pd.Index           # position -> problem_id
    li: np.ndarray               # learner index per observation
    pi: np.ndarray               # problem index per observation
    y: np.ndarray                # binary outcome per observation
    train_mask: np.ndarray
    val_mask: np.ndarray
    lp: pd.DataFrame             # the source gold_learner_problem rows, aligned to li/pi
    pc: pd.DataFrame             # gold_problem_concepts
    target: str

    @property
    def n_learners(self) -> int:
        return len(self.learners)

    @property
    def n_problems(self) -> int:
        return len(self.problems)

    @property
    def n_obs(self) -> int:
        return len(self.y)

    def problem_ratings(self) -> pd.Series:
        """Published Codeforces rating per problem, aligned to `problems`.

        The model never sees this. It exists only so the recovered difficulty can be
        checked against an external ground truth.
        """
        return (self.lp.groupby("problem_id")["problem_rating"].max()
                .reindex(self.problems))


def load_observations(warehouse: str, *, target: str = "solved",
                      min_attempts: int = 1, val_frac: float = DEFAULT_VAL_FRAC,
                      seed: int = DEFAULT_SEED) -> Observations:
    lp = pd.read_parquet(
        os.path.join(warehouse, "gold_learner_problem"),
        columns=["learner_id", "problem_id", "solved", "first_attempt_pass",
                 "problem_rating"],
    )
    pc = pd.read_parquet(os.path.join(warehouse, "gold_problem_concepts"))

    if min_attempts > 1:
        keep = lp.groupby("learner_id")["problem_id"].transform("size") >= min_attempts
        lp = lp[keep]

    lp = lp.dropna(subset=[target]).reset_index(drop=True)
    lp[target] = lp[target].astype(np.float64)

    learners = pd.Index(lp["learner_id"].unique())
    problems = pd.Index(lp["problem_id"].unique())
    li = learners.get_indexer(lp["learner_id"]).astype(np.int64)
    pi = problems.get_indexer(lp["problem_id"]).astype(np.int64)
    y = lp[target].to_numpy()

    # Fixed seed, fixed fraction, one place. Every consumer gets the same split.
    rng = np.random.default_rng(seed)
    val_mask = rng.random(len(y)) < val_frac
    return Observations(
        learners=learners, problems=problems, li=li, pi=pi, y=y,
        train_mask=~val_mask, val_mask=val_mask, lp=lp, pc=pc, target=target,
    )
