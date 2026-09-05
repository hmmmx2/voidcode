-- Cohort retention by week of first activity. Spec 4.1a, model 1 of 6.
--
-- THE COHORT IS FIRST-OBSERVED WEEK, NOT SIGNUP WEEK. THIS IS A REDEFINITION.
-- The spec asks for "cohort retention by signup week". The corpus has NO signup date: these are
-- Codeforces submission histories, so the earliest timestamp for a learner is their first observed
-- attempt, which is not when they joined. Someone active for two years before the ingest window
-- lands in a "cohort" that has nothing to do with when they started.
--
-- So this reports retention by first-OBSERVED week and the column is named first_seen_week to keep
-- that visible. Presenting it as signup-week retention would report a quantity that does not exist
-- in the data. The SHAPE is meaningful within the ingest window; the LEVEL is not a joining-cohort
-- number and must not be quoted as one.
--
-- Technique: CTE chain plus a window function (FIRST_VALUE) to carry each cohort's week-0 size
-- across its own rows, which turns counts into rates without a self-join.
WITH learner_first AS (
    SELECT learner_id,
           MIN(first_attempt_at) AS first_seen_epoch
    FROM gold_learner_problem
    GROUP BY learner_id
),
cohort AS (
    SELECT learner_id,
           DATE_TRUNC('WEEK', TIMESTAMP_SECONDS(first_seen_epoch)) AS first_seen_week
    FROM learner_first
),
activity AS (
    -- One row per learner per active week. Grouped so a learner with 40 attempts in a week counts
    -- once rather than 40 times.
    SELECT learner_id,
           DATE_TRUNC('WEEK', TIMESTAMP_SECONDS(first_attempt_at)) AS active_week
    FROM gold_learner_problem
    GROUP BY learner_id, DATE_TRUNC('WEEK', TIMESTAMP_SECONDS(first_attempt_at))
),
offsets AS (
    SELECT c.first_seen_week,
           a.learner_id,
           CAST(DATEDIFF(a.active_week, c.first_seen_week) / 7 AS INT) AS week_offset
    FROM cohort c
    JOIN activity a ON a.learner_id = c.learner_id
),
counted AS (
    SELECT first_seen_week,
           week_offset,
           COUNT(DISTINCT learner_id) AS active_learners
    FROM offsets
    WHERE week_offset >= 0
    GROUP BY first_seen_week, week_offset
)
SELECT first_seen_week,
       week_offset,
       active_learners,
       FIRST_VALUE(active_learners) OVER (
           PARTITION BY first_seen_week ORDER BY week_offset
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS cohort_size,
       ROUND(active_learners / FIRST_VALUE(active_learners) OVER (
           PARTITION BY first_seen_week ORDER BY week_offset
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ), 6) AS retention_rate
FROM counted
ORDER BY first_seen_week, week_offset
