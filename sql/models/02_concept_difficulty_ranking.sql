-- Concept difficulty with confidence bounds, rolled up the category hierarchy. Model 2 of 6.
--
-- Difficulty comes from the Rasch betas in gold_problem_difficulty, averaged over the problems
-- tagged with each concept.
--
-- TWO EVIDENCE FILTERS, BOTH DELIBERATE:
--   n_observations >= 7   matches quality/contracts.MIN_OBSERVATIONS_FOR_BETA. A beta estimated
--                         from fewer outcomes is not an estimate.
--   ABS(beta) <= 10       excludes the 482 problems whose fit did not converge. Including them
--                         moves a concept mean by more than its own confidence interval, so the
--                         ranking would be reporting non-convergence as difficulty.
--
-- The interval is a normal approximation over the SPREAD OF PROBLEM BETAS within a concept, not a
-- propagation of each beta's own standard error. It answers "how consistently hard are this
-- concept's problems", which is what a ranking needs. It is not a posterior on a single item, and
-- concepts with one usable problem are dropped rather than handed a zero-width interval.
--
-- Technique: GROUP BY ROLLUP over (category, concept) with GROUPING_ID to label the level, so
-- per-concept rows, category subtotals and the grand total come from one pass. RANK() in the CTE.
WITH problem_beta AS (
    SELECT pc.concept_id,
           d.difficulty_beta
    FROM gold_problem_concepts pc
    JOIN gold_problem_difficulty d ON d.problem_id = pc.problem_id
    WHERE d.n_observations >= 7
      AND ABS(d.difficulty_beta) <= 10
),
by_concept AS (
    SELECT concept_id,
           COUNT(*) AS n_problems,
           AVG(difficulty_beta) AS mean_beta,
           STDDEV_SAMP(difficulty_beta) AS sd_beta
    FROM problem_beta
    GROUP BY concept_id
    HAVING COUNT(*) >= 2
),
ranked AS (
    SELECT b.concept_id,
           c.category,
           b.n_problems,
           b.mean_beta,
           b.mean_beta - 1.96 * b.sd_beta / SQRT(b.n_problems) AS ci_lower,
           b.mean_beta + 1.96 * b.sd_beta / SQRT(b.n_problems) AS ci_upper,
           RANK() OVER (ORDER BY b.mean_beta DESC) AS difficulty_rank
    FROM by_concept b
    JOIN gold_concepts c ON c.id = b.concept_id
)
SELECT COALESCE(category, '(all categories)') AS category,
       COALESCE(concept_id, '(all concepts)') AS concept_id,
       GROUPING_ID(category, concept_id) AS rollup_level,
       COUNT(*) AS concepts_in_group,
       SUM(n_problems) AS problems_in_group,
       ROUND(AVG(mean_beta), 6) AS mean_beta,
       ROUND(MIN(ci_lower), 6) AS min_ci_lower,
       ROUND(MAX(ci_upper), 6) AS max_ci_upper,
       MIN(difficulty_rank) AS hardest_rank_in_group
FROM ranked
GROUP BY ROLLUP (category, concept_id)
ORDER BY rollup_level, category, mean_beta DESC
