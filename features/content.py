"""One file per catalog item, loaded and validated in one place.

WHY THIS EXISTS
----------------
Catalog content currently lives in five separate `apps/api/scripts/*_content.py` modules as Python
dict literals. Two consequences, both already paid for:

  * **Nobody could say how many problems existed.** Establishing "91" needed a regex sweep across
    every script, and the project audit had recorded "five easy DSA problems" — wrong by a factor
    of eighteen, and wrong for long enough that a four-to-eight-week authoring plan was written on
    top of it.
  * **No problem is tagged with a taxonomy concept.** There is no `problem_concepts` join table and
    no `concept_id` anywhere in the models. Spec §4.2 asks for one to four concepts per item and
    calls the taxonomy "the backbone of both ranking and course generation" — that backbone is
    currently attached to nothing.

So this module does two jobs: collapse the sprawl, and **make the concept join mandatory at load
time**. An item with an unknown or missing concept fails to load. A join that is optional is a join
that is empty, which is precisely the state the Spark pipeline is criticised for in the audit.

WHY YAML PER FILE RATHER THAN ONE BIG FILE
--------------------------------------------
Reviewability. A wrong reference solution on an interview-prep platform is worse than a missing
question, so items must be reviewed individually in pull requests. A single 91-item file produces
diffs nobody reads, and Python dict literals cannot be reviewed by a non-engineer at all — which
matters because authoring is the one part of this project that is not engineering.
"""
from __future__ import annotations

import ast
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .ladder import LADDER_KEYS, check_ladder
from .taxonomy import load_taxonomy

CONTENT_ROOT = Path(__file__).resolve().parents[1] / "content" / "problems"

REQUIRED = ("slug", "title", "difficulty", "categories", "concepts", "description")
DIFFICULTIES = {"easy", "medium", "hard"}
#: The five areas the revised plan names. `categories` is the coarse, learner-facing grouping;
#: `concepts` is the fine taxonomy join. Both exist because they answer different questions —
#: "what section is this in" and "what does it teach".
CATEGORIES = {"ML", "DL", "LLM", "VLM", "CUDA", "PyTorch", "TensorFlow", "Systems"}


class ContentError(Exception):
    """Raised on any invalid item. Loudly, and naming the file — a content error that degrades to
    a warning becomes a silently missing problem, and nobody notices a question that was never
    served."""


@dataclass(frozen=True)
class Item:
    slug: str
    title: str
    difficulty: str
    categories: list[str]
    concepts: list[str]
    description: str
    source: Path
    extras: dict[str, Any] = field(default_factory=dict)


#: What an executable item's code_templates entry must carry. `driver_code` is the piece that
#: reads stdin and calls into the learner's class; without it Judge0 runs a file that defines a
#: class and does nothing, producing empty output that reads as a wrong answer.
TEMPLATE_KEYS = ("language", "judge0_language_id", "template_code", "driver_code")
#: What a test case must carry. Named `stdin`/`expected_output`, not `input`/`output`.
CASE_KEYS = ("stdin", "expected_output", "order_index")


#: How an item is graded. `tests` is the default and covers everything executable; `rubric` is for
#: content that cannot be auto-graded at all.
#:
#: Two kinds of item need this, and the plan names both. CUDA kernels cannot be executed because
#: V5 descoped the GPU sandbox — untrusted device code is a materially harder problem than the CPU
#: sandbox, and grading it by execution is not on the table. ML systems design has no automatic
#: verification at any point: "how would you shard a 70B across 8 cards" has better and worse
#: answers, not passing and failing ones.
#:
#: Without this, those items either do not exist or get forced into an arithmetic question *about*
#: the topic rather than the topic — which tests the maths around kernel occupancy instead of
#: whether the learner can reason about occupancy.
GRADING_MODES = ("tests", "rubric")
RUBRIC_KEYS = ("criterion", "weight")


