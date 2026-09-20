"""Every validation rule in the loader, proven to fire.

A validator nobody has watched reject something is a validator nobody knows works — a lesson this
project has now paid for twice. `test_taxonomy.py::test_a_cycle_is_rejected` originally passed on
the *concept-count* check and never reached the acyclicity assertion it claimed to test.

So each test here asserts the specific message, not merely that `ContentError` was raised. Type
alone cannot distinguish "rejected the thing I meant" from "rejected for an unrelated reason".
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.content import ContentError, coverage, load_items

VALID = {
    "slug": "implement-rmsnorm",
    "title": "Implement RMSNorm",
    "difficulty": "medium",
    "categories": ["DL"],
    "concepts": ["normalization_layers", "numerical_stability"],
    "description": "Implement RMSNorm without materialising the mean.",
}


def write(tmp_path: Path, raw: dict, name: str | None = None) -> Path:
    path = tmp_path / f"{name or raw.get('slug', 'item')}.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    return path


def test_a_valid_item_loads(tmp_path: Path) -> None:
    write(tmp_path, VALID)
    items = load_items(tmp_path)
    assert len(items) == 1
    assert items[0].concepts == ["normalization_layers", "numerical_stability"]


def test_an_unknown_concept_is_rejected(tmp_path: Path) -> None:
    """The join this loader exists to enforce. A typo'd concept silently drops the item out of
    ranking and course assembly, which is invisible until someone asks why a topic never appears.
    """
    write(tmp_path, {**VALID, "concepts": ["normalisation_layers"]})   # British spelling typo
    with pytest.raises(ContentError, match="not in the taxonomy"):
        load_items(tmp_path)


def test_missing_concepts_is_rejected(tmp_path: Path) -> None:
    """Optional joins are empty joins. The audit criticises the Spark pipeline for exactly this."""
    raw = {k: v for k, v in VALID.items() if k != "concepts"}
    write(tmp_path, raw)
    with pytest.raises(ContentError, match="missing required field 'concepts'"):
        load_items(tmp_path)


def test_too_many_concepts_is_rejected(tmp_path: Path) -> None:
    """An item tagged with everything is tagged with nothing: mastery attribution divides credit
    across concepts, so scattergun tagging quietly corrupts every vector that touches it."""
    write(tmp_path, {**VALID, "concepts": [
        "normalization_layers", "numerical_stability", "linear_layers",
        "activations", "backpropagation"]})
    with pytest.raises(ContentError, match="exceeds max_concepts_per_problem"):
        load_items(tmp_path)


def test_duplicate_slugs_are_rejected(tmp_path: Path) -> None:
    """How the five-script sprawl produced two quality tiers of the same problem, with whichever
    loaded last silently winning."""
    write(tmp_path, VALID)
    write(tmp_path, VALID, name="duplicate-of-rmsnorm")
    with pytest.raises(ContentError, match=r"already defined by|does not match filename"):
        load_items(tmp_path)


def test_slug_must_match_filename(tmp_path: Path) -> None:
    write(tmp_path, {**VALID, "slug": "something-else"}, name="implement-rmsnorm")
    with pytest.raises(ContentError, match="does not match filename"):
        load_items(tmp_path)


def test_unknown_difficulty_is_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**VALID, "difficulty": "extreme"})
    with pytest.raises(ContentError, match="difficulty"):
        load_items(tmp_path)


def test_unknown_category_is_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**VALID, "categories": ["Quantum"]})
    with pytest.raises(ContentError, match="unknown categories"):
        load_items(tmp_path)


def test_a_bad_item_fails_the_whole_load(tmp_path: Path) -> None:
    """Not skipped. A loader that skips silently shrinks the catalog, and the item count is exactly
    what nobody could establish before this module existed."""
    write(tmp_path, VALID)
    write(tmp_path, {**VALID, "slug": "broken", "concepts": ["nope"]}, name="broken")
    with pytest.raises(ContentError):
        load_items(tmp_path)


def test_coverage_inverts_items_into_the_concept_join(tmp_path: Path) -> None:
    """The real join, replacing the slug-token heuristic in scripts/audit_catalog_coverage.py."""
    write(tmp_path, VALID)
    write(tmp_path, {**VALID, "slug": "implement-layernorm",
                     "concepts": ["normalization_layers"]}, name="implement-layernorm")
    cov = coverage(load_items(tmp_path))
    assert sorted(cov["normalization_layers"]) == ["implement-layernorm", "implement-rmsnorm"]
    assert cov["numerical_stability"] == ["implement-rmsnorm"]


# ── execution contract ────────────────────────────────────────────────────────────────────────
# Every rule below is one broken while authoring the first three items by hand. None was caught by
# review or by the other tests here — all four surfaced from running verify_problems, one KeyError
# at a time. Each test is a mutation: it proves the rule fires, not merely that it exists.

RUNNABLE = {
    **VALID,
    "reference_solution": "class Solution(object):\n    def f(self):\n        return 1\n",
    "code_templates": [{
        "language": "Python", "judge0_language_id": 71,
        "template_code": "class Solution(object):\n    def f(self):\n        pass\n",
        "driver_code": "print(Solution().f())\n",
    }],
    "test_cases": [
        {"stdin": "", "expected_output": "1", "order_index": 0, "is_hidden": False},
        {"stdin": "", "expected_output": "1", "order_index": 1, "is_hidden": True},
    ],
}


def test_a_runnable_item_loads(tmp_path: Path) -> None:
    write(tmp_path, RUNNABLE)
    assert len(load_items(tmp_path)) == 1


def test_dict_shaped_code_templates_is_rejected(tmp_path: Path) -> None:
    """The exact shape I authored. Judge0 cannot execute it, and nothing downstream would say so —
    it would present as every submission failing."""
    write(tmp_path, {**RUNNABLE, "code_templates": {"python": "def f(): ..."}})
    with pytest.raises(ContentError, match="must be a LIST"):
        load_items(tmp_path)


def test_a_template_without_driver_code_is_rejected(tmp_path: Path) -> None:
    """Without a driver, Judge0 runs a file that defines a class and does nothing. Empty output
    reads as a wrong answer, not as a broken problem."""
    t = dict(RUNNABLE["code_templates"][0])
    t.pop("driver_code")
    write(tmp_path, {**RUNNABLE, "code_templates": [t]})
    with pytest.raises(ContentError, match="driver_code"):
        load_items(tmp_path)


def test_test_cases_without_a_reference_solution_are_rejected(tmp_path: Path) -> None:
    """Three of the eight cases in the first item I authored had wrong expected values, found only
    by executing the reference. Without one there is nothing to execute."""
    raw = {k: v for k, v in RUNNABLE.items() if k != "reference_solution"}
    write(tmp_path, raw)
    with pytest.raises(ContentError, match="cannot be verified"):
        load_items(tmp_path)


def test_an_import_judge0_cannot_satisfy_is_rejected(tmp_path: Path) -> None:
    """`numpy` runs on the local interpreter and does not exist in Judge0's `python:3` image.

    So the reference verifies green and the learner's identical submission errors in the grader —
    the worst place to discover it, because nothing in the authoring loop touches the sandbox. The
    check was previously in `verify_interview_problems.py` and covered 38 of 200 items; here it
    covers all of them, and CI's "the shipped catalogue loads" step reaches it.
    """
    write(tmp_path, {**RUNNABLE,
                     "reference_solution": "import numpy as np\n\n\ndef f():\n    return np.pi\n"})
    with pytest.raises(ContentError, match="does not ship"):
        load_items(tmp_path)


def test_the_driver_and_template_are_checked_too(tmp_path: Path) -> None:
    """The reference is not the only source Judge0 executes: it runs `reference + driver`, and the
    learner runs `their code + driver`. A banned import in the driver breaks every submission."""
    bad = [{**RUNNABLE["code_templates"][0], "driver_code": "import torch\nprint(Solution().f())\n"}]
    write(tmp_path, {**RUNNABLE, "code_templates": bad})
    with pytest.raises(ContentError, match="does not ship"):
        load_items(tmp_path)


def test_saying_no_numpy_in_the_description_is_not_an_import(tmp_path: Path) -> None:
    """THE FALSE POSITIVE THE AST WALK EXISTS TO AVOID, AND IT IS NOT HYPOTHETICAL.

    Every executable item in the catalogue carries the constraint "Standard library only -- no
    numpy, no torch" in its own description. A substring scan for `numpy` would reject all 125 of
    them, which is how a check that looks stricter ends up being deleted instead of fixed.
    """
    write(tmp_path, {**RUNNABLE,
                     "description": "Standard library only -- no numpy, no torch, no scipy.",
                     "constraints": ["Do not import numpy."]})
    assert len(load_items(tmp_path)) == 1


LADDERED = {
    **VALID,
    "description": "Compute a numerically stable softmax over the logits.",
    "hint_ladder": {
        "level_0": "What happens to the output when one logit is far larger than the rest?",
        "level_1": "Look at how you build the exponentials. What is the largest value going in?",
        "level_2": "Line 4 calls exp on the raw logit, which overflows for large inputs.",
        "level_3": "Subtract the row maximum before exponentiating.",
    },
}


def test_a_valid_hint_ladder_loads(tmp_path: Path) -> None:
    write(tmp_path, LADDERED)
    assert len(load_items(tmp_path)) == 1


def test_a_rung_that_gives_away_the_fix_is_rejected(tmp_path: Path) -> None:
    """The whole point of authoring ladders: the tutor selects a rung instead of composing one, so
    rung 0 not containing a fix has to be a fact about the data rather than a hope about the
    author. Levels 2 and 3 are allowed to say it — that is what they are for."""
    bad = {**LADDERED, "hint_ladder": {**LADDERED["hint_ladder"],
                                       "level_0": "Subtract max(logits) instead of the raw value."}}
    write(tmp_path, bad)
    with pytest.raises(ContentError, match="discloses the fix too early"):
        load_items(tmp_path)


def test_a_list_shaped_ladder_is_rejected(tmp_path: Path) -> None:
    """A list is the shape `hints` already has, and it is precisely the shape that cannot be
    validated: nothing in it says which entry is rung 0."""
    write(tmp_path, {**LADDERED, "hint_ladder": ["a", "b", "c", "d"]})
    with pytest.raises(ContentError, match="must be a mapping"):
        load_items(tmp_path)


def test_an_unknown_rung_is_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**LADDERED, "hint_ladder": {"level_0": "Why?", "level_4": "here it is"}})
    with pytest.raises(ContentError, match="unknown rungs"):
        load_items(tmp_path)


def test_hints_and_the_ladder_may_not_disagree(tmp_path: Path) -> None:
    """Two fields holding the same text is how drift starts, and this repo has the scar.

    `hints` is an ORM column the API serves; `hint_ladder` is loader-only and stripped at the seeder
    boundary, so nothing downstream would notice them diverging — the learner would read one and the
    tutor select from the other. the website's `mock-data.ts` is the cautionary case: a second
    copy of one problem's hints drifted until it carried Two Sum's text under a softmax title, and
    nothing failed.
    """
    ladder = LADDERED["hint_ladder"]
    write(tmp_path, {**LADDERED, "hints": [ladder["level_0"], ladder["level_1"], "something else"]})
    with pytest.raises(ContentError, match="hints and hint_ladder disagree"):
        load_items(tmp_path)


def test_hints_matching_the_first_three_rungs_is_the_migrated_shape(tmp_path: Path) -> None:
    """96 of the 119 authored items were migrated by copying `hints` into rungs 0-2, so the agreed
    case has to load — otherwise the rule above would reject the entire catalogue."""
    ladder = LADDERED["hint_ladder"]
    write(tmp_path, {**LADDERED,
                     "hints": [ladder["level_0"], ladder["level_1"], ladder["level_2"]]})
    assert len(load_items(tmp_path)) == 1


def test_the_ladder_and_misconceptions_never_reach_the_orm(tmp_path: Path) -> None:
    """Rungs 2 and 3 name the line and state the fix, and a misconception's distractor is a wrong
    answer written to look right. `Problem` has no column for any of it, so `Problem(**row)` would
    raise on the unexpected keyword — but relying on a TypeError to enforce a disclosure boundary
    is relying on an accident. They are stripped explicitly."""
    from features.content import LOADER_METADATA, for_seeder

    assert "hint_ladder" in LOADER_METADATA
    assert "misconceptions" in LOADER_METADATA
    write(tmp_path, {**LADDERED, "source_kind": "problem",
                     "misconceptions": [{"id": "naive-softmax", "distractor": "exp(x)/sum(exp(x))"}]})
    rows = for_seeder("problem", tmp_path, allowed={"slug", "title", "description"})
    assert rows and "hint_ladder" not in rows[0] and "misconceptions" not in rows[0]


def test_old_input_output_field_names_are_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**RUNNABLE, "test_cases": [
        {"input": "", "output": "1", "order_index": 0}]})
    with pytest.raises(ContentError, match="stdin/expected_output"):
        load_items(tmp_path)


def test_non_contiguous_case_order_index_is_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**RUNNABLE, "test_cases": [
        {"stdin": "", "expected_output": "1", "order_index": 0},
        {"stdin": "", "expected_output": "1", "order_index": 7}]})
    with pytest.raises(ContentError, match="no gaps"):
        load_items(tmp_path)


def test_non_executable_items_are_still_allowed(tmp_path: Path) -> None:
    """41 items — interview questions and papers — carry no code_templates and are not runnable.
    Applying the contract universally would reject them, so it applies only where an item claims
    to be executable."""
    write(tmp_path, VALID)
    assert len(load_items(tmp_path)) == 1


# ── rubric-graded items ───────────────────────────────────────────────────────────────────────
# CUDA kernels cannot be executed (V5 descoped the GPU sandbox — untrusted device code is a
# materially harder problem than the CPU one) and ML systems design has no automatic verification
# at any point. Without this item type those topics either do not exist, or get forced into an
# arithmetic question *about* the topic, which tests the maths around occupancy rather than whether
# the learner can reason about occupancy.

RUBRIC_ITEM = {
    **VALID,
    "slug": "design-something",
    "grading": "rubric",
    "rubric": [{"criterion": "identifies the bottleneck", "weight": 0.6},
               {"criterion": "reaches a defensible verdict", "weight": 0.4}],
}


def test_a_rubric_item_loads(tmp_path: Path) -> None:
    write(tmp_path, RUBRIC_ITEM)
    assert len(load_items(tmp_path)) == 1


def test_a_rubric_item_needs_a_rubric(tmp_path: Path) -> None:
    """Otherwise it cannot be graded at all, and presents as an unanswerable question rather than
    a broken one."""
    raw = {k: v for k, v in RUBRIC_ITEM.items() if k != "rubric"}
    write(tmp_path, raw)
    with pytest.raises(ContentError, match="no rubric criteria"):
        load_items(tmp_path)


def test_rubric_weights_must_sum_to_one(tmp_path: Path) -> None:
    """Otherwise scores are incomparable between items: 0.8 on a rubric summing to 2.0 is worse
    than 0.6 on one summing to 0.7, and no aggregate can tell."""
    write(tmp_path, {**RUBRIC_ITEM, "rubric": [
        {"criterion": "a", "weight": 0.6}, {"criterion": "b", "weight": 0.6}]})
    with pytest.raises(ContentError, match=r"must be 1\.0"):
        load_items(tmp_path)


def test_a_rubric_criterion_needs_both_fields(tmp_path: Path) -> None:
    write(tmp_path, {**RUBRIC_ITEM, "rubric": [{"criterion": "a"}]})
    with pytest.raises(ContentError, match="missing"):
        load_items(tmp_path)


def test_a_rubric_item_may_not_also_carry_tests(tmp_path: Path) -> None:
    """Carrying both means two answers to 'was this correct' and no rule for which wins."""
    write(tmp_path, {**RUBRIC_ITEM, "test_cases": [
        {"stdin": "", "expected_output": "1", "order_index": 0}]})
    with pytest.raises(ContentError, match="must not carry"):
        load_items(tmp_path)


def test_an_unknown_grading_mode_is_rejected(tmp_path: Path) -> None:
    write(tmp_path, {**RUBRIC_ITEM, "grading": "vibes"})
    with pytest.raises(ContentError, match="grading"):
        load_items(tmp_path)


def test_the_execution_contract_still_applies_to_test_graded_items(tmp_path: Path) -> None:
    """Adding a second mode must not weaken the first. A dict-shaped code_templates was the bug
    that started all of this and must still be refused."""
    write(tmp_path, {**RUNNABLE, "code_templates": {"python": "def f(): ..."}})
    with pytest.raises(ContentError, match="must be a LIST"):
        load_items(tmp_path)
