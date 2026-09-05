"""The verifiable reward: a CPython port of the desktop app's grader.

WHY A SECOND GRADER EXISTS
--------------------------
The VoidCode desktop app already contains everything a verifiable reward needs — 60 problems, 320
cases, 182 of them hidden, and reference solutions from which every expectation is *derived* rather
than typed. What it does not have is a Python entry point: the grader runs in Pyodide inside an
Electron ``utilityProcess``, which a training loop cannot call.

So this reimplements the comparison rule in CPython. The point is not convenience. Two independent
implementations agreeing is evidence that neither is wrong, which is the same argument the app's own
``verify-spec.ts`` makes when it demands a ``correct`` variant written independently of the reference.

THE COMPARISON RULE, IN FULL
----------------------------
Ported from ``desktop/src/main/exec/runtime/bootstrap.py``. The whole rule is::

    repr(round_recursive(normalise(entry(*args)), 8))

compared as an exact string. Three details carry it, and each exists because something went wrong
without it:

* ``.tolist()`` first, so ``numpy.array([0.5])`` and ``[0.5]`` compare equal. The exercise asks for a
  value, not for a particular container.
* Floats rounded to 8 places, so a grader is not comparing the last bit of a float64.
* **Negative zero collapsed.** IEEE-754 keeps the sign through a negation, so ``-log(1.0)`` is ``-0.0``
  while a loop accumulating into ``0.0`` gives ``+0.0`` — the same correct answer with two spellings.
  Comparison is on the repr, so without this a learner's right answer is marked wrong against a
  reference that merely negated differently. The app's comment records that this was found by the
  cross-entropy "perfect prediction" case.

``normalise`` is a per-problem Python expression in ``_r``, applied identically to the reference and
the submission. It is compiled into **its own namespace** with ``json`` handed in rather than
imported — a learner who defines ``json`` or ``round`` must not be able to change how their own answer
is compared, and the app's import guard would reject an ``import json`` aimed at somebody else.

WHAT IS DELIBERATELY NOT PORTED
-------------------------------
The app measures ``wasmHeapBytes`` and kills a wedged ``utilityProcess``; neither has a CPython
analogue. Limits here are ordinary subprocess timeouts and ``resource`` rlimits — see ``limits.py``,
which is honest about what Windows cannot enforce.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

#: Decimal places. Matches ``bootstrap.py``'s ``_round`` default; the frozen Judge0 oracle rounded to
#: 9 for two cases, which is why the export carries an explicit divergence list rather than a rule.
ROUND_PLACES = 8


def round_recursive(value: Any, places: int = ROUND_PLACES) -> Any:
    """Round floats anywhere in a nested structure, collapsing negative zero."""
    if isinstance(value, bool):
        # Before the int check: bool is a subclass of int, and `repr(True)` must stay `True`.
        return value
    if isinstance(value, float):
        rounded = round(value, places)
        return 0.0 if rounded == 0 else rounded
    if isinstance(value, (list, tuple)):
        return [round_recursive(item, places) for item in value]
    if isinstance(value, dict):
        return {key: round_recursive(item, places) for key, item in value.items()}
    return value


def stable_repr(value: Any) -> str:
    """The textual form the app compares on.

    ``tolist`` first so a numpy array and the equivalent list agree. Checked with ``callable`` rather
    than by importing numpy: only 14 of 60 problems declare it, so this module must work for the
    other 46 with numpy not installed at all.
    """
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        value = tolist()
    return repr(round_recursive(value))


def compile_normalise(expression: str | None) -> Callable[[Any], Any] | None:
    """Compile a per-problem ``normalise`` expression into its own namespace.

    ``json`` is handed over rather than imported, for the reason in the module docstring. Returns
    ``None`` when the problem has no expression, which is every curriculum problem.
    """
    if not expression:
        return None
    namespace: dict[str, Any] = {"json": json}
    exec(  # noqa: S102 - compiling authored content, not learner input
        compile("def _normalise_output(_r):\n    return (" + expression + ")", "<normalise>", "exec"),
        namespace,
    )
    return namespace["_normalise_output"]  # type: ignore[no-any-return]


@dataclass(frozen=True)
class CaseOutcome:
    """One case's result. ``repr_`` is ``None`` when the call raised."""

    case_id: str
    ok: bool
    repr_: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class RunOutcome:
    """What running a submission against every case produced.

    ``outcome`` mirrors the app's vocabulary: ``ran`` means the cases were attempted, and anything
    else means execution never got that far, so per-case results are meaningless.
    """

    outcome: str
    cases: list[CaseOutcome] = field(default_factory=list)
    error: str | None = None


