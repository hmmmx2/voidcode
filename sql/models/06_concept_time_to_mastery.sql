-- Time-to-first-solve percentiles per concept, with the zero-elapsed share stated first. Model 6.
--
-- THE MEDIAN IS 0 BY CONSTRUCTION AND THAT IS NOT A BUG. time_to_accept_s runs from a learner's
-- FIRST attempt on a problem to the accepted submission. A problem solved on the first submission has
-- zero elapsed time, and most solved problems are solved on the first submission, so p50 is 0 for
-- most concepts.
--
-- That is why zero_elapsed_share is the first measure on every row rather than a footnote. A
-- percentile table without it reads as "learners master this concept instantly", when what actually
-- happened is that the clock never started.
--
-- NEVER DESCRIBE THIS AS TIME SPENT THINKING. It is wall-clock between two submissions, so it
-- includes sleep, work, and abandoning a tab for a week. The upper percentiles are dominated by
-- learners who came back days later, which is why p99 is reported and never averaged.
--
-- "Time to mastery" in the spec's sense -- time to reach competence AT A CONCEPT -- is not derivable
-- here: mastery is a continuous score with no crossing event, so there is no interval to measure.
-- This reports time to first accepted solution per concept, the closest quantity the data supports,
-- and every column name says so.
--
-- Technique: CTE plus percentile_approx over a probability ARRAY, so the whole curve comes from one
-- pass rather than four scans.
WITH solved AS (
    SELECT pc.concept_id,
           lp.time_to_accept_s
    FROM gold_learner_problem lp
    JOIN gold_problem_concepts pc ON pc.problem_id = lp.problem_id
    WHERE lp.solved = 1
      AND lp.time_to_accept_s IS NOT NULL
      AND lp.time_to_accept_s >= 0
),
curve AS (
    SELECT concept_id,
           COUNT(*) AS n_solves,
           SUM(CASE WHEN time_to_accept_s = 0 THEN 1 ELSE 0 END) AS zero_elapsed_solves,
           percentile_approx(time_to_accept_s, ARRAY(0.5D, 0.75D, 0.9D, 0.99D), 10000) AS pct
    FROM solved
    GROUP BY concept_id
    HAVING COUNT(*) >= 30
)
SELECT c.concept_id,
       g.category,
       c.n_solves,
       ROUND(c.zero_elapsed_solves / c.n_solves, 6) AS zero_elapsed_share,
       CAST(c.pct[0] AS BIGINT) AS p50_seconds_to_first_accept,
       CAST(c.pct[1] AS BIGINT) AS p75_seconds_to_first_accept,
       CAST(c.pct[2] AS BIGINT) AS p90_seconds_to_first_accept,
       CAST(c.pct[3] AS BIGINT) AS p99_seconds_to_first_accept
FROM curve c
JOIN gold_concepts g ON g.id = c.concept_id
ORDER BY zero_elapsed_share DESC, c.n_solves DESC
