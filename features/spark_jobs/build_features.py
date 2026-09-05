"""Phase 2 — Spark feature pipeline. Bronze JSONL -> silver Parquet -> gold mastery vectors.

Implements every feature in spec §4.3. The job is idempotent: outputs are overwritten,
and every time-dependent quantity is anchored to the maximum timestamp *in the data*
rather than to wall-clock now, so a rerun on the same input produces byte-identical
output. That property is what spec §4.4 means by "reruns cleanly from raw input".

    spark-submit features/spark_jobs/build_features.py --cores 10

Stages
  1  bronze -> silver   dedupe, hash handles, normalise verdicts, partition by date
  2  problem -> concept projection through data/concepts.yaml
  3  per (learner, problem) rollup: attempt ordering, first-attempt outcome, time to accept
  4  per (learner, concept) mastery features
  5  prerequisite join: co-failure signal against the taxonomy DAG
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import time

from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F
from pyspark.sql.types import ArrayType, IntegerType, LongType, StringType, StructField, StructType

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
from features.taxonomy import load_taxonomy

# Codeforces verdict -> error taxonomy bucket (spec §4.3 "error taxonomy distribution")
VERDICT_BUCKET = {
    "OK": "accepted",
    "COMPILATION_ERROR": "compile_error",
    "RUNTIME_ERROR": "runtime_error",
    "WRONG_ANSWER": "wrong_answer",
    "PRESENTATION_ERROR": "wrong_answer",
    "CHALLENGED": "wrong_answer",
    "TIME_LIMIT_EXCEEDED": "timeout",
    "IDLENESS_LIMIT_EXCEEDED": "timeout",
    "MEMORY_LIMIT_EXCEEDED": "memory_limit",
}
BUCKETS = ["compile_error", "runtime_error", "wrong_answer", "timeout",
           "memory_limit", "other"]
# Codeforces gym/training contests are numbered from 100000 upward.
GYM_CONTEST_ID_FLOOR = 100_000
# Not evidence of anything the learner did: dropped before any aggregation.
NON_EVIDENCE_VERDICTS = ["TESTING", "SKIPPED"]

SCHEMA = StructType([
    StructField("submission_id", LongType()),
    StructField("user_handle", StringType()),
    StructField("problem_id", StringType()),
    StructField("contest_id", IntegerType()),
    StructField("problem_index", StringType()),
    StructField("problem_name", StringType()),
    StructField("problem_rating", IntegerType()),
    StructField("problem_tags", ArrayType(StringType())),
    StructField("verdict", StringType()),
    StructField("programming_language", StringType()),
    StructField("created_at", LongType()),
    StructField("relative_time_seconds", LongType()),
    StructField("participant_type", StringType()),
    StructField("testset", StringType()),
    StructField("passed_test_count", IntegerType()),
    StructField("time_consumed_ms", IntegerType()),
    StructField("memory_consumed_bytes", LongType()),
])


def build_spark(cores: int, driver_mem: str) -> SparkSession:
    return (SparkSession.builder
            .appName("voidcode-phase2-features")
            .master(f"local[{cores}]")
            .config("spark.driver.memory", driver_mem)
            .config("spark.sql.shuffle.partitions", cores * 4)
            .config("spark.sql.session.timeZone", "UTC")
            .config("spark.sql.parquet.compression.codec", "snappy")
            .getOrCreate())


# ── stage 1 ──────────────────────────────────────────────────────────────────
def to_silver(spark, raw_globs, salt: str, max_created_at: int | None = None):
    if isinstance(raw_globs, str):
        raw_globs = [raw_globs]
    subs = spark.read.schema(SCHEMA).json(list(raw_globs))

    # Tag the ingest mode from the source filename BEFORE any filter or shuffle.
    # input_file_name() is only populated while the plan is still attached to the
    # file scan; after dropDuplicates it returns an empty string.
    #
    # This distinction is load-bearing for Phase 3, not cosmetic. Breadth rows are a
    # chronological slice of recent contests; depth rows span a learner's whole
    # history over years. A single global temporal cutoff can therefore put almost
    # all of one population on one side of the split, which would look fine and
    # behave badly.
    subs = subs.withColumn(
        "ingest_mode",
        F.when(F.input_file_name().contains("/user_"), F.lit("depth"))
        .otherwise(F.lit("contest")))

    subs = (subs
            .filter(F.col("submission_id").isNotNull()
                    & F.col("user_handle").isNotNull()
                    & F.col("created_at").isNotNull())
            .filter(~F.col("verdict").isin(NON_EVIDENCE_VERDICTS))
            .filter(F.col("verdict").isNotNull())
            # Gym contests use ids >= 100000. user.status returns them, but their
            # problems are absent from problemset.problems and mostly unrated, so
            # they would pollute both the catalog and the concept projection.
            .filter(F.col("contest_id") < GYM_CONTEST_ID_FLOOR)
            # a submission id is globally unique on Codeforces; files can overlap
            .dropDuplicates(["submission_id"]))

    # The temporal cutoff for Phase 3. Features rebuilt with this set cannot see
    # post-cutoff behaviour, which is what stops ranking features leaking labels.
    if max_created_at is not None:
        subs = subs.filter(F.col("created_at") < F.lit(max_created_at))

    bucket = F.create_map(
        *[x for k, v in VERDICT_BUCKET.items() for x in (F.lit(k), F.lit(v))])

    return (subs
            .withColumn("learner_id",
                        F.sha2(F.concat(F.col("user_handle"), F.lit(salt)), 256)
                        .substr(1, 16))
            .withColumn("submission_ts", F.to_timestamp(F.col("created_at")))
            .withColumn("submission_date", F.to_date(F.col("submission_ts")))
            .withColumn("is_accepted", (F.col("verdict") == "OK").cast("int"))
            .withColumn("error_bucket",
                        F.coalesce(bucket[F.col("verdict")], F.lit("other")))
            .drop("user_handle"))          # handle never leaves the bronze layer


# ── stage 2 ──────────────────────────────────────────────────────────────────
def problem_concepts(spark, silver):
    """Project each distinct problem onto concepts on the driver.

    The distinct-problem set is small (hundreds), so this is a broadcast join rather
    than a per-row Python UDF, which would serialise 1M+ rows through the worker.
    """
    tax = load_taxonomy()
    rows = (silver.select("problem_id", "problem_rating", "problem_tags")
            .dropDuplicates(["problem_id"]).collect())
    mapped = []
    for r in rows:
        for c in tax.concepts_for(r["problem_tags"], r["problem_rating"]):
            mapped.append((r["problem_id"], c))
    if not mapped:
        raise RuntimeError("no problem mapped to any concept - taxonomy projection broke")
    # Returned unhinted: the caller broadcasts at each join site. Attaching the hint
    # here also attaches it to the write path, which Spark warns about.
    df = spark.createDataFrame(mapped, "problem_id string, concept_id string")
    return df, len(rows)


# ── stage 3 ──────────────────────────────────────────────────────────────────
def learner_problem(silver):
    """One row per (learner, problem): the attempt sequence collapsed."""
    w = Window.partitionBy("learner_id", "problem_id").orderBy("created_at",
                                                               "submission_id")
    ordered = silver.withColumn("attempt_no", F.row_number().over(w))

    first_accept = (ordered.filter(F.col("is_accepted") == 1)
                    .groupBy("learner_id", "problem_id")
                    .agg(F.min("attempt_no").alias("attempts_to_accept"),
                         F.min("created_at").alias("accepted_at")))

    base = (ordered.groupBy("learner_id", "problem_id")
            .agg(F.count("*").alias("attempts"),
                 F.max("is_accepted").alias("solved"),
                 F.min("created_at").alias("first_attempt_at"),
                 F.max("created_at").alias("last_attempt_at"),
                 F.max(F.col("problem_rating")).alias("problem_rating"),
                 F.first("contest_id", ignorenulls=True).alias("contest_id"),
                 # "depth" if ANY submission for this pair came from a user history:
                 # min() over {contest, depth} picks contest, so use max().
                 F.max("ingest_mode").alias("ingest_mode"),
                 F.max(F.when(F.col("attempt_no") == 1, F.col("is_accepted"))
                       ).alias("first_attempt_pass")))

    return (base.join(first_accept, ["learner_id", "problem_id"], "left")
            .withColumn("time_to_accept_s",
                        F.when(F.col("accepted_at").isNotNull(),
                               F.col("accepted_at") - F.col("first_attempt_at"))))


# ── stage 4 ──────────────────────────────────────────────────────────────────
def learner_concept(silver_c, lp_c, ref_ts: int, half_life_days: float):
    """The mastery vector. One row per (learner, concept)."""
    decay = F.pow(F.lit(0.5),
                  (F.lit(ref_ts) - F.col("created_at")) / F.lit(half_life_days * 86400))

    sub_agg = (silver_c.withColumn("w", decay)
               .groupBy("learner_id", "concept_id")
               .agg(
        F.count("*").alias("attempt_count"),
        F.avg("is_accepted").alias("pass_rate"),
        F.sum(F.col("w") * F.col("is_accepted")).alias("_wnum"),
        F.sum("w").alias("_wden"),
        # difficulty-adjusted: each attempt weighted by the problem's Elo rating
        F.sum(F.when(F.col("problem_rating").isNotNull(),
                     F.col("problem_rating") * F.col("is_accepted"))).alias("_dnum"),
        F.sum(F.when(F.col("problem_rating").isNotNull(),
                     F.col("problem_rating"))).alias("_dden"),
        F.max(F.when(F.col("is_accepted") == 1, F.col("problem_rating"))
              ).alias("max_rating_solved"),
        F.max("created_at").alias("last_seen_at"),
        *[F.avg((F.col("error_bucket") == b).cast("double")).alias(f"err_{b}")
          for b in BUCKETS],
    ))

    prob_agg = (lp_c.groupBy("learner_id", "concept_id")
                .agg(F.countDistinct("problem_id").alias("problems_attempted"),
                     F.sum("solved").alias("problems_solved"),
                     F.avg(F.coalesce(F.col("first_attempt_pass"), F.lit(0))
                           .cast("double")).alias("first_attempt_pass_rate"),
                     F.avg(F.when(F.col("solved") == 1, F.col("attempts_to_accept"))
                           ).alias("mean_attempts_to_accept"),
                     F.expr("percentile_approx(time_to_accept_s, 0.5, 100)")
                     .alias("median_time_to_accept_s")))

    return (sub_agg.join(prob_agg, ["learner_id", "concept_id"], "outer")
            .withColumn("recency_weighted_mastery",
                        F.when(F.col("_wden") > 0, F.col("_wnum") / F.col("_wden")))
            .withColumn("difficulty_adjusted_mastery",
                        F.when(F.col("_dden") > 0, F.col("_dnum") / F.col("_dden")))
            .withColumn("solve_rate",
                        F.when(F.col("problems_attempted") > 0,
                               F.col("problems_solved") / F.col("problems_attempted")))
            .drop("_wnum", "_wden", "_dnum", "_dden"))


# ── stage 5 ──────────────────────────────────────────────────────────────────
def prerequisite_signal(spark, mastery):
    """Co-failure against the taxonomy DAG.

    Spec §4.3 asks for "conditional failure rate given failure on a prerequisite".
    Operationalised as: for each (learner, concept), look up the learner's measured
    mastery of that concept's *direct* prerequisites. `has_failed_prereq` marks a
    learner who is below 0.5 on at least one observed prerequisite, and
    `co_failure_rate` is their failure rate on the concept restricted to that case —
    null when no prerequisite was observed, because an unmeasured prerequisite is not
    evidence of a mastered one.
    """
    tax = load_taxonomy()
    edges = [(c.id, p) for c in tax.concepts.values() for p in c.prerequisites]
    edge_df = F.broadcast(
        spark.createDataFrame(edges, "concept_id string, prereq_id string"))

    prereq_mastery = (edge_df
                      .join(mastery.select(
                          F.col("learner_id"),
                          F.col("concept_id").alias("prereq_id"),
                          F.col("recency_weighted_mastery").alias("prereq_mastery")),
                          on="prereq_id", how="inner")
                      .groupBy("learner_id", "concept_id")
                      .agg(F.min("prereq_mastery").alias("prereq_min_mastery"),
                           F.avg("prereq_mastery").alias("prereq_mean_mastery"),
                           F.count("*").alias("prereq_observed_count")))

    return (mastery.join(prereq_mastery, ["learner_id", "concept_id"], "left")
            .withColumn("has_failed_prereq",
                        F.when(F.col("prereq_min_mastery").isNull(), None)
                        .otherwise((F.col("prereq_min_mastery") < 0.5).cast("int")))
            .withColumn("co_failure_rate",
                        F.when(F.col("has_failed_prereq") == 1,
                               1.0 - F.col("pass_rate"))))


def write_problem_catalog(spark, raw_dir: str, out: str):
    """The full Codeforces catalog (~11k problems), projected onto concepts.

    Distinct from `gold_problem_concepts`, which covers only problems somebody has
    attempted. Phase 3 candidate generation must be able to propose a problem no
    observed learner has touched, so it reads this table instead.
    """
    path = os.path.join(raw_dir, "problemset.jsonl")
    if not os.path.exists(path):
        print("WARNING: problemset.jsonl absent; skipping gold_problem_catalog")
        return 0
    tax = load_taxonomy()
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = json.loads(line)
            concepts = tax.concepts_for(p.get("tags"), p.get("rating"))
            rows.append((p["problem_id"], p.get("contest_id"), p.get("problem_index"),
                         p.get("name"), p.get("rating"), p.get("tags") or [],
                         concepts))
    df = spark.createDataFrame(
        rows,
        "problem_id string, contest_id int, problem_index string, name string, "
        "rating int, tags array<string>, concepts array<string>")
    df.write.mode("overwrite").parquet(os.path.join(out, "gold_problem_catalog"))
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    data = os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data"))
    raw_dir = os.path.join(data, "raw", "codeforces")
    # Explicit globs, never "*.jsonl": problemset.jsonl lives in the same directory
    # and would be read under SCHEMA, silently producing a block of all-null rows.
    ap.add_argument("--raw", nargs="+",
                    default=[os.path.join(raw_dir, "contest_*.jsonl"),
                             os.path.join(raw_dir, "user_*.jsonl")])
    ap.add_argument("--out", default=os.path.join(data, "warehouse"))
    ap.add_argument("--cores", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--driver-mem", default="12g")
    ap.add_argument("--half-life-days", type=float, default=30.0)
    ap.add_argument("--salt", default=os.environ.get("VC_SALT", "voidcode-dev-salt"))
    ap.add_argument("--max-created-at", type=int, default=None,
                    help="epoch seconds; keep only submissions strictly before this. "
                         "Used to build the pre-cutoff warehouse_train for Phase 3.")
    a = ap.parse_args()

    t0 = time.time()
    spark = build_spark(a.cores, a.driver_mem)
    spark.sparkContext.setLogLevel("WARN")

    # Only the globs that actually match anything: Spark raises on a glob with no
    # files, and the user_*.jsonl set is empty until the depth pass has run.
    globs = [g for g in a.raw if glob.glob(g)]
    if not globs:
        raise SystemExit(f"no input files matched any of: {a.raw}")
    silver = to_silver(spark, globs, a.salt, a.max_created_at).cache()
    n_rows = silver.count()
    t_silver = time.time()

    pc, n_problems = problem_concepts(spark, silver)
    lp = learner_problem(silver)
    lp = lp.cache()

    silver_c = silver.join(F.broadcast(pc), "problem_id", "inner")
    lp_c = lp.join(F.broadcast(pc), "problem_id", "inner")

    ref_ts = silver.agg(F.max("created_at")).collect()[0][0]
    mastery = learner_concept(silver_c, lp_c, ref_ts, a.half_life_days)
    mastery = prerequisite_signal(spark, mastery).cache()

    out = a.out
    (silver.write.mode("overwrite").partitionBy("submission_date")
     .parquet(os.path.join(out, "silver_submissions")))
    lp.write.mode("overwrite").parquet(os.path.join(out, "gold_learner_problem"))
    (pc.write.mode("overwrite")
     .parquet(os.path.join(out, "gold_problem_concepts")))
    mastery.write.mode("overwrite").parquet(os.path.join(out, "gold_learner_concept_mastery"))
    n_catalog = write_problem_catalog(spark, raw_dir, out)

    n_mastery = mastery.count()
    n_learners = mastery.select("learner_id").distinct().count()
    n_concepts = mastery.select("concept_id").distinct().count()
    elapsed = time.time() - t0

    metrics = {
        "rows_in": n_rows,
        "distinct_problems": n_problems,
        "mastery_rows": n_mastery,
        "learners": n_learners,
        "concepts_observed": n_concepts,
        "cores": a.cores,
        "wall_clock_s": round(elapsed, 1),
        "rows_per_second": round(n_rows / elapsed, 1),
        "silver_stage_s": round(t_silver - t0, 1),
        "half_life_days": a.half_life_days,
        "reference_timestamp": ref_ts,
        # Phase 3 asserts on these two. feature_window_end proves this warehouse
        # cannot see post-cutoff data; salt_sha256 proves learner_id is comparable
        # against the other warehouse, because a differing salt would silently
        # change every id and make every cross-warehouse join return fewer rows.
        "feature_window_end": a.max_created_at,
        "salt_sha256": hashlib.sha256(a.salt.encode()).hexdigest()[:16],
        "input_globs": globs,
        "catalog_problems": n_catalog,
        "output": out,
    }
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "run_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print("\n=== PHASE 2 METRICS ===")
    for k, v in metrics.items():
        print(f"{k:24s} {v}")
    spark.stop()


if __name__ == "__main__":
    main()
