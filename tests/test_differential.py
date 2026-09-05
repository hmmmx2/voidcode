"""Does this grader agree with the ones that came before it?

THE ARGUMENT
------------
A reward function nobody has checked is a reward function that trains a policy toward the wrong
thing, silently, and the reward curve will look fine while it happens. So this grader is not trusted
because it was ported carefully. It is trusted because it agrees with two implementations that were
written by other people, in other languages, on other interpreters.

Three arms, in increasing strength:

1. **Every reference solves its own problem.** Weak on its own — a grader that returns "pass" for
   everything satisfies it — but it catches the whole class of porting failures where a reference does
   not execute at all. The app's own header records four such failures, "every one of them silently
   first".

2. **Against the frozen Judge0 oracle.** The strongest arm, and it costs nothing. Those expectations
   were produced by a *different interpreter on a retired platform*, not by this codebase. If CPython
   here reproduces them, and Pyodide in the app already reproduces them, then three independent
   implementations agree. The oracle covers 204 cases and two documented divergences are excluded by name,
   leaving 202 compared —
   rather than by a tolerance rule, so a third would fail rather than blend in.

3. **The spec fixtures.** For 13 problems the app ships a ``correct`` solution written independently
   of the reference, and mutants each paired with the case id that must reject them. This asserts the
   same three things the app's gate asserts. Agreeing that a *wrong* answer is wrong is worth more
   than agreeing that a right one is right — it is the property a reward function actually needs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reward.grader import answer_key, grade

CATALOGUE = Path(__file__).resolve().parents[1] / "data" / "catalogue.json"


@pytest.fixture(scope="session")
def catalogue() -> dict:
    """Skip rather than fail when the catalogue is absent.

    **The catalogue is the answer key and is deliberately not published.** It carries reference
    solutions and the arguments of all 182 hidden cases, which is the entire value of the 60
    problems as an evaluation set — publishing it would destroy that in one commit.

    So the public repository has no `data/catalogue.json`, and this arm skips there while every
    other test still runs. It skips rather than fails because a stranger cloning the repo has not
    done anything wrong. In a checkout that *should* have it, eight skips instead of eight passes is
    visible enough, and the message says exactly how to regenerate it.
    """
    if not CATALOGUE.exists():
        pytest.skip(
            f"{CATALOGUE} is absent — it is the private answer key. "
            f"Regenerate from the desktop repo with:\n"
            f"  npm run export:catalogue -- <path>/data/catalogue.json"
        )
    return json.loads(CATALOGUE.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def problems(catalogue: dict) -> dict[str, dict]:
    return {p["id"]: p for p in catalogue["problems"]}


def _needs_numpy(problem: dict) -> bool:
    return "numpy" in problem.get("allowedImports", [])


def _skip_if_unavailable(problem: dict) -> None:
    """Skip rather than fail when numpy is absent.

    Only 14 of 60 problems declare numpy, so this suite is meaningful without it — but it must say
    which arm it did not run rather than reporting green over a subset. `test_coverage_is_honest`
    below asserts the skipped count is what we think it is.
    """
    if _needs_numpy(problem):
        pytest.importorskip("numpy", reason=f"{problem['id']} declares numpy")


# ── Arm 0: the export itself ──────────────────────────────────────────────────────────────────


#: sha256 of ``data/catalogue.json`` as bytes.
#:
#: Pinned deliberately. It is the token a training run reports to prove *which* catalogue it graded
#: against, so it must be updated by hand when the catalogue is re-exported on purpose — that edit is
#: the record. A hash that updates itself would prove nothing.
EXPECTED_FILE_SHA256 = "baa73a0cfb17bad43aba5a9d993e4272df9e43489d921a8bfa3393e6082aacc3"


def test_catalogue_file_hash_is_pinned(catalogue: dict) -> None:
    """Pin the file's bytes, not the document's own ``contentHash``.

    The first version of this recomputed the exporter's hash in Python and failed — not because the
    catalogue was wrong, but because **JavaScript and Python serialise floats differently**. The
    exporter hashes ``JSON.stringify(payload)``, where ``1e-5`` becomes ``0.00001``; Python's
    ``json.dumps`` emits ``1e-05`` for the same value. Reproducing the exporter's hash here would mean
    reimplementing ECMAScript number-to-string, for no benefit.

    Hashing the file's bytes is language-neutral and answers the question that actually matters: is
    this the catalogue the run was reported against?

    The document's own ``contentHash`` is still checked for shape below — it is the desktop repo's
    integrity marker, verified there by ``tests/catalogue-export.test.ts``.
    """
    import hashlib

    digest = hashlib.sha256(CATALOGUE.read_bytes()).hexdigest()

    assert catalogue["contentHash"] == catalogue["contentHash"].lower()
    assert len(catalogue["contentHash"]) == 64

    if EXPECTED_FILE_SHA256 == "PIN_ME":
        pytest.skip(
            f"catalogue not pinned yet. Set EXPECTED_FILE_SHA256 = {digest!r} once this export "
            f"is the one you intend to train against."
        )
    assert digest == EXPECTED_FILE_SHA256, (
        "data/catalogue.json is not the pinned export. Re-export deliberately and update "
        "EXPECTED_FILE_SHA256, or restore the pinned file."
    )


def test_counts_are_self_consistent(catalogue: dict) -> None:
    counts = catalogue["counts"]
    problems = catalogue["problems"]
    assert len(problems) == counts["problems"]
    assert sum(len(p["cases"]) for p in problems) == counts["cases"]
    assert sum(1 for p in problems for c in p["cases"] if not c["visible"]) == counts["hidden"]
    # The reward is only non-trivial because most cases are hidden.
    assert counts["hidden"] > counts["visible"]


# ── Arm 1: every reference solves its own problem ─────────────────────────────────────────────


def test_every_reference_executes_and_solves(problems: dict[str, dict]) -> None:
    broken: list[str] = []
    unsolved: list[str] = []
    skipped: list[str] = []

    for problem_id, problem in problems.items():
        if _needs_numpy(problem):
            try:
                import numpy  # noqa: F401
            except ImportError:
                skipped.append(problem_id)
                continue

        key = answer_key(problem)
        if key.outcome != "ran":
            broken.append(f"{problem_id}: {key.outcome} — {key.error}")
            continue

        # A reference must pass its own cases. This is what makes `answer_key` a key at all.
        verdict = grade(problem, problem["reference"], key=key)
        if not verdict.solved:
            unsolved.append(f"{problem_id}: failed {verdict.failed}")

    assert broken == [], "references that did not execute in CPython:\n  " + "\n  ".join(broken)
    assert unsolved == [], "references that did not solve their own problem:\n  " + "\n  ".join(unsolved)
    assert len(problems) - len(skipped) > 40, "too few problems ran for this to mean anything"


# ── Arm 2: against the frozen Judge0 oracle ───────────────────────────────────────────────────


def agrees(derived: str, web: str) -> bool:
    """Legacy-oracle comparison, ported from ``verify-interviews.ts``.

    Deliberately **not** in ``grader.py``. Real grading compares with exact equality, because both
    sides go through this repository's own normalisation and a spelling difference there would be a
    real change hiding as a formatting one. This tolerance exists only because the retired Judge0
    drivers used ``print()`` where we use ``repr()``, and the two are the same text for numbers, lists
    and ``None`` but not for strings.

    Writing this was the finding. The first version of this arm compared with ``==`` and reported 33
    mismatches — every one of which was a spelling difference the app already documents, not a defect
    in the port:

    * ``json.dumps`` normalisers return a *string*, so ``repr`` wraps it in quotes: the oracle has
      ``[40960, 5368709120, 12]`` where we produce ``'[40960, 5368709120, 12]'``.
    * The multi-print driver printed each component of a returned tuple on its own line, so the oracle
      has newline-separated components where we produce a list.
    """
    if derived == web:
        return True
    if derived == json.dumps(web):
        return True
    if derived == f"'{web}'":
        return True

    lines = web.split("\n")
    if len(lines) > 1 and derived.startswith("[") and derived.endswith("]"):
        return derived == "[" + ", ".join(lines) + "]"
    return False


def test_agrees_with_the_judge0_oracle(catalogue: dict, problems: dict[str, dict]) -> None:
    """The load-bearing arm: a different interpreter, on a retired platform, got these values.

    Compared per case id. Only the cases the oracle actually covers are checked — the six items
    authored after the freeze have no entry, which `verify-interviews.ts` in the app requires be
    covered by a spec instead, and arm 3 is where that lands.
    """
    oracle: dict[str, str] = catalogue["oracle"]["key"]
    divergences: dict[str, str] = catalogue["oracle"]["divergences"]

    mismatches: list[str] = []
    checked = 0
    skipped_numpy = 0

    for problem in problems.values():
        if _needs_numpy(problem):
            try:
                import numpy  # noqa: F401
            except ImportError:
                skipped_numpy += sum(1 for c in problem["cases"] if c["id"] in oracle)
                continue

        key = answer_key(problem)
        if key.outcome != "ran":
            continue

        for case in key.cases:
            expected = oracle.get(case.case_id)
            if expected is None:
                continue
            if case.case_id in divergences:
                # Named individually in the app, and carried through the export for the same reason:
                # a third divergence must fail rather than join a category.
                continue
            checked += 1
            if not agrees(case.repr_ or "", expected):
                mismatches.append(f"{case.case_id}: oracle={expected!r} cpython={case.repr_!r}")

    assert mismatches == [], (
        "CPython disagrees with the frozen Judge0 oracle — one of the two is wrong, and "
        "the app's Pyodide grader already agrees with the oracle:\n  " + "\n  ".join(mismatches)
    )
    assert checked > 100, f"only {checked} oracle cases were checked; the arm is too weak to trust"


# ── Arm 3: the spec fixtures ──────────────────────────────────────────────────────────────────


def test_independent_correct_solutions_are_accepted(catalogue: dict, problems: dict[str, dict]) -> None:
    """Each ``correct`` is a second implementation, not a paraphrase of the reference."""
    rejected: list[str] = []

    for spec in catalogue["specs"]:
        problem = problems[spec["problemId"]]
        if _needs_numpy(problem):
            try:
                import numpy  # noqa: F401
            except ImportError:
                continue

        verdict = grade(problem, spec["correct"])
        if not verdict.solved:
            rejected.append(f"{spec['problemId']}: {verdict.outcome} failed={verdict.failed}")

    assert rejected == [], (
        "a correct-but-differently-written solution was rejected, so this grader is stricter "
        "than the app's:\n  " + "\n  ".join(rejected)
    )


def test_named_mutants_are_rejected_by_their_named_case(
    catalogue: dict, problems: dict[str, dict]
) -> None:
    """The property a reward function actually needs: wrong answers score lower.

    The case id is the expensive part of a spec and the reason this works — naming it forces the
    author to say which case catches the trap, which forces a case designed for it to exist.
    """
    survivors: list[str] = []

    for spec in catalogue["specs"]:
        problem = problems[spec["problemId"]]
        if _needs_numpy(problem):
            try:
                import numpy  # noqa: F401
            except ImportError:
                continue

        for mutant in spec["mutants"]:
            verdict = grade(problem, mutant["source"])
            if verdict.solved:
                survivors.append(f"{spec['problemId']} / {mutant['label']}: not caught at all")
            elif mutant["caseId"] not in verdict.failed:
                survivors.append(
                    f"{spec['problemId']} / {mutant['label']}: caught, but not by "
                    f"{mutant['caseId']} (failed {verdict.failed})"
                )

    assert survivors == [], (
        "a named mutant was not rejected by the case named for it:\n  " + "\n  ".join(survivors)
    )


# ── Honesty about what ran ────────────────────────────────────────────────────────────────────


def test_partial_credit_is_between_zero_and_one(problems: dict[str, dict]) -> None:
    """The reward shape, checked at both ends.

    A reference scores 1.0 and an empty submission scores 0.0 through the `missing_entry` path — the
    two anchors a GRPO advantage is computed between. Without this, a reward that always returned the
    same number would satisfy every assertion above.
    """
    problem = next(p for p in problems.values() if not _needs_numpy(p))

    assert grade(problem, problem["reference"]).fraction == 1.0
    empty = grade(problem, "x = 1\n")
    assert empty.outcome == "missing_entry"
    assert empty.fraction == 0.0


def test_coverage_is_honest(problems: dict[str, dict]) -> None:
    """Report which problems this environment could not check, rather than passing over them.

    numpy is optional here on purpose: the suite must be runnable on a machine that has not installed
    a training stack. But "green" has to mean something specific, so the split is asserted.
    """
    needs = [p["id"] for p in problems.values() if _needs_numpy(p)]
    stdlib = [p["id"] for p in problems.values() if not _needs_numpy(p)]

    assert len(stdlib) > len(needs), "most problems should be pure stdlib; the export may be wrong"

    try:
        import numpy  # noqa: F401

        print(f"\nnumpy present: all {len(problems)} problems checked")
    except ImportError:
        print(
            f"\nnumpy ABSENT: {len(stdlib)} problems checked, {len(needs)} skipped. "
            f"Install numpy for full coverage."
        )


# ── The comparison rule itself ────────────────────────────────────────────────────────────────
#
# The three arms above compare against other implementations, which is the strongest evidence
# available — but it is evidence about the *catalogue*, and the catalogue does not exercise every
# branch of the rule. Mutation testing found exactly that: three deliberate breaks in `grader.py`
# survived all three arms, because no reference, `correct` variant or oracle case reaches them.
#
# Each of these is a learner behaviour rather than an authoring behaviour, which is why the content
# cannot cover it: a *submission* returns a numpy array where the reference returned a list, or
# negates differently, or raises. The reward function meets all three constantly.


def _synthetic(entry: str, reference: str, args: list, normalise: str | None = None) -> dict:
    """A one-case problem for testing the rule, not the content."""
    return {
        "id": f"synthetic-{entry}",
        "entry": entry,
        "reference": reference,
        "normalise": normalise,
        "cases": [{"id": "only", "label": "only", "visible": True, "args": args}],
    }


def test_negative_zero_does_not_fail_a_correct_answer() -> None:
    """IEEE-754 keeps the sign through a negation; the answer is the same.

    ``-log(1.0)`` is ``-0.0`` while a loop accumulating into ``0.0`` gives ``+0.0``. Comparison is on
    the repr, so without collapsing the sign a learner's right answer is marked wrong against a
    reference that merely negated differently. The app records finding this via the cross-entropy
    "perfect prediction" case — a curriculum problem, which has no oracle entry and no spec, which is
    why no differential arm reaches it.
    """
    problem = _synthetic("f", "def f(x):\n    return 0.0\n", [1])
    negated = "def f(x):\n    return -0.0\n"

    verdict = grade(problem, negated)
    assert verdict.solved, "a correct answer that negated differently was marked wrong"


def test_a_numpy_array_matches_the_equivalent_list() -> None:
    """The exercise asks for a value, not for a particular container.

    References mostly call ``.tolist()`` themselves, so both sides are already lists and the branch is
    never taken by authored content. A learner returning the array directly is the common case, and
    failing them for it would be wrong.
    """
    # The call is the point: it skips this test when numpy is absent. The binding was
    # never used, so only the assignment is dropped.
    pytest.importorskip("numpy")

    problem = _synthetic("f", "def f(x):\n    return [0.5, 1.5]\n", [1])
    as_array = "import numpy as np\n\ndef f(x):\n    return np.array([0.5, 1.5])\n"

    verdict = grade(problem, as_array)
    assert verdict.solved, "a numpy array was not accepted where the reference returned a list"


def test_a_raising_submission_fails_rather_than_passes() -> None:
    """The direction that matters. A reward that scores exceptions as correct is not a reward.

    No differential arm reaches this: references do not raise, and the named mutants fail by computing
    the wrong value rather than by crashing.
    """
    problem = _synthetic("f", "def f(x):\n    return x * 2\n", [21])
    raises = "def f(x):\n    raise ValueError('nope')\n"

    verdict = grade(problem, raises)
    assert not verdict.solved
    assert verdict.failed == ["only"]
    assert verdict.fraction == 0.0


def test_output_that_does_not_parse_scores_zero() -> None:
    """A policy emitting prose instead of code must score 0.0, not crash the trainer."""
    problem = _synthetic("f", "def f(x):\n    return x\n", [1])

    verdict = grade(problem, "Here is my solution:\n\ndef f(x)\n    return x\n")
    assert verdict.outcome == "compile_or_import"
    assert verdict.fraction == 0.0
