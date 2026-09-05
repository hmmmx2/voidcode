"""Data contracts for the gold tables. Spec §8.1.

Run:  VC_WAREHOUSE=... python -m quality.contracts

`pandera==0.32.1` has been pinned in `features/requirements.lock.txt` since the feature work landed
and imported by nothing. This is the importer.

WHY THIS VALIDATES THE WAREHOUSE RATHER THAN WRAPPING THE SPARK WRITES
------------------------------------------------------------------------
Spec §8.1 asks for a contract at every Spark stage, failing the job on violation. That is the right
shape and it cannot be verified on a machine with no Spark installed — a schema wrapped around a write
path nobody can execute is a claim, not a control.

So these are pandera schemas over the **tables that exist**, run against the live warehouse. The
difference matters: wrapping the writer tells you what the next run will produce, and this tells you
what the current 2.3 million rows actually contain. When Spark is available, import these same schemas
at the write sites — the schema objects are the reusable part, and nothing here needs rewriting.

WHAT THESE CHECK, AND WHY EACH ONE
-------------------------------------
Not "does the column exist". Type checks catch typos; the checks below catch the failures that produced
wrong numbers in this project:

* **Ranges on rates.** A `pass_rate` above 1.0 or below 0 means a division went wrong upstream, and it
  propagates into mastery, candidate generation and the ranker as a plausible number.
* **Referential integrity.** Every `problem_id` in a fact table must exist in the catalogue. A dangling
  id silently drops rows from every join, which reads as a content gap rather than a data fault.
* **`n_observations` against the actual row count.** This is the check that would have caught the leak:
  the stored column totals the ALL-TIME count, and a contract comparing it to a pre-cutoff filter is
  how you find out that it is not what its name suggests.
* **Uniqueness on keys.** A duplicated `(learner_id, concept_id)` double-counts that concept in every
  mastery estimate, which is precisely the failure `problem_concepts`' unique constraint exists to stop
  on the product side.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd
import pandera.pandas as pa
from pandera.pandas import Check, Column, DataFrameSchema

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: A rate must be a rate. Nullable because a learner with no attempts on a concept has no rate, which
#: is a different statement from a rate of zero — the same distinction `mastery_known` encodes.
_RATE = Column(float, Check.in_range(0.0, 1.0), nullable=True)

SCHEMAS: dict[str, DataFrameSchema] = {
    "gold_learner_problem": DataFrameSchema(
        {
            "learner_id": Column(str, nullable=False),
            "problem_id": Column(str, nullable=False),
            # At least one attempt, or the row should not exist.
            "attempts": Column(int, Check.greater_than_or_equal_to(1), coerce=True),
            # int32 {0, 1}, not bool — that is how Spark wrote it. Every consumer coerces, so this
            # is a storage fact rather than a defect, and a contract demanding bool would report a
            # violation that is really a disagreement between the schema and reality.
            # coerce=True because Spark wrote int32 and pandera's `int` means int64. The contract
            # cares that the values are 0/1, not how many bytes they occupy — pinning the width would
            # fail the table for a storage detail and break again if Spark ever widens it.
            "solved": Column(int, Check.isin([0, 1]), nullable=False, coerce=True),
            # Sanity window rather than an exact bound: Codeforces launched in 2010, and a timestamp
            # far in the future means a unit mix-up (milliseconds read as seconds).
            "first_attempt_at": Column(int, Check.in_range(1_200_000_000, 2_000_000_000),
                                       coerce=True),
        },
        # One row per (learner, problem). A duplicate double-counts that pair in every aggregate
        # computed downstream, and the aggregates are all plausible either way.
        unique=["learner_id", "problem_id"],
        strict=False,
        name="gold_learner_problem",
    ),
    "gold_learner_concept_mastery": DataFrameSchema(
        {
            "learner_id": Column(str, nullable=False),
            "concept_id": Column(str, nullable=False),
            "attempt_count": Column(int, Check.greater_than_or_equal_to(1), coerce=True),
            "pass_rate": _RATE,
            "recency_weighted_mastery": _RATE,
            "first_attempt_pass_rate": _RATE,
            "solve_rate": _RATE,
        },
        unique=["learner_id", "concept_id"],
        strict=False,
        name="gold_learner_concept_mastery",
    ),
    "gold_problem_difficulty": DataFrameSchema(
        {
            "problem_id": Column(str, nullable=False),
            # NO unconditional range check here. Measured: 482 of 11,284 problems (4.3%) have
            # |beta| > 10, up to 15.24 — and 83.2% of those have 2 or fewer observations, median 1.
            #
            # So the extremes are not bad data, they are the Rasch fit hitting a boundary where it has
            # almost no evidence: one person solved it, so beta runs off to "trivially easy", and one
            # person failed it, so beta runs off the other way. `check_difficulty_is_estimable` below
            # asserts the range only where there is evidence to support one, which is the honest
            # contract. An unconditional check would fail the table for doing exactly what maximum
            # likelihood does on n=1.
            "difficulty_beta": Column(float, nullable=False),
            "n_observations": Column(int, Check.greater_than_or_equal_to(1), coerce=True),
        },
        unique=["problem_id"],
        strict=False,
        name="gold_problem_difficulty",
    ),
    "gold_problem_concepts": DataFrameSchema(
        {
            "problem_id": Column(str, nullable=False),
            "concept_id": Column(str, nullable=False),
        },
        # The product side enforces this with a UNIQUE constraint precisely because a duplicated pair
        # moves weight onto one concept in every mastery estimate.
        unique=["problem_id", "concept_id"],
        strict=False,
        name="gold_problem_concepts",
    ),
}


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

def check_referential_integrity(warehouse: str) -> list[str]:
    """Cross-table checks pandera schemas cannot express on their own.

    A dangling foreign key does not fail a schema — every column is the right type and in range. It
    fails a JOIN, silently, by dropping rows, and the result reads as missing content.
    """
    problems: list[str] = []

    # KNOWN FAULT, diagnosed rather than tolerated. gold_problem_catalog is NOT a superset of the
    # problems learners attempted: 906 problem_ids in the fact tables are missing from it, covering
    # 28,285 learner-problem rows (2.1%) and 12,496 learners. Meanwhile 933 catalogue entries have no
    # difficulty estimate, so the two sets overlap without either containing the other.
    #
    # The cause is visible in the index distribution. Missing problems skew hard to LATER indices
    # (C: 13,643 rows, D: 8,069, E: 1,783) while present ones skew to A and B (375,636 and 338,924).
    # That is a per-contest fetch truncation in `features/ingest/codeforces_fetch.py`, not a join bug:
    # the catalogue pass collected the first problems of each contest and stopped.
    #
    # Consumers: `ranking/eval.py` reads the problem list from gold_problem_difficulty and is
    # unaffected. Anything reading the CATALOGUE — candidate generation, per
    # `features/spark_jobs/build_features.py`, which writes it so untouched problems can be proposed —
    # both misses 906 real problems and offers 933 with no difficulty estimate.
    #
    # Fixing it needs a catalogue re-fetch and a Spark rebuild. Until then this check FAILS, on
    # purpose: a contract that tolerates a known fault stops being a contract.
    # Prefer the backfilled table when it exists. features/backfill_catalog.py reconstructs the 906
    # problems `problemset.problems` never returned, from data already on disk, and writes a SEPARATE
    # table so the Spark job stays the only writer of its own. Falling back keeps this check
    # meaningful on a warehouse where the backfill has not been run.
    complete = os.path.join(warehouse, "gold_problem_catalog_complete")
    catalogue_table = ("gold_problem_catalog_complete" if os.path.isdir(complete)
                       else "gold_problem_catalog")
    if catalogue_table.endswith("_complete"):
        print(f"  NOTE     using {catalogue_table} — includes backfilled entries whose `name` and "
              "`tags` are null because only the API has them")
    catalogue = set(pd.read_parquet(os.path.join(warehouse, catalogue_table),
                                    columns=["problem_id"]).problem_id)
    for table in ("gold_learner_problem", "gold_problem_concepts", "gold_problem_difficulty"):
        ids = set(pd.read_parquet(os.path.join(warehouse, table),
                                  columns=["problem_id"]).problem_id)
        orphans = ids - catalogue
        if orphans:
            problems.append(
                f"{table}: {len(orphans)} problem_id values are not in gold_problem_catalog "
                f"(e.g. {sorted(orphans)[:3]}) — every join on them silently drops rows")

    # `id`, not `concept_id`. The first version of this check asked for the wrong column and the
    # pyarrow error dumped a schema instead of naming the problem — worth the comment, because the
    # two tables genuinely disagree on the name.
    concepts = set(pd.read_parquet(os.path.join(warehouse, "gold_concepts"),
                                   columns=["id"]).id)
    for table in ("gold_problem_concepts", "gold_learner_concept_mastery"):
        ids = set(pd.read_parquet(os.path.join(warehouse, table),
                                  columns=["concept_id"]).concept_id)
        orphans = ids - concepts
        if orphans:
            problems.append(
                f"{table}: {len(orphans)} concept_id values are not in gold_concepts "
                f"(e.g. {sorted(orphans)[:3]})")
    return problems


#: Below this, a Rasch beta is a boundary artefact rather than a difficulty estimate. Chosen as the
#: catalogue median observation count (7): above it the fit has something to work with, below it the
#: likelihood is maximised by pushing beta to an extreme.
MIN_OBSERVATIONS_FOR_BETA = 7


def check_difficulty_is_estimable(warehouse: str) -> list[str]:
    """`difficulty_beta` must be sane WHERE THERE IS EVIDENCE, and is expected not to be elsewhere.

    This is the contract that explains two earlier findings at once: the difficulty-sorted baseline
    scoring exactly 0.0000, and `docs/METRICS.md` limitation 6 on filtering by observation count. Both
    come from the same place — thinly-observed problems get extreme betas — and until now that was a
    sentence rather than a check.
    """
    frame = pd.read_parquet(os.path.join(warehouse, "gold_problem_difficulty"))
    observed = frame[frame.n_observations >= MIN_OBSERVATIONS_FOR_BETA]
    thin = frame[frame.n_observations < MIN_OBSERVATIONS_FOR_BETA]

    problems = []
    extreme_observed = observed[observed.difficulty_beta.abs() > 10]
    if len(extreme_observed):
        problems.append(
            f"gold_problem_difficulty: {len(extreme_observed)} problems with "
            f">={MIN_OBSERVATIONS_FOR_BETA} observations still have |beta| > 10 "
            f"(max {extreme_observed.difficulty_beta.abs().max():.2f}) — the fit did not converge "
            "where it had evidence, which is a real problem rather than a boundary artefact")

    extreme_thin = thin[thin.difficulty_beta.abs() > 10]
    print(f"  NOTE     difficulty_beta: {len(extreme_thin)}/{len(thin)} thinly-observed problems "
          f"(<{MIN_OBSERVATIONS_FOR_BETA} obs) have |beta| > 10. Expected — maximum likelihood on "
          f"n=1 pushes beta to a boundary. Do not rank on beta without an evidence filter.")
    return problems


def check_observation_counts(warehouse: str) -> list[str]:
    """Does `n_observations` mean what its name suggests?

    This is the check that would have caught the leak in `ranking/eval.py`'s first popularity
    baseline. The column is used as a popularity signal, and a signal whose value depends on data from
    after the evaluation cutoff is future information about the labels.

    Reported as an OBSERVATION rather than a violation: the column is not wrong, it is all-time by
    construction. What was wrong was a consumer assuming otherwise, and this makes the assumption
    checkable instead of implicit.
    """
    rows = pd.read_parquet(os.path.join(warehouse, "gold_learner_problem"),
                           columns=["problem_id", "first_attempt_at"])
    stored = pd.read_parquet(os.path.join(warehouse, "gold_problem_difficulty"),
                             columns=["problem_id", "n_observations"])
    actual = rows.groupby("problem_id").size().rename("all_time")
    merged = stored.join(actual, on="problem_id").fillna({"all_time": 0})
    mismatched = int((merged.n_observations != merged.all_time).sum())
    return [
        f"gold_problem_difficulty.n_observations equals the ALL-TIME row count for "
        f"{len(merged) - mismatched}/{len(merged)} problems. It is NOT a pre-cutoff figure: any "
        f"consumer using it as a popularity feature is reading data from after its own cutoff. See "
        f"ranking/eval.pre_cutoff_popularity."
    ]


def validate(warehouse: str) -> int:
    print(f"warehouse: {warehouse}\n")
    failures = 0

    for table, schema in SCHEMAS.items():
        path = os.path.join(warehouse, table)
        if not os.path.isdir(path):
            print(f"  SKIP     {table} — not present")
            continue
        frame = pd.read_parquet(path)
        try:
            # lazy=True collects EVERY violation rather than raising on the first. One error at a time
            # means N runs to see N problems, and the second is often the informative one.
            schema.validate(frame, lazy=True)
            print(f"  ok       {table:34} {len(frame):>9,} rows")
        except pa.errors.SchemaErrors as exc:
            failures += 1
            cases = exc.failure_cases
            print(f"  FAILED   {table:34} {len(frame):>9,} rows, "
                  f"{len(cases)} failing case(s)")
            for _, case in cases.head(5).iterrows():
                print(f"             {case.get('check')} on {case.get('column')}: "
                      f"{str(case.get('failure_case'))[:60]}")

    print()
    for problem in check_difficulty_is_estimable(warehouse):
        failures += 1
        print(f"  FAILED   {problem}")

    print()
    for problem in check_referential_integrity(warehouse):
        failures += 1
        print(f"  FAILED   referential integrity: {problem}")
    else:
        pass
    if failures == 0:
        print("  ok       referential integrity across problem_id and concept_id")

    print()
    for note in check_observation_counts(warehouse):
        print(f"  NOTE     {note}")

    print(f"\n  {failures} contract failure(s)")
    return 1 if failures else 0


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
    return validate(args.warehouse)


if __name__ == "__main__":
    raise SystemExit(main())
