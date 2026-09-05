"""Course assembly, §5.3. The ordering is the property that matters.

A course is a syllabus, not a ranked list. `features/recommend.py` orders by relevance — strongest
evidence of weakness first — and emitting that order as a course teaches `flash_attention` before
`attention_scaled_dot`. Both orders are defensible for their own purpose and only one is a curriculum.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.recommend import Recommendation, Recommendations
from features.taxonomy import get_taxonomy
from ranking.course_builder import (
    FALLBACK_MODEL_ID,
    MAX_MODULE_PROBLEMS,
    assemble,
    explain_modules,
)


def recs(*concepts: str) -> Recommendations:
    return Recommendations(
        items=tuple(Recommendation(problem_slug=f"{c}-p{i}", concept_id=c,
                                   reasons=("weak_concept",), score=None, mastery=0.1)
                    for i, c in enumerate(concepts)),
        ranked_by="mastery", weak_concepts=concepts, cold_start=False)


def test_modules_are_emitted_in_prerequisite_order_not_relevance_order() -> None:
    """THE point of this module. The recommender's order is deliberately not this one."""
    taxonomy = get_taxonomy()
    order = taxonomy.topological_order()
    rank = {c: i for i, c in enumerate(order)}

    # Deliberately handed to `assemble` in REVERSE topological order.
    pair = [c for c in ("autograd", "backpropagation") if c in rank]
    if len(pair) < 2:                                      # taxonomy renamed; nothing to assert
        return
    late_first = sorted(pair, key=lambda c: -rank[c])
    course = assemble(recs(*late_first), taxonomy, {})

    emitted = [m.concept_id for m in course.modules]
    assert emitted == sorted(emitted, key=lambda c: rank[c]), (
        f"modules came out as {emitted}, which is not prerequisite order")


def test_a_module_never_exceeds_the_cap() -> None:
    taxonomy = get_taxonomy()
    concept = taxonomy.topological_order()[0]
    # Twenty candidate problems on one concept, against a cap of eight.
    plenty = {concept: [f"{concept}-extra{i}" for i in range(20)]}
    course = assemble(recs(concept), taxonomy, plenty)
    assert all(len(m.problem_slugs) <= MAX_MODULE_PROBLEMS for m in course.modules)


def test_top_up_never_crosses_concepts() -> None:
    """A short module is honest; a module padded with unrelated problems is a lie the learner cannot
    detect, because the label says one concept and the contents are another."""
    taxonomy = get_taxonomy()
    order = taxonomy.topological_order()
    target, other = order[0], order[1]
    catalogue = {target: [f"{target}-a"], other: [f"{other}-b{i}" for i in range(10)]}

    course = assemble(recs(target), taxonomy, catalogue)
    module = next(m for m in course.modules if m.concept_id == target)
    assert all(other not in slug for slug in module.problem_slugs)


def test_no_problem_appears_twice_in_a_module() -> None:
    taxonomy = get_taxonomy()
    concept = taxonomy.topological_order()[0]
    # The same slug both recommended and present in the catalogue for top-up.
    course = assemble(recs(concept), taxonomy, {concept: [f"{concept}-p0"]})
    slugs = course.modules[0].problem_slugs
    assert len(slugs) == len(set(slugs))


def test_every_module_names_what_generated_its_explanation() -> None:
    """§5.3 asks for the fine-tuned model; D-012 records that its weights are gone, so this is the
    base-model fallback §3 sanctions. An artefact that does not name its generator gets read later as
    fine-tuned output."""
    taxonomy = get_taxonomy()
    course = explain_modules(assemble(recs(taxonomy.topological_order()[0]), taxonomy, {}))
    assert all(m.model_id == FALLBACK_MODEL_ID for m in course.modules)
    assert all(m.explanation for m in course.modules)


def test_the_course_carries_how_it_was_ranked() -> None:
    """A course built from the mastery heuristic is not a personalised course, and the distinction
    has to survive into whatever renders it."""
    taxonomy = get_taxonomy()
    course = assemble(recs(taxonomy.topological_order()[0]), taxonomy, {})
    assert course.ranked_by == "mastery"
    assert "ranked_by=mastery" in course.summary()


def test_the_summary_reports_the_real_size_distribution() -> None:
    """Not a pass/fail against the §5.3 floor. Short modules are the honest output of a catalogue
    with ~2 problems per concept, and padding them to look fuller would invent curriculum."""
    taxonomy = get_taxonomy()
    course = assemble(recs(*taxonomy.topological_order()[:3]), taxonomy, {})
    summary = course.summary()
    assert "module sizes:" in summary
    assert "reaching the §5.3 floor" in summary
