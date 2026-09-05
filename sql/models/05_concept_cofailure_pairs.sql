-- Concept co-failure pairs, against what the taxonomy already declares. Model 5 of 6.
--
-- For each unordered concept pair, among learners with real evidence on both: how often does failing
-- one coincide with failing the other, and is that pair already a declared prerequisite edge?
--
-- THESE ARE CORRELATIONS, NOT PREREQUISITES. Two concepts co-fail when they share problems, when
-- they share a harder parent topic, or when the same learners simply reach both late. The
-- is_declared_prereq column exists to keep the two claims visibly separate: an undeclared pair with a
-- high conditional rate is a HYPOTHESIS for review, not a discovered dependency. See
-- docs/CONCEPT_RULES_REVIEW.md, where line_sweep and convex_hull co-occur at lift 132.9 and almost
-- certainly share problems rather than depend on one another.
--
-- Technique: the required SELF-JOIN. gold_learner_concept_mastery joined to itself on learner_id
-- with a.concept_id < b.concept_id, which enumerates each unordered pair exactly once instead of
-- twice; the LEFT JOIN to gold_concept_prereq_edges is the prerequisite-relationship pattern, and it
-- matches in BOTH directions because a co-failure pair is undirected and an edge is not.
WITH evidenced AS (
    -- >= 3 attempts, otherwise pass_rate is 0, 0.5 or 1 and "failing" means one bad submission.
    SELECT learner_id, concept_id, pass_rate
    FROM gold_learner_concept_mastery
    WHERE attempt_count >= 3
),
pairs AS (
    SELECT a.concept_id AS concept_a,
           b.concept_id AS concept_b,
           COUNT(*) AS learners_with_both,
           SUM(CASE WHEN a.pass_rate < 0.5 THEN 1 ELSE 0 END) AS failing_a,
           SUM(CASE WHEN b.pass_rate < 0.5 THEN 1 ELSE 0 END) AS failing_b,
           SUM(CASE WHEN a.pass_rate < 0.5 AND b.pass_rate < 0.5 THEN 1 ELSE 0 END) AS failing_both
    FROM evidenced a
    JOIN evidenced b
      ON a.learner_id = b.learner_id
     AND a.concept_id < b.concept_id
    GROUP BY a.concept_id, b.concept_id
    HAVING COUNT(*) >= 50
)
SELECT p.concept_a,
       p.concept_b,
       p.learners_with_both,
       p.failing_both,
       ROUND(p.failing_both / NULLIF(p.failing_a, 0), 6) AS p_fail_b_given_fail_a,
       ROUND(p.failing_both / NULLIF(p.failing_b, 0), 6) AS p_fail_a_given_fail_b,
       -- Lift against independence. Above 1 means co-failure beyond each concept's own base rate.
       ROUND((p.failing_both / p.learners_with_both)
             / NULLIF((p.failing_a / p.learners_with_both)
                      * (p.failing_b / p.learners_with_both), 0), 6) AS lift,
       MAX(CASE WHEN e.concept_id IS NOT NULL THEN TRUE ELSE FALSE END) AS is_declared_prereq
FROM pairs p
LEFT JOIN gold_concept_prereq_edges e
       ON (e.concept_id = p.concept_b AND e.prereq_id = p.concept_a)
       OR (e.concept_id = p.concept_a AND e.prereq_id = p.concept_b)
GROUP BY p.concept_a, p.concept_b, p.learners_with_both, p.failing_both,
         p.failing_a, p.failing_b
ORDER BY lift DESC
