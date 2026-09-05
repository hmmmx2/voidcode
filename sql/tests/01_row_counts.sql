-- ROW COUNTS. Every model must return a plausible number of rows.
--
-- Catches the silent failure where the SQL is valid, the run is green, and a filter or a join
-- eliminated everything. An empty model reads as a passing model in any pipeline that only checks
-- for errors. sql/run_models.py enforces > 0 separately; this checks the counts are in the range the
-- warehouse can actually support, which catches a join that fanned out as well as one that collapsed.
--
-- Upper bounds are deliberately loose. A tight bound would fail on the next ingest; these are set to
-- catch an order-of-magnitude break, not drift.
WITH counts AS (
    SELECT 'cohort_retention' AS model, COUNT(*) AS n, 100 AS min_expected, 5000000 AS max_expected
    FROM cohort_retention
    UNION ALL
    -- 80 concepts + category subtotals + grand total, so comfortably under 200.
    SELECT 'concept_difficulty_ranking', COUNT(*), 20, 200 FROM concept_difficulty_ranking
    UNION ALL
    -- Exactly 4 nested stages + 2 context rows. Not a range: a seventh row means the UNION ALL
    -- was edited, and an extra stage silently changes every step_conversion below it.
    SELECT 'learner_funnel', COUNT(*), 6, 6 FROM learner_funnel
    UNION ALL
    SELECT 'error_taxonomy_shift', COUNT(*), 5, 100000 FROM error_taxonomy_shift
    UNION ALL
    SELECT 'concept_cofailure_pairs', COUNT(*), 1, 100000 FROM concept_cofailure_pairs
    UNION ALL
    SELECT 'concept_time_to_mastery', COUNT(*), 10, 200 FROM concept_time_to_mastery
)
SELECT model, n, min_expected, max_expected,
       CASE WHEN n < min_expected THEN 'too few rows' ELSE 'too many rows' END AS violation
FROM counts
WHERE n < min_expected OR n > max_expected
