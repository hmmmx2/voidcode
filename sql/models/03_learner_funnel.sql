-- Funnel from first attempt to first accepted solution, and beyond it. Model 3 of 6.
--
-- Four stages, each a STRICT SUBSET of the one above, so every step_conversion is a real conversion
-- rather than a ratio between overlapping populations:
--   1 attempted_any    touched at least one problem
--   2 solved_any       got at least one accepted        -- this step is the spec's funnel
--   3 solved_2_plus    solved a second problem
--   4 solved_5_plus    solved five or more
--
-- Steps 3 and 4 extend past "first accepted solution" on purpose: the interesting cliff on this
-- corpus is not whether a learner ever succeeds, it is whether they keep going afterwards.
--
-- "PERSISTED" WAS A STAGE HERE AND WAS WRONG. It counted learners who attempted a second problem, and
-- it sat between attempted_any and solved_any on the assumption that solving implies persisting. It
-- does not: a learner can attempt exactly ONE problem and solve it, so solved_any is not a subset of
-- attempted-two-or-more. The result was a step_conversion of 1.205 -- more learners "converting" into
-- a stage than existed in the one before it. sql/tests/04_value_ranges.sql caught it; the model had
-- already run green through row counts, null rates, referential integrity and grain uniqueness,
-- because a broken funnel is arithmetically valid at every one of those.
--
-- The lesson is in the assertion, not the fix: a funnel's nesting is a CLAIM about set containment,
-- and claims need a test. bounced_without_solving below reports the same signal honestly, as its own
-- measure rather than as a stage, precisely because it is not nested.
--
-- Technique: a CTE per-learner rollup, UNION ALL to lay the stages out as rows, then LAG() over the
-- stage order for step-to-step conversion in a single pass.
WITH per_learner AS (
    SELECT learner_id,
           COUNT(*) AS problems_attempted,
           SUM(solved) AS problems_solved,
           SUM(first_attempt_pass) AS first_try_solves
    FROM gold_learner_problem
    GROUP BY learner_id
),
stages AS (
    SELECT 1 AS stage_order, 'attempted_any' AS stage, COUNT(*) AS learners
    FROM per_learner WHERE problems_attempted >= 1
    UNION ALL
    SELECT 2, 'solved_any', COUNT(*)
    FROM per_learner WHERE problems_solved >= 1
    UNION ALL
    SELECT 3, 'solved_2_plus', COUNT(*)
    FROM per_learner WHERE problems_solved >= 2
    UNION ALL
    SELECT 4, 'solved_5_plus', COUNT(*)
    FROM per_learner WHERE problems_solved >= 5
),
context AS (
    -- NOT funnel stages, and deliberately not in `stages`. Each is a share of attempted_any, so
    -- neither nests into the chain above and neither gets a step_conversion.
    SELECT 5 AS stage_order, 'bounced_without_solving' AS stage, COUNT(*) AS learners
    FROM per_learner WHERE problems_solved = 0
    UNION ALL
    SELECT 6, 'solved_first_try_at_least_once', COUNT(*)
    FROM per_learner WHERE first_try_solves >= 1
)
SELECT s.stage_order,
       s.stage,
       s.learners,
       TRUE AS is_nested_stage,
       LAG(s.learners) OVER (ORDER BY s.stage_order) AS previous_stage_learners,
       ROUND(s.learners / LAG(s.learners) OVER (ORDER BY s.stage_order), 6) AS step_conversion,
       ROUND(s.learners / FIRST_VALUE(s.learners) OVER (
           ORDER BY s.stage_order ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ), 6) AS share_of_top
FROM stages s

UNION ALL

SELECT c.stage_order,
       c.stage,
       c.learners,
       FALSE AS is_nested_stage,
       NULL AS previous_stage_learners,
       -- NULL, not a number: these do not nest, so any conversion computed here would be a ratio
       -- between overlapping sets. That is the exact error this model already made once.
       NULL AS step_conversion,
       ROUND(c.learners / (SELECT learners FROM stages WHERE stage_order = 1), 6) AS share_of_top
FROM context c
ORDER BY stage_order