def _validate_rubric(raw: dict, path: Path) -> None:
    """A rubric item is graded by a human or a judge, so its rubric IS its correctness contract.

    Held to the same standard as test cases for the same reason: an item whose rubric is vague
    grades inconsistently, and inconsistent grading on an interview-prep platform is worse than no
    grading, because the learner cannot tell which of their answers was actually wrong.
    """
    rubric = raw.get("rubric")
    if not rubric or not isinstance(rubric, list):
        raise ContentError(
            f"{path.name}: grading is 'rubric' but no rubric criteria are defined. A rubric item "
            "without a rubric cannot be graded at all, and would present as an unanswerable "
            "question rather than as a broken one.")

    total = 0.0
    for i, c in enumerate(rubric):
        if not isinstance(c, dict):
            raise ContentError(f"{path.name}: rubric entry {i} is not a mapping")
        missing = [k for k in RUBRIC_KEYS if c.get(k) in (None, "")]
        if missing:
            raise ContentError(f"{path.name}: rubric entry {i} missing {missing}")
        try:
            total += float(c["weight"])
        except (TypeError, ValueError):
            raise ContentError(
                f"{path.name}: rubric entry {i} has non-numeric weight {c['weight']!r}") from None

    # Weights must sum to 1. Anything else makes scores incomparable across items — an answer
    # scoring 0.8 on a rubric summing to 2.0 is worse than one scoring 0.6 on a rubric summing to
    # 0.7, and no downstream aggregate can tell.
    if abs(total - 1.0) > 1e-6:
        raise ContentError(
            f"{path.name}: rubric weights sum to {total}, must be 1.0 — otherwise scores are not "
            "comparable between items and any aggregate over them is meaningless.")

    for forbidden in ("test_cases", "code_templates", "reference_solution"):
        if raw.get(forbidden):
            raise ContentError(
                f"{path.name}: rubric-graded item must not carry {forbidden!r}. If it is "
                "executable, grade it with tests; carrying both means two answers to 'was this "
                "correct' and no rule for which wins.")


def _validate_execution_contract(raw: dict, path: Path) -> None:
    """Reject items that cannot execute, at load rather than at verify.

    Every rule here is one I broke while authoring the first three items by hand, and none was
    caught by review or by the unit tests — all four surfaced only from running
    `verify_problems`, one KeyError at a time. Encoding them means the next author gets a sentence
    naming the problem instead of a stack trace three layers down.

    Deliberately conditional: 41 items (interview questions, papers) carry no `code_templates` and
    are not executable. Requiring templates universally would reject them, so the contract applies
    only where the item claims to be runnable.
    """
    templates = raw.get("code_templates")
    if templates is not None:
        if not isinstance(templates, list):
            raise ContentError(
                f"{path.name}: code_templates must be a LIST of template objects, got "
                f"{type(templates).__name__}. A dict of language -> source is the shape I first "
                "wrote and Judge0 cannot execute it.")
        for t in templates:
            missing = [k for k in TEMPLATE_KEYS if not t.get(k)]
            if missing:
                raise ContentError(f"{path.name}: code_template missing {missing}")

    cases = raw.get("test_cases")
    if cases:
        if not raw.get("reference_solution"):
            # Without one, nothing can confirm the expectations are even satisfiable. Three of the
            # eight cases in the first item I authored had wrong expected values, and only
            # executing the reference against them found it.
            raise ContentError(
                f"{path.name}: has test_cases but no reference_solution, so its expected outputs "
                "cannot be verified. An unverifiable expectation tells a learner their correct "
                "answer is wrong.")
        for i, c in enumerate(cases):
            missing = [k for k in CASE_KEYS if k not in c]
            if missing:
                raise ContentError(
                    f"{path.name}: test case {i} missing {missing} "
                    "(fields are stdin/expected_output/order_index, not input/output)")
        orders = sorted(c["order_index"] for c in cases)
        if orders != list(range(len(cases))):
            raise ContentError(
                f"{path.name}: test case order_index must be 0..{len(cases) - 1} with no gaps, "
                f"got {orders}")

    for where, source in _executable_sources(raw):
        banned = _banned_imports(source)
        if banned:
            raise ContentError(
                f"{path.name}: {where} imports {sorted(set(banned))}, which Judge0's python:3 image "
                "does not ship. It runs locally and fails for the learner, which is the worst place "
                "to find out — the reference verifies green and the same code errors in the grader.")


#: Judge0's `python:3` image is the standard library and nothing else. An item importing any of
#: these passes `verify_problems` on the local interpreter and dies in the sandbox the learner
#: actually hits, so the check has to sit where the local runner cannot flatter it.
BANNED_IMPORTS = frozenset({
    "numpy", "np", "torch", "sklearn", "scipy", "pandas", "tensorflow",
    "jax", "cupy", "numba", "matplotlib",
})


