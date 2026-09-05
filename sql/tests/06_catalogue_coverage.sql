-- CATALOGUE COVERAGE: every attempted problem must exist in the complete catalogue.
--
-- This is the SQL-layer guard on the fault features/backfill_catalog.py fixed. The Codeforces
-- `problemset.problems` endpoint returned a truncated list, so 906 problems that learners had
-- actually attempted were missing from gold_problem_catalog — 28,285 learner-problem rows, skewed to
-- later contest indices. Any join from attempts to the catalogue silently DROPPED those rows, and
-- dropping the harder tail of a catalogue biases every difficulty and popularity statistic downward
-- without emptying a single table.
--
-- quality/contracts.py already asserts this in Python. It is asserted again here because the SQL
-- layer is a separate consumer with its own registration step, and the recovered table was in fact
-- unregistered in the Hive metastore — the rows existed on disk and were invisible to every SQL and
-- HiveQL query. A test that lives only in the Python contracts cannot catch a missing registration,
-- because it never goes through the metastore.
--
-- If this fails with a "table not found" error rather than rows, run `make hive-register`: the
-- registration, not the data, is what is missing.
WITH attempted AS (
    SELECT DISTINCT problem_id
    FROM gold_learner_problem
)
SELECT 'gold_learner_problem -> gold_problem_catalog_complete' AS relation,
       a.problem_id,
       'attempted problem absent from the complete catalogue' AS violation
FROM attempted a
WHERE NOT EXISTS (
    SELECT 1 FROM gold_problem_catalog_complete c WHERE c.problem_id = a.problem_id
)

UNION ALL

-- The complete catalogue must be a strict SUPERSET of the original, not a replacement for it. If a
-- problem is in the Spark-written table and missing from the recovered one, the backfill dropped rows
-- while appearing to add them — and the assertion above would still pass.
SELECT 'gold_problem_catalog -> gold_problem_catalog_complete',
       o.problem_id,
       'present in the original catalogue but missing from the complete one'
FROM gold_problem_catalog o
WHERE NOT EXISTS (
    SELECT 1 FROM gold_problem_catalog_complete c WHERE c.problem_id = o.problem_id
)

UNION ALL

-- Provenance must survive. Every row carries catalog_source so a consumer can tell a fetched row from
-- a reconstructed one; a null there makes the two indistinguishable, which is how a reconstructed
-- rating ends up quoted as an observed one.
SELECT 'gold_problem_catalog_complete.catalog_source',
       problem_id,
       'null provenance on a catalogue row'
FROM gold_problem_catalog_complete
WHERE catalog_source IS NULL
