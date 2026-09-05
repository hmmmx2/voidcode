"""Run the sql/models/*.sql analytical models, and the sql/tests/*.sql assertions over them.

Run INSIDE WSL, where Spark and the Hive metastore live:

    source $HOME/.voidcode/env.sh
    python -m sql.run_models              # run every model, print shape and a sample
    python -m sql.run_models --test       # run the models, then assert on them  (make sql-test)
    python -m sql.run_models --only 03    # one model, by filename prefix

WHY A DRIVER RATHER THAN SIX HAND-RUN QUERIES
-----------------------------------------------
Spec 4.1a requires each model to be a standalone documented `.sql` file, not a notebook cell — so the
files hold nothing but SQL and its documentation, and everything procedural lives here. That keeps a
model reviewable by someone who reads SQL and not Python, and it means `make sql-test` covers all six
rather than whichever ones a person remembered to run.

HOW THE ASSERTIONS WORK: VIOLATIONS, NOT BOOLEANS
---------------------------------------------------
Each file in `sql/tests/` is a SELECT that returns ONE ROW PER PROBLEM FOUND. Empty result means the
assertion passed. A boolean-returning test would say `false` and leave you to work out which row broke
it; returning the offending rows means a failure arrives with its own evidence.

Every model is registered as a temp view named after its file with the numeric prefix stripped
(`01_cohort_retention.sql` -> `cohort_retention`), so an assertion can query the model output directly
by name. That is also why a test file can join a model back against a base table to check referential
integrity.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MODELS_DIR = ROOT / "sql" / "models"
TESTS_DIR = ROOT / "sql" / "tests"

#: A model returning nothing is a silent failure: the SQL is valid, the run is green, and the table
#: is empty. Spec 0 rule 2 wants NOT MEASURED over a fabricated number, and an empty result set
#: reported as success is the fabrication's quieter cousin.
MIN_ROWS = 1


def view_name(path: Path) -> str:
    """`01_cohort_retention.sql` -> `cohort_retention`. The prefix orders the files, not the views."""
    stem = path.stem
    return stem.split("_", 1)[1] if stem[:2].isdigit() else stem


def statement(path: Path) -> str:
    """The file's SQL. Comments are left in — Spark ignores them and they carry the documentation."""
    return path.read_text(encoding="utf-8").strip().rstrip(";")


def run_models(spark, only: str | None = None, *, show: bool = True) -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in sorted(MODELS_DIR.glob("*.sql")):
        if only and not path.stem.startswith(only):
            continue
        name = view_name(path)
        df = spark.sql(statement(path))
        df.createOrReplaceTempView(name)
        # Cached because every assertion below re-reads the view, and model 5 is a self-join over
        # 1.2M rows. Without this each test file pays for the whole computation again.
        df.cache()
        counts[name] = df.count()
        print(f"\n  {name}: {counts[name]:,} rows, {len(df.columns)} columns")
        print(f"    {', '.join(df.columns)}")
        if show:
            df.show(5, truncate=40)
    return counts


def run_tests(spark) -> int:
    """Every assertion file. Returns the number that failed."""
    failures = 0
    for path in sorted(TESTS_DIR.glob("*.sql")):
        violations = spark.sql(statement(path))
        rows = violations.collect()
        if rows:
            failures += 1
            print(f"\n  FAIL {path.name}: {len(rows)} violation(s)")
            for row in rows[:5]:
                print(f"    {row}")
        else:
            print(f"  ok   {path.name}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true", help="run the sql/tests assertions too")
    parser.add_argument("--only", help="filename prefix, e.g. 03")
    parser.add_argument("--cores", type=int, default=4)
    parser.add_argument("--quiet", action="store_true", help="skip the sample rows")
    args = parser.parse_args()

    from sql.session import DB_FULL, build_session

    spark = build_session(app_name="voidcode-sql-models", cores=args.cores)
    spark.sql(f"USE {DB_FULL}")

    models = sorted(MODELS_DIR.glob("*.sql"))
    if not models:
        print("no models in sql/models/")
        return 1
    print(f"  {len(models)} model(s) in {MODELS_DIR}")

    counts = run_models(spark, args.only, show=not args.quiet)
    empty = [name for name, n in counts.items() if n < MIN_ROWS]
    if empty:
        print(f"\n  EMPTY MODEL(S): {', '.join(empty)}")
        print("  A model that returns no rows is a failure, not a pass — see MIN_ROWS.")
        return 1

    if not args.test:
        print("\n  models ran. Pass --test to run the sql/tests assertions.")
        return 0

    print(f"\n  assertions in {TESTS_DIR}:")
    failures = run_tests(spark)
    print()
    if failures:
        print(f"  {failures} assertion file(s) FAILED.")
        return 1
    print(f"  all assertions passed over {len(counts)} model(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
