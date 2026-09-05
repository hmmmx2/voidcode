"""Export the concept taxonomy from YAML into the warehouse as queryable tables.

`data/concepts.yaml` is the single source of truth, but it is unreachable from SQL.
Every analytical model that groups by category or walks prerequisites needs the
taxonomy as tables, so this materialises it — as a projection of the YAML, never as
a second source of truth. Rerun after any edit to `data/concepts.yaml`.

Emits:
  gold_concepts               id, name, category, category_name, n_prerequisites, depth
  gold_concept_prereq_edges   concept_id, prereq_id, is_direct

`is_direct` distinguishes the declared edges from the transitive closure. Both are
needed: the prerequisite-graph walk in Phase 3 wants ancestors, while the SQL models
want the direct edges so a self-join does not double count.

    python -m features.spark_jobs.export_taxonomy
"""
from __future__ import annotations

import argparse
import os
import sys

from pyspark.sql import SparkSession

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
from features.taxonomy import load_taxonomy


def main() -> None:
    ap = argparse.ArgumentParser()
    data = os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data"))
    ap.add_argument("--out", default=os.path.join(data, "warehouse"))
    ap.add_argument("--cores", type=int, default=4)
    a = ap.parse_args()

    tax = load_taxonomy()
    order = {c: i for i, c in enumerate(tax.topological_order())}

    concepts = [
        (c.id, c.name, c.category, tax.categories.get(c.category, c.category),
         len(c.prerequisites), len(tax.ancestors(c.id)), order[c.id])
        for c in tax.concepts.values()
    ]
    direct = {(c.id, p) for c in tax.concepts.values() for p in c.prerequisites}
    edges = [(cid, pid, (cid, pid) in direct)
             for cid in tax.concepts
             for pid in tax.ancestors(cid)]

    spark = (SparkSession.builder.appName("voidcode-export-taxonomy")
             .master(f"local[{a.cores}]").getOrCreate())
    spark.sparkContext.setLogLevel("WARN")

    (spark.createDataFrame(
        concepts,
        "id string, name string, category string, category_name string, "
        "n_prerequisites int, n_ancestors int, topological_rank int")
     .write.mode("overwrite").parquet(os.path.join(a.out, "gold_concepts")))

    (spark.createDataFrame(
        edges, "concept_id string, prereq_id string, is_direct boolean")
     .write.mode("overwrite").parquet(os.path.join(a.out, "gold_concept_prereq_edges")))

    print(f"gold_concepts              {len(concepts):>6,} rows")
    print(f"gold_concept_prereq_edges  {len(edges):>6,} rows "
          f"({len(direct):,} direct, {len(edges) - len(direct):,} transitive)")
    spark.stop()


if __name__ == "__main__":
    main()
