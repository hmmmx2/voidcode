"""Register the Parquet warehouse as external Hive tables.

Registration, not conversion. `build_features.py` keeps writing plain Parquet and keeps
working with no metastore at all — three reasons that matters:

1. `make features-train` builds a *second* warehouse for the Phase 3 leakage fix. Coupling
   the build job to a single-writer Derby lock would tie leakage prevention to metastore
   availability.
2. Managed tables relocate data under `spark.sql.warehouse.dir`, which would break every
   path-based reader: `features/irt.py`, `features/irt_data.py`, `ranking/split.py`.
3. `DROP TABLE` on an external table removes the definition, not the data. Given this runs
   drop-then-recreate on every invocation, managed tables would delete the warehouse.

`silver_submissions` is written with `partitionBy("submission_date")`. Hive does not
discover partitions on its own, so `RECOVER PARTITIONS` runs after every registration —
without it the table exists, queries succeed, and every one returns zero rows.

    python -m sql.register_tables            # register $VC_WAREHOUSE as voidcode
    python -m sql.register_tables --train    # also register voidcode_train
"""
from __future__ import annotations

import argparse
import json
import os

from sql.session import DB_FULL, DB_TRAIN, build_session, warehouse_path

# Tables to register if present. Absent ones are reported, not fatal — the warehouse grows
# as later phases land and this must stay runnable in between.
TABLES = [
    "silver_submissions",
    "gold_learner_problem",
    "gold_problem_concepts",
    "gold_problem_catalog",
    # The 906 problems `problemset.problems` never returned, recovered by
    # features/backfill_catalog.py into a SEPARATE table so the Spark job stays the only writer of
    # gold_problem_catalog. It was unregistered, so every SQL and HiveQL consumer could only see the
    # incomplete catalogue — the recovered rows existed on disk and were unreachable from the layer
    # built to query them. `name` and `tags` are NULL on backfilled rows; only the API has those.
    "gold_problem_catalog_complete",
    "gold_learner_concept_mastery",
    "gold_learner_concept_irt",
    "gold_learner_ability",
    "gold_problem_difficulty",
    "gold_concepts",
    "gold_concept_prereq_edges",
    # written by later steps; skipped cleanly until they exist
    "gold_problem_difficulty_bootstrap",
    "gold_learner_segment_features",
    "gold_learner_segment",
    "gold_concept_association_rules",
]

PARTITIONED = {"silver_submissions"}


def register(spark, database: str, warehouse: str) -> dict:
    spark.sql(f"CREATE DATABASE IF NOT EXISTS {database}")
    registered, missing = [], []

    for table in TABLES:
        path = os.path.join(warehouse, table)
        if not os.path.isdir(path):
            missing.append(table)
            continue
        fq = f"{database}.{table}"
        # Drop-then-create because the schema legitimately changes between pipeline
        # runs. Safe only because these are EXTERNAL tables — this is metadata.
        spark.sql(f"DROP TABLE IF EXISTS {fq}")
        spark.sql(f"CREATE TABLE {fq} USING parquet LOCATION '{path}'")
        if table in PARTITIONED:
            # Mandatory. Without it the table reads as empty and nothing errors.
            spark.sql(f"ALTER TABLE {fq} RECOVER PARTITIONS")
        registered.append(table)

    return {"database": database, "warehouse": warehouse,
            "registered": registered, "missing": missing}


def verify(spark, database: str, tables: list[str]) -> dict:
    """Count every registered table. A partitioned table that was never recovered
    returns 0 here, which is the whole point of counting rather than trusting SHOW TABLES."""
    counts = {}
    for t in tables:
        counts[t] = spark.sql(f"SELECT count(*) AS n FROM {database}.{t}").collect()[0]["n"]
    return counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true",
                    help="also register the pre-cutoff warehouse as voidcode_train")
    ap.add_argument("--cores", type=int, default=4)
    a = ap.parse_args()

    spark = build_session("voidcode-hive-register", cores=a.cores)
    spark.sparkContext.setLogLevel("WARN")
    report = {}

    for db, wh, active in ((DB_FULL, warehouse_path(False), True),
                           (DB_TRAIN, warehouse_path(True), a.train)):
        if not active:
            continue
        if not os.path.isdir(wh):
            print(f"SKIP {db}: {wh} does not exist")
            continue
        r = register(spark, db, wh)
        r["row_counts"] = verify(spark, db, r["registered"])
        report[db] = r

        print(f"\n=== {db} ({wh}) ===")
        for t in r["registered"]:
            n = r["row_counts"][t]
            flag = "  <-- EMPTY" if n == 0 else ""
            print(f"  {t:38s} {n:>12,}{flag}")
        if r["missing"]:
            print(f"  not yet built: {', '.join(r['missing'])}")

    out = os.path.join(warehouse_path(False), "hive_registration.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nwrote {out}")
    spark.stop()


if __name__ == "__main__":
    main()
