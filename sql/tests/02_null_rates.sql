-- NULL RATES on the columns each model's meaning depends on.
--
-- Keys and measures must never be null. A null key means a join silently missed; a null measure
-- means a division produced it and the row will read as "no data" downstream rather than as a bug.
--
-- DELIBERATE EXCEPTIONS, asserted elsewhere rather than here:
--   error_taxonomy_shift.prev_share   NULL in each bucket's first month. That is what LAG does at a
--                                     series boundary, and forcing it to 0 would invent a shift from
--                                     zero on every bucket's debut.
--   cofailure p_fail_* and lift       NULL where the NULLIF guard divided by zero, which is the
--                                     correct answer for a pair where nobody failed the antecedent.
WITH checks AS (
    SELECT 'cohort_retention.first_seen_week' AS column_name, COUNT(*) AS nulls
    FROM cohort_retention WHERE first_seen_week IS NULL
    UNION ALL
    SELECT 'cohort_retention.retention_rate', COUNT(*)
    FROM cohort_retention WHERE retention_rate IS NULL
    UNION ALL
    SELECT 'cohort_retention.cohort_size', COUNT(*)
    FROM cohort_retention WHERE cohort_size IS NULL OR cohort_size = 0
    UNION ALL
    SELECT 'concept_difficulty_ranking.mean_beta', COUNT(*)
    FROM concept_difficulty_ranking WHERE mean_beta IS NULL
    UNION ALL
    SELECT 'concept_difficulty_ranking.rollup_level', COUNT(*)
    FROM concept_difficulty_ranking WHERE rollup_level IS NULL
    UNION ALL
    SELECT 'learner_funnel.learners', COUNT(*)
    FROM learner_funnel WHERE learners IS NULL
    UNION ALL
    SELECT 'error_taxonomy_shift.share', COUNT(*)
    FROM error_taxonomy_shift WHERE share IS NULL
    UNION ALL
    SELECT 'error_taxonomy_shift.error_bucket', COUNT(*)
    FROM error_taxonomy_shift WHERE error_bucket IS NULL
    UNION ALL
    SELECT 'concept_cofailure_pairs.learners_with_both', COUNT(*)
    FROM concept_cofailure_pairs WHERE learners_with_both IS NULL
    UNION ALL
    SELECT 'concept_time_to_mastery.zero_elapsed_share', COUNT(*)
    FROM concept_time_to_mastery WHERE zero_elapsed_share IS NULL
    UNION ALL
    SELECT 'concept_time_to_mastery.p50_seconds_to_first_accept', COUNT(*)
    FROM concept_time_to_mastery WHERE p50_seconds_to_first_accept IS NULL
)
SELECT column_name, nulls, 'unexpected nulls' AS violation
FROM checks
WHERE nulls > 0
