-- GRAIN: each model must have exactly one row per key it claims to describe.
--
-- A duplicated grain is the join bug that survives every other test here. Counts stay positive,
-- nulls stay absent, ranges stay valid, and every downstream average is silently weighted by however
-- many times a key was duplicated. It is exactly how the popularity baseline in docs/METRICS.md came
-- to be inflated 3.4x.
SELECT 'cohort_retention' AS model,
       CONCAT_WS(' | ', CAST(first_seen_week AS STRING), CAST(week_offset AS STRING)) AS key_value,
       COUNT(*) AS rows_for_key
FROM cohort_retention
GROUP BY first_seen_week, week_offset
HAVING COUNT(*) > 1

UNION ALL
SELECT 'learner_funnel', stage, COUNT(*)
FROM learner_funnel GROUP BY stage HAVING COUNT(*) > 1

UNION ALL
SELECT 'error_taxonomy_shift',
       CONCAT_WS(' | ', CAST(month AS STRING), error_bucket), COUNT(*)
FROM error_taxonomy_shift GROUP BY month, error_bucket HAVING COUNT(*) > 1

UNION ALL
SELECT 'concept_time_to_mastery', concept_id, COUNT(*)
FROM concept_time_to_mastery GROUP BY concept_id HAVING COUNT(*) > 1

UNION ALL
-- The self-join uses a.concept_id < b.concept_id specifically so each unordered pair appears once.
-- If both orderings appear, that predicate was weakened to <> and every pair is double counted.
SELECT 'concept_cofailure_pairs',
       CONCAT_WS(' | ', concept_a, concept_b), COUNT(*)
FROM concept_cofailure_pairs GROUP BY concept_a, concept_b HAVING COUNT(*) > 1

UNION ALL
SELECT 'concept_cofailure_pairs',
       CONCAT('unordered pair appears in both directions: ', concept_a, ' / ', concept_b), COUNT(*)
FROM concept_cofailure_pairs a
WHERE EXISTS (SELECT 1 FROM concept_cofailure_pairs b
              WHERE b.concept_a = a.concept_b AND b.concept_b = a.concept_a)
GROUP BY concept_a, concept_b
