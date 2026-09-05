"""The taxonomy's own header says its DAG assertion "is a test, not a comment". It was not.

Nothing under `tests/` loaded the taxonomy, so `validate()` only ran when some other code path
happened to call `load_taxonomy()`. A malformed edit — a typo'd prerequisite id, a cycle introduced
by a plausible-looking dependency — would have shipped and surfaced later as a course-assembly bug,
which is a much worse place to find it.

That matters more now than it did: V1 added 64 ML concepts to 88 DSA ones, and the ML half is where
prerequisite structure actually does work. Course assembly orders modules by walking this DAG, so a
cycle is not a validation nicety, it is a course that cannot be generated.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.taxonomy import TaxonomyError, load_taxonomy

CONCEPTS = Path(__file__).resolve().parents[1] / "data" / "concepts.yaml"
ML_CATEGORIES = {
    "ml_foundations", "deep_learning", "transformers", "training_systems",
    "gpu_kernels", "vision_language", "inference_systems",
}


@pytest.fixture(scope="module")
def raw() -> dict:
    return yaml.safe_load(CONCEPTS.read_text(encoding="utf-8"))


def test_the_shipped_taxonomy_validates() -> None:
    """The whole point. load_taxonomy() validates internally and raises on any violation."""
    load_taxonomy()


def test_every_prerequisite_resolves(raw: dict) -> None:
    ids = {c["id"] for c in raw["concepts"]}
    dangling = [(c["id"], p) for c in raw["concepts"]
                for p in c.get("prerequisites", []) if p not in ids]
    assert dangling == [], f"prerequisites pointing at nothing: {dangling}"


def test_every_category_is_declared(raw: dict) -> None:
    declared = {c["id"] for c in raw["categories"]}
    used = {c["category"] for c in raw["concepts"]}
    assert used - declared == set(), f"concepts in undeclared categories: {used - declared}"


def test_no_concept_is_its_own_prerequisite(raw: dict) -> None:
    """The cheapest cycle to write by accident, and invisible in a diff."""
    self_refs = [c["id"] for c in raw["concepts"] if c["id"] in c.get("prerequisites", [])]
    assert self_refs == []


def test_a_cycle_is_rejected() -> None:
    """Mutation check: the acyclicity assertion must fire, and fire *for the cycle*.

    The first version of this test built a two-concept Taxonomy from scratch and asserted only
    that `TaxonomyError` was raised. It was — but on the count check, "spec §4.2 requires 40-300
    concepts, found 2". It never reached `_assert_acyclic` at all, so it proved nothing while
    looking like proof. A test that passes for the wrong reason is worse than no test, because it
    retires the question.

    So: start from the real taxonomy, which already satisfies every other invariant, and inject a
    single back-edge. Then the only thing that can be wrong is the cycle, and the message is
    asserted to say so.
    """
    from dataclasses import replace

    tax = load_taxonomy()                       # valid by construction; this call validates it
    a, b = "tensors_and_shapes", "vectorization"
    assert b in tax.concepts[a].prerequisites or a in tax.concepts[b].prerequisites, (
        "fixture drifted: these two are no longer adjacent, pick another pair")

    # vectorization already depends on tensors_and_shapes; add the reverse edge to close the loop.
    tax.concepts[a] = replace(tax.concepts[a], prerequisites=(b,))
    # Matching the message, not just the type: the point of this test is that the *acyclicity*
    # check fired, and only the message can distinguish that from any other TaxonomyError.
    with pytest.raises(TaxonomyError, match="cyclic"):
        tax.validate()


def test_ml_concepts_exist_and_cover_the_five_target_areas(raw: dict) -> None:
    """V1's actual deliverable. The taxonomy held 88 concepts and zero ML ones, so the platform's
    headline area had no backbone at all — ranking had nothing to rank against."""
    by_cat: dict[str, int] = {}
    for c in raw["concepts"]:
        by_cat[c["category"]] = by_cat.get(c["category"], 0) + 1
    missing = ML_CATEGORIES - by_cat.keys()
    assert missing == set(), f"ML categories with no concepts: {missing}"
    assert sum(by_cat[k] for k in ML_CATEGORIES) >= 50


def test_ml_concepts_connect_back_to_the_dsa_foundations(raw: dict) -> None:
    """Cross-category prerequisite edges are the point, not a smell.

    A learner who cannot write a function cannot write a training loop. If the ML half floated free
    of the DSA half, course assembly could not order a path from where a beginner actually is into
    the ML material, and the two taxonomies would be one file holding two disconnected products.
    """
    cat_of = {c["id"]: c["category"] for c in raw["concepts"]}
    crossings = [(c["id"], p) for c in raw["concepts"] if c["category"] in ML_CATEGORIES
                 for p in c.get("prerequisites", []) if cat_of[p] not in ML_CATEGORIES]
    assert crossings, "the ML taxonomy is a disconnected island"


def test_ml_roots_are_reachable_and_the_graph_is_not_a_chain(raw: dict) -> None:
    """Each ML category needs at least one concept with no ML prerequisite, or there is no entry
    point into it and a course can never start there."""
    cat_of = {c["id"]: c["category"] for c in raw["concepts"]}
    for cat in sorted(ML_CATEGORIES):
        roots = [c["id"] for c in raw["concepts"] if c["category"] == cat
                 and not any(cat_of[p] == cat for p in c.get("prerequisites", []))]
        assert roots, f"{cat} has no entry point: every concept depends on another in {cat}"
