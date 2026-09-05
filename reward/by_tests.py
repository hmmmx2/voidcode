"""Grade a solution against a public corpus's own test suite, with partial credit.

`grader.run_cases` compares `repr(round_recursive(normalise(entry(*args)), 8))` — it assumes a
function called with arguments and an expectation *derived* by executing a reference. Public corpora
are not shaped that way: KodCode ships pytest-style test functions, MBPP ships bare `assert` lines,
and TACO/LiveCodeBench are largely stdin/stdout. Forcing them into `(args, expected)` would mean
reimplementing their semantics; running their tests does not.

WHY PARTIAL CREDIT IS THE WHOLE POINT
--------------------------------------
Measured on the 60 local problems: a binary solved/not-solved reward leaves **7 of 60** with any
GRPO signal. Counting the *fraction of cases passed* leaves **27**. Nearly four times the usable
corpus, from the same generations. A test suite that reports "7 of 10 assertions passed" carries a
gradient that "failed" does not, so this counts individual tests rather than the file.

TWO TEST SHAPES, BOTH COUNTED PER-ASSERTION
--------------------------------------------
  functions   `def test_foo(): assert ...`   -> each function is one case
  bare        `assert f(1) == 2`             -> each statement is one case

Running the file as a single unit would collapse either shape to pass/fail and throw the signal
away, which is the mistake this module exists to avoid.

**Not sandboxed.** Same contract as `grader.run_cases`: callers handling model output must go
through `limits.run_isolated_tests`, which is the wrapper that owns the timeout and the rlimits.
That warning is not boilerplate here — grading generated code in-process already hung this
repository for 25 minutes once.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any


@dataclass
class TestOutcome:
    passed: int = 0
    total: int = 0
    outcome: str = "ran"
    error: str | None = None
    failures: list[str] = field(default_factory=list)

    @property
    def solved(self) -> bool:
        return self.total > 0 and self.passed == self.total

    @property
    def case_fraction(self) -> float:
        """The reward. Zero when nothing ran, which is correct — code that will not import has
        not partially solved anything."""
        return self.passed / self.total if self.total else 0.0


def _split_cases(test_code: str) -> tuple[list[str], list[Any]]:
    """Return (test function names, top-level assert statements).

    Parsed with `ast` rather than split on newlines, because an assert can span lines and a
    line-based split would silently mis-count — inflating `total` and deflating the reward.
    """
    tree = ast.parse(test_code)
    functions = [n.name for n in tree.body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and n.name.startswith("test")]
    asserts = [n for n in tree.body if isinstance(n, ast.Assert)]
    return functions, asserts


def grade_by_tests(source: str, test_code: str) -> TestOutcome:
    """Execute ``source``, then its test suite, counting cases individually."""
    namespace: dict[str, Any] = {"__name__": "__candidate__"}

    try:
        exec(compile(source, "<candidate>", "exec"), namespace)  # noqa: S102 - the point of the module
    except BaseException as exc:  # noqa: BLE001 - generated code raises anything, incl. SystemExit
        return TestOutcome(outcome="candidate_failed", error=f"{type(exc).__name__}: {exc}")

    try:
        functions, asserts = _split_cases(test_code)
    except SyntaxError as exc:
        # A corpus whose own tests will not parse is a corpus bug, not a candidate failure. Kept
        # distinct so a bad import cannot be mistaken for a bad model.
        return TestOutcome(outcome="tests_unparseable", error=f"SyntaxError: {exc}")

    try:
        exec(compile(test_code, "<tests>", "exec"), namespace)  # noqa: S102
    except BaseException as exc:  # noqa: BLE001
        # Module-level failure. If the suite is bare asserts, the first failing one lands here and
        # the per-assert pass below still attributes the rest.
        if not functions and not asserts:
            return TestOutcome(outcome="tests_failed_to_load", error=f"{type(exc).__name__}: {exc}")

    result = TestOutcome()

    for name in functions:
        result.total += 1
        fn = namespace.get(name)
        if not callable(fn):
            result.failures.append(f"{name}: not callable after exec")
            continue
        try:
            fn()
            result.passed += 1
        except BaseException as exc:  # noqa: BLE001
            result.failures.append(f"{name}: {type(exc).__name__}: {exc}")

    if not functions:
        # Bare-assert suite. Re-executed one statement at a time so a failure at line 3 does not
        # hide whether lines 4 and 5 would have passed — that hidden signal is exactly the
        # difference between a dead group and a usable one.
        for node in asserts:
            result.total += 1
            try:
                exec(compile(ast.Module(body=[node], type_ignores=[]), "<assert>", "exec"),
                     namespace)  # noqa: S102
                result.passed += 1
            except BaseException as exc:  # noqa: BLE001
                result.failures.append(f"line {node.lineno}: {type(exc).__name__}: {exc}")

    if result.total == 0:
        result.outcome = "no_cases_found"
    return result


# ── stdin/stdout grading, which is what DeepCoder actually needs ───────────────────────────────
#
# The corpus scope assumed pytest-style tests, which is KodCode's shape. DeepCoder is not that:
# its subsets come from TACO, LiveCodeBench and Codeforces, and tests are `{"input": ..., "output":
# ...}` pairs against a program that reads stdin and writes stdout. Discovering that after building
# `grade_by_tests` cost one function, not a rewrite, because both reduce to the same thing: count
# cases individually so partial credit survives.


@dataclass
class StdioCase:
    index: int
    expected: str
    got: str
    ok: bool


def normalise_output(text) -> str:
    """Compare the way a judge does: trailing whitespace per line, and trailing blank lines, are
    not differences. Anything stricter fails correct programs over a newline.

    **Accepts a list as well as a string.** DeepCoder stores some `input` and `output` values as a
    list of lines rather than one blob, and annotating this `text: str` did not make it so. The
    first such row raised `AttributeError: 'list' object has no attribute 'strip'` twenty minutes
    into grading, after generation had already succeeded — so the cost of the assumption was a
    whole run, not a stack trace.
    """
    if isinstance(text, (list, tuple)):
        text = "\n".join(str(part) for part in text)
    elif not isinstance(text, str):
        text = str(text)
    return "\n".join(line.rstrip() for line in text.strip().splitlines())


def grade_by_stdio(source: str, tests: list[dict], input_key: str = "input",
                   output_key: str = "output") -> TestOutcome:
    """Run ``source`` as a script once per test, feeding stdin and comparing stdout.

    Each pair is one case, so a program correct on four of five inputs scores 0.8 rather than
    failing — the same partial-credit argument that took the 60 local problems from 7 usable to 27.

    **Not sandboxed**, same as everything else in this module: go through
    `limits.run_isolated_stdio`. A competitive-programming solution that loops forever on an edge
    case is more likely here than in authored content, not less.
    """
    import contextlib
    import io

    result = TestOutcome()
    compiled = None
    try:
        compiled = compile(source, "<candidate>", "exec")
    except BaseException as exc:  # noqa: BLE001
        return TestOutcome(outcome="candidate_failed", error=f"{type(exc).__name__}: {exc}")

    for i, case in enumerate(tests):
        result.total += 1
        stdin_text = case.get(input_key) or ""
        if isinstance(stdin_text, (list, tuple)):
            stdin_text = "\n".join(str(part) for part in stdin_text)
        expected = normalise_output(case.get(output_key) or "")
        stdout = io.StringIO()
        try:
            # A fresh namespace per case: a program that mutates module state must not have its
            # second run scored against the first run's leftovers.
            namespace: dict[str, Any] = {"__name__": "__main__"}
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                import sys as _sys
                original, _sys.stdin = _sys.stdin, io.StringIO(stdin_text)
                try:
                    exec(compiled, namespace)  # noqa: S102 - the point of the module
                finally:
                    _sys.stdin = original
            got = normalise_output(stdout.getvalue())
            if got == expected:
                result.passed += 1
            else:
                result.failures.append(f"case {i}: expected {expected[:40]!r}, got {got[:40]!r}")
        except BaseException as exc:  # noqa: BLE001
            result.failures.append(f"case {i}: {type(exc).__name__}: {exc}")

    if result.total == 0:
        result.outcome = "no_cases_found"
    return result
