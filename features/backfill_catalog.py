"""Add the problems learners attempted but the problemset endpoint never returned. Spec §4.1a.

Run:  VC_WAREHOUSE=... python -m features.backfill_catalog          # dry run, default
      VC_WAREHOUSE=... python -m features.backfill_catalog --write  # writes the warehouse

WHAT THIS FIXES, AND WHY A RE-FETCH WOULD NOT
------------------------------------------------
`quality/contracts.py` measured 906 problem_ids in the fact tables absent from
`gold_problem_catalog`, covering 28,285 learner-problem rows (2.1%) and 12,496 learners, skewed hard
to later contest indices.

`features/ingest/codeforces_fetch.write_catalog` fetches `problemset.problems` — the official RATED
problemset — while the facts come from `contest.status`, which records every submission to every
problem. Unrated, gym and some later Div. 2 problems appear in submissions and never in the
problemset. **So re-running the fetch reproduces the identical gap.** This closes it from data
already on disk, with no network and no API budget.

WHAT IS RECOVERABLE AND WHAT IS NOT — STATED, NOT PAPERED OVER
----------------------------------------------------------------
    problem_id       from the fact table                exact
    contest_id       parsed from the id ("1008-C")      exact
    problem_index    parsed from the id                 exact
    rating           `problem_rating` on the fact row   exact where present, else null
    concepts         from `gold_problem_concepts`       exact
    name             NOT RECOVERABLE                    null
    tags             NOT RECOVERABLE                    empty

`name` and `tags` come only from the API. Leaving them null is the honest option: the purpose here is
to stop every join silently dropping 2.1% of rows, and a join needs the key, not the title. Inventing
a placeholder name would put a fabricated string in a table other code reads as authoritative.

Every added row is marked `catalog_source = "backfilled"`, and existing rows become `"problemset"`.
Without that column the two provenances are indistinguishable, and the next person cannot tell a real
catalogue entry from a reconstructed one.

WHY IT WRITES A NEW TABLE RATHER THAN EDITING IN PLACE
--------------------------------------------------------
`gold_problem_catalog` is Spark output. Overwriting it means the next `make features` silently reverts
this, and a half-written directory leaves the warehouse unreadable. So this writes
`gold_problem_catalog_complete` and leaves the original untouched — the Spark job stays the single
writer of its own table, and `quality/contracts.py` prefers the complete table when it exists.
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

#: The table this writes. Deliberately not `gold_problem_catalog` — see the module docstring.
OUTPUT_TABLE = "gold_problem_catalog_complete"


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def parse_problem_id(problem_id: str) -> tuple[int | None, str | None]:
    """`"1008-C"` -> `(1008, "C")`.

    `rpartition`, not `split("-")`: an index can itself contain a hyphen in principle, and splitting
    on the first separator would put half the index into the contest id. Returns `(None, None)` for
    anything unparseable rather than guessing — a row with a null contest_id is visibly incomplete,
    whereas a wrong one joins to the wrong contest.
    """
    contest, sep, index = problem_id.rpartition("-")
    if not sep or not contest.isdigit() or not index:
        return None, None
    return int(contest), index


def build_missing_rows(warehouse: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """`(existing catalogue, rows to add)`."""
    catalogue = pd.read_parquet(os.path.join(warehouse, "gold_problem_catalog"))

    facts = pd.read_parquet(os.path.join(warehouse, "gold_learner_problem"),
                            columns=["problem_id", "problem_rating"])
    # One row per problem. `first` rather than `mean`: the rating is a property of the problem, so
    # every fact row carries the same value and averaging would only hide a disagreement.
    ratings = facts.groupby("problem_id").problem_rating.first()

    concepts = (pd.read_parquet(os.path.join(warehouse, "gold_problem_concepts"))
                .groupby("problem_id").concept_id.apply(list))

    # The union of every problem_id any fact table references — the catalogue's job is to cover all
    # of them, and difficulty is included because the IRT fit produced betas for problems the
    # catalogue never listed.
    referenced = set(ratings.index) | set(concepts.index)
    difficulty_path = os.path.join(warehouse, "gold_problem_difficulty")
    if os.path.isdir(difficulty_path):
        referenced |= set(pd.read_parquet(difficulty_path, columns=["problem_id"]).problem_id)

    missing_ids = sorted(referenced - set(catalogue.problem_id))
    parsed = [parse_problem_id(pid) for pid in missing_ids]

    rows = pd.DataFrame({
        "problem_id": missing_ids,
        "contest_id": [c for c, _ in parsed],
        "problem_index": [i for _, i in parsed],
        # Never fabricated. See the module docstring.
        "name": [None] * len(missing_ids),
        "rating": [ratings.get(pid, np.nan) for pid in missing_ids],
        "tags": [[] for _ in missing_ids],
        "concepts": [concepts.get(pid, []) for pid in missing_ids],
    })
    return catalogue, rows


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    parser.add_argument("--write", action="store_true",
                        help=f"write {OUTPUT_TABLE} (default is a dry run)")
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    catalogue, missing = build_missing_rows(args.warehouse)
    print(f"  existing catalogue      {len(catalogue):,} problems")
    print(f"  referenced but absent   {len(missing):,} problems")

    if missing.empty:
        print("\n  Nothing to backfill — the catalogue already covers every referenced problem.")
        return 0

    unparseable = int(missing.contest_id.isna().sum())
    print(f"  ids that parse cleanly  {len(missing) - unparseable:,}"
          + (f"  ({unparseable} could not be parsed and keep a null contest_id)"
             if unparseable else ""))
    print(f"  with a rating recovered {int(missing.rating.notna().sum()):,}")
    print(f"  with concepts recovered {int(missing.concepts.apply(bool).sum()):,}")
    print(f"  index distribution      "
          f"{missing.problem_index.value_counts().head(6).to_dict()}")

    combined = pd.concat([catalogue.assign(catalog_source="problemset"),
                          missing.assign(catalog_source="backfilled")],
                         ignore_index=True)
    print(f"\n  combined                {len(combined):,} problems "
          f"({len(missing) / len(combined) * 100:.1f}% backfilled)")

    # Checked before writing, not asserted afterwards: a duplicate problem_id in the catalogue would
    # fan out every join that uses it and inflate downstream counts silently.
    duplicates = int(combined.problem_id.duplicated().sum())
    if duplicates:
        print(f"\n  REFUSING TO WRITE: {duplicates} duplicate problem_id values in the result.")
        return 1

    if not args.write:
        print(f"\n  dry run — pass --write to create {OUTPUT_TABLE}")
        return 0

    from features.irt_data import write_table

    path = write_table(combined, args.warehouse, OUTPUT_TABLE)
    print(f"\n  wrote {path}")
    print("  gold_problem_catalog is UNCHANGED — the Spark job remains its only writer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
