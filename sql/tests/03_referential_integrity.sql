-- REFERENTIAL INTEGRITY: every concept a model names must exist in the taxonomy.
--
-- Catches the failure that produced docs/TAG_REVIEW.md's worst finding: a concept id that no longer
-- exists in data/concepts.yaml, still tagged on problems, silently carrying mastery weight. A model
-- that reports on a concept the taxonomy has never heard of is reporting on nothing, and it does it
-- with a plausible-looking row.
--
-- The ROLLUP placeholders in concept_difficulty_ranking are excluded by name: they are subtotal
-- labels, not concept ids, and requiring them to resolve would fail the model's own design.
SELECT 'concept_difficulty_ranking' AS model, concept_id, 'concept not in gold_concepts' AS violation
FROM concept_difficulty_ranking m
WHERE m.concept_id NOT IN ('(all concepts)')
  AND m.category  NOT IN ('(all categories)')
  AND NOT EXISTS (SELECT 1 FROM gold_concepts g WHERE g.id = m.concept_id)

UNION ALL
SELECT 'concept_time_to_mastery', concept_id, 'concept not in gold_concepts'
FROM concept_time_to_mastery m
WHERE NOT EXISTS (SELECT 1 FROM gold_concepts g WHERE g.id = m.concept_id)

UNION ALL
SELECT 'concept_cofailure_pairs', concept_a, 'concept_a not in gold_concepts'
FROM concept_cofailure_pairs m
WHERE NOT EXISTS (SELECT 1 FROM gold_concepts g WHERE g.id = m.concept_a)

UNION ALL
SELECT 'concept_cofailure_pairs', concept_b, 'concept_b not in gold_concepts'
FROM concept_cofailure_pairs m
WHERE NOT EXISTS (SELECT 1 FROM gold_concepts g WHERE g.id = m.concept_b)
