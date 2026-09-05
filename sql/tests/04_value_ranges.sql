-- VALUE RANGES: quantities that are probabilities, rates or counts must be in range.
--
-- This is the assertion that catches an arithmetic error rather than a plumbing error, and it is the
-- one this project most needs. Every serious fault found in this work produced a PLAUSIBLE NUMBER
-- rather than an exception: a ranking result that was 94% tie-breaking artefact, a popularity
-- baseline inflated 3.4x by a leak, a calibration map that made MCE twice as bad while recording an
-- improvement. None of those raised. A rate above 1 or a negative count is the cheapest possible
-- tripwire for that whole class.
SELECT 'cohort_retention' AS model, 'retention_rate outside (0, 1]' AS violation,
       CAST(retention_rate AS STRING) AS value
FROM cohort_retention
WHERE retention_rate <= 0 OR retention_rate > 1

UNION ALL
-- Week 0 is the cohort definition, so its retention is 1 by construction. If it is not, FIRST_VALUE
-- is reading the wrong frame and every rate in the model is wrong by the same factor.
SELECT 'cohort_retention', 'week_offset 0 retention is not exactly 1', CAST(retention_rate AS STRING)
FROM cohort_retention
WHERE week_offset = 0 AND retention_rate <> 1

UNION ALL
SELECT 'cohort_retention', 'active_learners exceeds cohort_size',
       CONCAT(CAST(active_learners AS STRING), ' > ', CAST(cohort_size AS STRING))
FROM cohort_retention
WHERE active_learners > cohort_size

UNION ALL
SELECT 'concept_difficulty_ranking', 'confidence interval inverted',
       CONCAT(CAST(min_ci_lower AS STRING), ' > ', CAST(max_ci_upper AS STRING))
FROM concept_difficulty_ranking
WHERE min_ci_lower > max_ci_upper

UNION ALL
-- The evidence filter in the model is ABS(beta) <= 10. A mean outside that means it leaked.
SELECT 'concept_difficulty_ranking', 'mean_beta outside the evidence filter',
       CAST(mean_beta AS STRING)
FROM concept_difficulty_ranking
WHERE ABS(mean_beta) > 10

UNION ALL
-- A funnel whose steps grow is not a funnel: each nested stage is a subset of the one above. THIS
-- ASSERTION HAS ALREADY EARNED ITS KEEP -- it caught a "persisted" stage that was not a superset of
-- solved_any, converting at 1.205, after the model had passed row counts, null rates, referential
-- integrity and grain uniqueness. See sql/models/03_learner_funnel.sql.
SELECT 'learner_funnel', 'step_conversion above 1 -- stages are not nested',
       CONCAT(stage, ' ', CAST(step_conversion AS STRING))
FROM learner_funnel
WHERE is_nested_stage AND step_conversion > 1

UNION ALL
-- The other half of that fix: a row that does NOT nest must not carry a conversion at all. Without
-- this, restoring a non-nested stage would pass simply by producing a ratio below 1.
SELECT 'learner_funnel', 'non-nested row has a step_conversion',
       CONCAT(stage, ' ', CAST(step_conversion AS STRING))
FROM learner_funnel
WHERE NOT is_nested_stage AND step_conversion IS NOT NULL

UNION ALL
-- Every nested stage except the first must have a predecessor. A NULL here means stage_order was
-- renumbered and LAG is reaching across a gap.
SELECT 'learner_funnel', 'nested stage missing its predecessor', stage
FROM learner_funnel
WHERE is_nested_stage AND stage_order > 1 AND previous_stage_learners IS NULL

UNION ALL
SELECT 'error_taxonomy_shift', 'share outside (0, 1]', CAST(share AS STRING)
FROM error_taxonomy_shift
WHERE share <= 0 OR share > 1

UNION ALL
SELECT 'concept_cofailure_pairs', 'failing_both exceeds learners_with_both',
       CONCAT(CAST(failing_both AS STRING), ' > ', CAST(learners_with_both AS STRING))
FROM concept_cofailure_pairs
WHERE failing_both > learners_with_both

UNION ALL
SELECT 'concept_cofailure_pairs', 'conditional probability above 1',
       CAST(p_fail_b_given_fail_a AS STRING)
FROM concept_cofailure_pairs
WHERE p_fail_b_given_fail_a > 1 OR p_fail_a_given_fail_b > 1

UNION ALL
SELECT 'concept_time_to_mastery', 'zero_elapsed_share outside [0, 1]',
       CAST(zero_elapsed_share AS STRING)
FROM concept_time_to_mastery
WHERE zero_elapsed_share < 0 OR zero_elapsed_share > 1

UNION ALL
-- Percentiles must not decrease. percentile_approx is approximate, so a genuine inversion here means
-- the array indices were transposed, not that the estimator drifted.
SELECT 'concept_time_to_mastery', 'percentiles not monotone',
       CONCAT_WS(' ', CAST(p50_seconds_to_first_accept AS STRING),
                      CAST(p75_seconds_to_first_accept AS STRING),
                      CAST(p90_seconds_to_first_accept AS STRING),
                      CAST(p99_seconds_to_first_accept AS STRING))
FROM concept_time_to_mastery
WHERE p50_seconds_to_first_accept > p75_seconds_to_first_accept
   OR p75_seconds_to_first_accept > p90_seconds_to_first_accept
   OR p90_seconds_to_first_accept > p99_seconds_to_first_accept
