"""The three seeders must read content from the loader, not from the `*_content.py` scripts.

Without this, the switch silently reverts the first time someone re-adds a convenient import, and
the symptom is subtle: newly authored YAML items simply never appear, while everything that was
already in the scripts keeps working. Nothing errors.

These import the seeder modules rather than grepping them, so a reference that only resolves at
runtime — the `len(PROBLEMS)` in the success-path print that was missed on the first switch — still
counts as a failure here.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))

SEEDERS = ("seed_problems", "seed_papers", "seed_interviews")


@pytest.mark.parametrize("name", SEEDERS)
def test_seeder_imports_the_loader(name: str) -> None:
    src = (ROOT / "apps" / "api" / "scripts" / f"{name}.py").read_text(encoding="utf-8")
    assert "from features.content import" in src, f"{name} does not use the loader"


@pytest.mark.parametrize("name", SEEDERS)
def test_seeder_does_not_import_content_scripts(name: str) -> None:
    """`interview_content` is still imported by seed_interviews for COMPANIES / DOMAINS / KINDS,
    which are validation vocabularies rather than content. Content imports are what must go."""
    src = (ROOT / "apps" / "api" / "scripts" / f"{name}.py").read_text(encoding="utf-8")
    banned = ("import PROBLEMS", "import PAPERS", "import INTERVIEW_PROBLEMS",
              "from scripts.problem_content import", "from scripts.paper_content import",
              "from scripts.interview_problems import")
    offenders = [b for b in banned if b in src]
    assert offenders == [], f"{name} still imports content directly: {offenders}"


def test_seeders_import_without_error() -> None:
    """Catches runtime-only stale references. The first switch left `len(PROBLEMS)` in the final
    print — a NameError on the success path, i.e. the one line that runs only when the seed
    worked, which no amount of dry-running the failure cases would surface."""
    import importlib

    for name in SEEDERS:
        importlib.import_module(f"scripts.{name}")


def test_seeders_see_every_item_of_their_kind() -> None:
    """Counts, so a routing mistake shows up as a number rather than as a missing question."""
    import importlib

    from features.content import for_seeder

    sp = importlib.import_module("scripts.seed_problems")
    pa = importlib.import_module("scripts.seed_papers")
    iv = importlib.import_module("scripts.seed_interviews")

    # EQUALITY IS THE INVARIANT; the numbers are only a floor.
    #
    # What can actually break is routing — an item landing in the wrong seeder, or in none — and
    # that shows up as the two sides disagreeing, whatever the total. These were exact literals
    # (3 / 38 / 38) and adopting two unmigrated interview questions broke the test while the
    # catalog was more complete than before. A test that fails when content is added trains
    # people to edit the number, which is how it stops catching the routing bug it exists for.
    #
    # Floors still catch silent loss: a seeder suddenly seeing fewer items than the catalog once
    # held is a regression regardless of what has been added since.
    assert len(pa.PAPERS) == len(for_seeder("paper")) >= 3
    assert len(iv.INTERVIEW_QUESTIONS) == len(for_seeder("interview_question")) >= 38
    assert len(iv.INTERVIEW_PROBLEMS) == len(for_seeder("interview_problem")) >= 38
    # seed_problems calls for_seeder inline rather than binding a module-level name.
    assert len(for_seeder("problem")) >= 60, "authored items are not reaching the problem seeder"
    assert "for_seeder" in sp.__dict__ or "for_seeder" in dir(sp)


def test_authored_items_reach_the_seeder() -> None:
    """The point of the whole migration: a new YAML file is served without touching Python.

    If this fails, authoring has been quietly disconnected from the product, which is the exact
    failure the five-script sprawl caused and this work exists to end.
    """
    from features.content import for_seeder

    slugs = {r["slug"] for r in for_seeder("problem")}
    for authored in ("zero-stage-memory-arithmetic", "optimizer-moment-dtype-trap",
                     "dead-group-rate-grpo"):
        assert authored in slugs, f"{authored} is not reaching seed_problems"


def test_for_seeder_strips_against_the_models_actual_columns() -> None:
    """Derived, not listed — because the listed version rotted.

    The first version named four "invented" fields. A later migration added `reference_solution`
    to the YAML, it was not on the list, and it reached `Problem(**row)` as a TypeError on the
    first real seed. The test that was supposed to catch that compared against the model's columns
    *at the time it was written*, so it passed and kept passing while the data grew past it.

    Asserting against `Problem.__table__.columns` live means a field added tomorrow is covered
    without anyone remembering to update this.
    """
    from src.models import Problem

    from features.content import for_seeder

    allowed = {c.name for c in Problem.__table__.columns} | {"test_cases", "code_templates"}
    for row in for_seeder("problem", allowed=allowed):
        leaked = row.keys() - allowed
        assert not leaked, f"{row['slug']} leaks {sorted(leaked)} to the ORM"


def test_for_seeder_strips_nothing_without_an_allowed_set() -> None:
    """The default must keep every field: `verify_problems` reads whole rows, and a loader that
    silently dropped `reference_solution` there would report every problem as unverifiable."""
    from features.content import for_seeder

    rows = for_seeder("problem")
    assert any("reference_solution" in r for r in rows)


def test_the_concept_join_is_written_at_seed_time() -> None:
    """A tag that is not persisted is a tag ranking cannot see.

    The table existing is not the same as the table being populated — an empty `problem_concepts`
    looks installed and answers every query with nothing, which is indistinguishable from "no
    problem teaches this concept" and would read as a content gap rather than a wiring bug.
    """
    import importlib
    import inspect

    src = inspect.getsource(importlib.import_module("scripts.seed_problems").seed)
    assert "ProblemConcept(" in src, "seed_problems does not write the taxonomy join"
    assert "concepts_by_slug()" in src, "seed_problems does not read the tags"


def test_every_tag_the_seeder_would_write_is_a_real_concept() -> None:
    """concept_id is a plain string, not a foreign key — see the model docstring. Referential
    integrity therefore lives at load time, so it has to be asserted rather than assumed."""
    import yaml

    from features.content import concepts_by_slug

    valid = {c["id"] for c in
             yaml.safe_load((ROOT / "data" / "concepts.yaml").read_text(encoding="utf-8"))["concepts"]}
    bad = {slug: [c for c in ids if c not in valid]
           for slug, ids in concepts_by_slug().items()
           if any(c not in valid for c in ids)}
    assert bad == {}, f"tags naming concepts the taxonomy does not define: {bad}"


def test_problem_concept_model_guards_against_double_counting() -> None:
    """A duplicated (problem, concept) pair would weight one problem twice in mastery
    attribution, quietly skewing the learner estimate it feeds."""
    from src.models import ProblemConcept

    names = {c.name for c in ProblemConcept.__table__.constraints if c.name}
    assert "uq_problem_concept" in names


def test_the_verifier_skips_rubric_items_rather_than_failing_them() -> None:
    """Regression. Adding rubric grading broke verify_problems: it demands a reference solution
    for every problem, and rubric items correctly have none, so it reported "no reference
    solution" — a true statement about a false expectation.

    It also asserted order_index was contiguous 1..len(PROBLEMS) across ALL problems, which stops
    being true the moment any item is excluded from that list.
    """
    src = (ROOT / "apps" / "api" / "scripts" / "verify_problems.py").read_text(encoding="utf-8")
    assert 'grading", "tests") != "rubric"' in src, "verifier does not exclude rubric items"

    from features.content import by_kind

    everything = by_kind("problem")
    executable = [p for p in everything if p.get("grading", "tests") != "rubric"]
    assert len(executable) < len(everything), "no rubric items present to exercise the split"
    for p in executable:
        assert p.get("reference_solution"), f"{p['slug']} is test-graded but has no reference"