def run_cases(
    source: str,
    entry: str,
    cases: list[dict[str, Any]],
    normalise: str | None = None,
) -> RunOutcome:
    """Execute ``source`` against every case, in this process.

    **Not sandboxed.** Callers that handle model output must go through ``limits.run_isolated``, which
    puts this behind a subprocess with a timeout and, on POSIX, memory and CPU rlimits. This function
    is used directly only for content this repository already trusts — references and authored spec
    variants — where the subprocess overhead would dominate 320 cases for no benefit.
    """
    namespace: dict[str, Any] = {"__name__": "__exercise__"}
    try:
        exec(compile(source, "<solution>", "exec"), namespace)  # noqa: S102 - the point of the module
    except BaseException as exc:  # noqa: BLE001 - a learner can raise anything, including SystemExit
        return RunOutcome(outcome="compile_or_import", error=f"{type(exc).__name__}: {exc}")

    function = namespace.get(entry)
    if not callable(function):
        return RunOutcome(outcome="missing_entry", error=f"No function named `{entry}` was defined.")

    try:
        normalise_fn = compile_normalise(normalise)
    except BaseException as exc:  # noqa: BLE001
        # The expression is authored, so this is our bug rather than the submission's.
        return RunOutcome(outcome="bad_normalise", error=f"{type(exc).__name__}: {exc}")

    results: list[CaseOutcome] = []
    for case in cases:
        args = list(case.get("args") or [])
        kwargs = dict(case.get("kwargs") or {})
        try:
            value = function(*args, **kwargs)
            if normalise_fn is not None:
                value = normalise_fn(value)
            results.append(CaseOutcome(case_id=case["id"], ok=True, repr_=stable_repr(value)))
        except BaseException as exc:  # noqa: BLE001
            results.append(
                CaseOutcome(case_id=case["id"], ok=False, error=f"{type(exc).__name__}: {exc}")
            )

    return RunOutcome(outcome="ran", cases=results)


def answer_key(problem: dict[str, Any]) -> RunOutcome:
    """Derive the expected reprs by executing the reference.

    Nothing is ever hand-keyed, exactly as in the app: ``grader.ts``'s header states the rule as "no
    expected output is ever written down by hand". That is what makes a second grader safe to build —
    there is no stored key for the two implementations to drift apart on, only a reference they both
    execute.
    """
    return run_cases(
        problem["reference"], problem["entry"], problem["cases"], problem.get("normalise")
    )


@dataclass(frozen=True)
class Verdict:
    """The graded result of one submission against one problem."""

    problem_id: str
    solved: bool
    outcome: str
    passed: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def fraction(self) -> float:
        """Partial credit, for a reward that is not all-or-nothing.

        A policy that fixes three cases of four has improved, and a binary reward cannot say so.
        Returns 0.0 when execution never reached the cases, which is the correct signal for output
        that does not parse.
        """
        total = len(self.passed) + len(self.failed)
        return len(self.passed) / total if total else 0.0


def grade(problem: dict[str, Any], source: str, key: RunOutcome | None = None) -> Verdict:
    """Grade a submission against every case, hidden ones included.

    ``key`` may be supplied to avoid re-deriving it per submission — during RL the same problem is
    graded many times per step and the reference does not change.
    """
    expected = key if key is not None else answer_key(problem)
    if expected.outcome != "ran":
        # Our bug, never the submission's. The app calls this `referenceBroken` and says so.
        return Verdict(
            problem_id=problem["id"],
            solved=False,
            outcome="reference_broken",
            error=expected.error,
        )

    actual = run_cases(source, problem["entry"], problem["cases"], problem.get("normalise"))
    if actual.outcome != "ran":
        return Verdict(
            problem_id=problem["id"], solved=False, outcome=actual.outcome, error=actual.error
        )

    by_id = {case.case_id: case for case in actual.cases}
    passed: list[str] = []
    failed: list[str] = []
    for wanted in expected.cases:
        got = by_id.get(wanted.case_id)
        # Exact string equality on the repr — the app's `actual.repr === expected`.
        if got is not None and got.ok and got.repr_ == wanted.repr_:
            passed.append(wanted.case_id)
        else:
            failed.append(wanted.case_id)

    return Verdict(
        problem_id=problem["id"],
        solved=not failed,
        outcome="ran",
        passed=passed,
        failed=failed,
    )