def _executable_sources(raw: dict) -> list[tuple[str, str]]:
    """Every field whose contents Judge0 will be asked to run."""
    out = [("reference_solution", raw["reference_solution"])] if raw.get("reference_solution") else []
    for t in raw.get("code_templates") or []:
        out += [(k, t[k]) for k in ("template_code", "driver_code") if t.get(k)]
    return out


def _banned_imports(source: str) -> list[str]:
    """Imports of packages the sandbox lacks. AST, not a substring scan.

    A regex on `import numpy` matches the word inside a docstring or a constraint line -- and every
    one of these items says "Standard library only -- no numpy, no torch" in its description, so a
    textual check would reject the entire catalogue.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # Not this validator's business. `verify_problems` executes the source and reports it far
        # more usefully than a parse error raised during a bulk load would.
        return []
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [a.name.split(".")[0] for a in node.names
                      if a.name.split(".")[0] in BANNED_IMPORTS]
        elif isinstance(node, ast.ImportFrom) and node.module:
            root = node.module.split(".")[0]
            if root in BANNED_IMPORTS:
                found.append(root)
    return found


def _validate_hint_ladder(raw: dict, path: Path) -> None:
    """Rungs 0 and 1 must not contain the fix, checked rather than requested.

    THIS IS THE MECHANISM THE DISCLOSURE GATE NEEDS, MOVED TO AUTHORING TIME. The tutor's reasoning
    reaches "corrected code" in 0.218 of debug traces against a 0.98 gate, and every remedy tried so
    far has attempted to stop a 9B model from deriving a fix once it has located a bug — which is
    the same act. With an authored ladder the tutor SELECTS a rung instead of composing one, and
    rungs 0 and 1 cannot contain a fix because this function refused to load them if they did.

    Optional, and absent rungs are not violations: 119 items carry a flat `hints` list and are
    migrated incrementally. The loader fails the whole tree on one bad file, so a half-migrated
    catalogue has to stay loadable.

    The item's own description and prompt are passed as vocabulary. A term the question defines
    cannot be a disclosure — see `features/ladder.py` for why that exemption is not a loophole, and
    why operators are never covered by it.
    """
    ladder = raw.get("hint_ladder")
    if not ladder:
        return
    if not isinstance(ladder, dict):
        raise ContentError(
            f"{path.name}: hint_ladder must be a mapping of level_0..level_3, got "
            f"{type(ladder).__name__}. A list has no rung semantics, which is the shape `hints` "
            "already has and the reason it cannot be validated.")
    unknown = sorted(set(ladder) - set(LADDER_KEYS))
    if unknown:
        raise ContentError(f"{path.name}: hint_ladder has unknown rungs {unknown}, "
                           f"expected any of {list(LADDER_KEYS)}")

    vocabulary = " ".join(str(raw.get(k, "")) for k in ("description", "prompt", "constraints"))
    found = check_ladder(ladder, vocabulary)
    if found:
        raise ContentError(
            f"{path.name}: hint_ladder discloses the fix too early — "
            + "; ".join(str(v) for v in found[:3]))

    # TWO FIELDS HOLDING THE SAME TEXT IS HOW DRIFT STARTS, so they are not allowed to disagree.
    # `hints` is an ORM column the API serves; `hint_ladder` is loader-only and stripped at the
    # seeder boundary, so nothing downstream would notice them diverging. `apps/web`'s mock-data.ts
    # is the cautionary case: a second copy of one problem's hints drifted until it was carrying
    # Two Sum's text under the softmax title, and nothing failed.
    hints = raw.get("hints")
    if hints:
        rungs = [ladder.get(k) for k in LADDER_KEYS[:3]]
        if all(rungs) and list(hints[:3]) != rungs:
            raise ContentError(
                f"{path.name}: hints and hint_ladder disagree. `hints` is what the API serves and "
                "the ladder is what the tutor selects from, so a learner would see one and the "
                "tutor use the other. Edit the ladder and mirror it into hints.")


def _validate(raw: dict, path: Path, concept_ids: set[str], max_concepts: int) -> Item:
    for key in REQUIRED:
        if not raw.get(key):
            raise ContentError(f"{path.name}: missing required field {key!r}")

    if raw["difficulty"] not in DIFFICULTIES:
        raise ContentError(
            f"{path.name}: difficulty {raw['difficulty']!r} not in {sorted(DIFFICULTIES)}")

    unknown_cats = set(raw["categories"]) - CATEGORIES
    if unknown_cats:
        raise ContentError(f"{path.name}: unknown categories {sorted(unknown_cats)}")

    concepts = raw["concepts"]
    if len(concepts) > max_concepts:
        # The cap is the taxonomy's own `max_concepts_per_problem`. An item tagged with everything
        # is tagged with nothing: mastery attribution divides credit across concepts, so a
        # scattergun tagging quietly corrupts every mastery vector that touches it.
        raise ContentError(
            f"{path.name}: {len(concepts)} concepts exceeds max_concepts_per_problem "
            f"({max_concepts})")

    unknown = [c for c in concepts if c not in concept_ids]
    if unknown:
        raise ContentError(
            f"{path.name}: concepts {unknown} are not in the taxonomy. "
            "Add them to data/concepts.yaml or correct the tag — a typo here silently drops the "
            "item out of ranking and course assembly.")

    grading = raw.get("grading", "tests")
    if grading not in GRADING_MODES:
        raise ContentError(f"{path.name}: grading {grading!r} not in {list(GRADING_MODES)}")
    if grading == "rubric":
        _validate_rubric(raw, path)
    else:
        _validate_execution_contract(raw, path)

    _validate_hint_ladder(raw, path)

    known = set(REQUIRED)
    return Item(
        slug=raw["slug"], title=raw["title"], difficulty=raw["difficulty"],
        categories=list(raw["categories"]), concepts=list(concepts),
        description=raw["description"], source=path,
        extras={k: v for k, v in raw.items() if k not in known},
    )


def load_items(root: Path | None = None) -> list[Item]:
    """Load and validate every item. Raises `ContentError` on the first invalid one.

    Fails the whole load rather than skipping bad files. A loader that skips is a loader that
    silently shrinks the catalog, and the count is exactly what nobody could establish before.
    """
    root = root or CONTENT_ROOT
    if not root.exists():
        return []

    taxonomy = load_taxonomy()
    concept_ids = set(taxonomy.concepts)      # Taxonomy.concepts is dict[str, Concept]
    max_concepts = taxonomy.max_concepts_per_problem

    items: list[Item] = []
    seen: dict[str, Path] = {}
    for path in sorted(root.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ContentError(f"{path.name}: expected a mapping at the top level")
        item = _validate(raw, path, concept_ids, max_concepts)

        if item.slug in seen:
            # Duplicate slugs are how the five-script sprawl produced two quality tiers of the
            # same problem, with whichever loaded last silently winning.
            raise ContentError(
                f"{path.name}: slug {item.slug!r} already defined by {seen[item.slug].name}")
        seen[item.slug] = path
        if item.slug != path.stem:
            raise ContentError(
                f"{path.name}: slug {item.slug!r} does not match filename. Keeping them equal is "
                "what makes an item findable from a ranking result without a lookup table.")
        items.append(item)
    return items


def load_raw(root: Path | None = None) -> dict[str, dict[str, Any]]:
    """Slug -> the item's full mapping, exactly as the source scripts held it.

    The migration bridge. Nothing under `apps/api/src` imports the content scripts — they are
    seed-time only, consumed by `seed_interviews.py`, `seed_papers.py` and `seed_problems.py`. So
    switching to this loader is a one-line import change in each seeder, *provided* the shape is
    identical. `tests/test_content_migration_fidelity.py` is what makes that provable rather than
    hoped for.

    Deliberately returns raw mappings rather than `Item`. A seeder needs `test_cases`,
    `code_templates` and `order_index`, none of which belong on the validated dataclass, and
    forcing them through it would mean either widening `Item` with fields it does not own or
    dropping them again — which is exactly the bug that cost 50 problems their grading.

    Still validates: this calls `load_items` first, so an item with a bad concept tag fails here
    too. A bridge that skips validation is just the old scripts with extra steps.
    """
    root = root or CONTENT_ROOT
    valid_slugs = {item.slug for item in load_items(root)}
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(root.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if raw.get("slug") in valid_slugs:
            out[raw["slug"]] = raw
    return out


def by_kind(kind: str, root: Path | None = None) -> list[dict[str, Any]]:
    """Items from one source, in `order_index` order where present.

    Each seeder wants its own subset — `seed_interviews` the interview problems and questions,
    `seed_problems` the problems, `seed_papers` the papers. `kind` records which script an item
    came from, rather than inferring it from a slug prefix: a prefix guess mis-routes the first
    item whose naming drifts, and a mis-routed item is seeded into the wrong table or not at all.

    Sorted by `order_index` because the seeders relied on source list order, which a directory
    glob does not preserve. Items without one sort last, stably by slug.
    """
    rows = [r for r in load_raw(root).values() if r.get("source_kind") == kind]
    return sorted(rows, key=lambda r: (r.get("order_index") is None,
                                       r.get("order_index", 0), r["slug"]))


#: Fields this loader adds that the ORM models know nothing about. The seeders do
#: `Problem(**problem_data)`, so leaving these in raises TypeError on unexpected keyword.
#:
#: `kind` is deliberately NOT here. interview_content.py items carry their own `kind`
#: ("derivation" / "computation" / "code") and it is real content — stripping it would repeat the
#: bug that made this field `source_kind` in the first place.
#: `hint_ladder` and `misconceptions` are here for a second reason as well as the TypeError.
#: Rungs 2 and 3 name the line and state the fix; a misconception's `distractor` is a wrong answer
#: written to look right. None of it may reach the client, and the API has no field for it, so the
#: safest place for that guarantee is the boundary that already strips loader-only keys. See
#: `Problem` in apps/api/src/models/problem.py — there is deliberately no column to serve them from.
LOADER_METADATA = ("concepts", "source_kind", "inferred_concepts", "review_needed",
                   "hint_ladder", "misconceptions")


def for_seeder(kind: str, root: Path | None = None,
               allowed: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """`by_kind`, restricted to keys the target ORM model accepts.

    The seeders construct `Model(**row)` directly, so any key the model does not declare raises on
    unexpected keyword. `allowed` should be the model's own columns — derived, not listed.

    **A hardcoded strip-list was the first design and it rotted within a day.** It named four
    invented fields; `reference_solution` was added to the YAML by a later migration, was not on
    the list, and reached `Problem(**row)` as a TypeError on the first real seed. The test that was
    supposed to catch this compared against the model's columns *at the time it was written*, so it
    passed and kept passing while the data grew past it.

    Passing `allowed` also fixes a second-order bug the list could not: papers legitimately carry
    `arxiv_id` and `authors`, interview questions carry `companies` and `domain`. A single global
    strip-list either rejects those or lets `Problem` fields through — it cannot be right for every
    model at once.

    With `allowed=None` nothing is stripped, which is the correct default for callers like
    `verify_problems` that want the whole row.
    """
    out = []
    for row in by_kind(kind, root):
        clean = {k: v for k, v in row.items() if allowed is None or k in allowed}
        # test_cases / code_templates get popped and re-attached by the seeders; copy the
        # containers so a mutation cannot reach back into another caller's data.
        for nested in ("test_cases", "code_templates", "examples", "hints"):
            if isinstance(clean.get(nested), list):
                clean[nested] = [dict(x) if isinstance(x, dict) else x for x in clean[nested]]
            elif isinstance(clean.get(nested), dict):
                clean[nested] = dict(clean[nested])
        out.append(clean)
    return out


def concepts_by_slug(root: Path | None = None) -> dict[str, list[str]]:
    """Slug -> its concept ids.

    A separate lookup rather than leaving `concepts` on the seeder rows, because the seeders do
    `Problem(**row)` and would raise on it. Weakening the strip to accommodate one caller would
    reintroduce that failure for every other field this loader might add later; a second function
    costs nothing and keeps the ORM boundary clean.
    """
    return {slug: list(row.get("concepts") or []) for slug, row in load_raw(root).items()}


def coverage(items: list[Item] | None = None) -> dict[str, list[str]]:
    """Concept id -> slugs teaching it. The real join, replacing the slug-token heuristic in
    `scripts/audit_catalog_coverage.py` once content has migrated."""
    items = items if items is not None else load_items()
    out: dict[str, list[str]] = {}
    for item in items:
        for cid in item.concepts:
            out.setdefault(cid, []).append(item.slug)
    return out
