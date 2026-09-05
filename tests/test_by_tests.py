"""Grading against a public corpus's own tests, with partial credit preserved."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reward.by_tests import grade_by_tests
from reward.limits import run_isolated_tests

GOOD = "def add(a, b):\n    return a + b\n"
# Passes 2 of the 3 cases, failing only the negative one. `b > 0` also fails the zero case, which
# is how the first version of this fixture expected 2/3 and measured 1/3 — the fixture was wrong,
# not the grader.
HALF = "def add(a, b):\n    return a + b if b >= 0 else 999\n"

FUNCS = (
    "def test_pos():\n    assert add(1, 2) == 3\n"
    "def test_neg():\n    assert add(10, -3) == 7\n"
    "def test_zero():\n    assert add(0, 0) == 0\n"
)
BARE = "assert add(1, 2) == 3\nassert add(10, -3) == 7\nassert add(0, 0) == 0\n"


@pytest.mark.parametrize("tests", [FUNCS, BARE], ids=["test-functions", "bare-asserts"])
def test_a_correct_solution_passes_every_case(tests: str) -> None:
    r = grade_by_tests(GOOD, tests)
    assert r.total == 3 and r.passed == 3
    assert r.solved is True and r.case_fraction == 1.0


@pytest.mark.parametrize("tests", [FUNCS, BARE], ids=["test-functions", "bare-asserts"])
def test_partial_credit_survives_a_failing_case(tests: str) -> None:
    """The whole reason this module exists.

    A binary reward scores this zero and the group goes dead. Counting cases gives 2/3, which is a
    gradient. On the 60 local problems that distinction took the usable set from 7 to 27.
    """
    r = grade_by_tests(HALF, tests)
    assert r.total == 3 and r.passed == 2
    assert r.solved is False
    assert r.case_fraction == pytest.approx(2 / 3)


def test_a_failing_bare_assert_does_not_hide_the_ones_after_it() -> None:
    """Executing the file as one unit would stop at the first failure and report 0 of 3.

    Each assert is run separately so the later ones still count — the hidden signal that
    distinguishes a dead group from a usable one.
    """
    tests = "assert add(1, 2) == 999\nassert add(10, -3) == 7\nassert add(0, 0) == 0\n"
    r = grade_by_tests(GOOD, tests)
    assert r.passed == 2 and r.total == 3


def test_a_multiline_assert_counts_once() -> None:
    """Parsed with ast, not split on newlines. A line-based split would count this twice and
    silently deflate the reward."""
    tests = "assert add(\n    1,\n    2,\n) == 3\n"
    r = grade_by_tests(GOOD, tests)
    assert r.total == 1 and r.passed == 1


def test_a_candidate_that_will_not_import_scores_zero() -> None:
    r = grade_by_tests("def add(a, b)\n    return a+b\n", FUNCS)
    assert r.case_fraction == 0.0
    assert r.outcome == "candidate_failed"


def test_unparseable_tests_are_a_corpus_bug_not_a_model_failure() -> None:
    """Kept distinct so a broken corpus entry cannot be mistaken for a weak policy."""
    r = grade_by_tests(GOOD, "def test_x(:\n  assert True\n")
    assert r.outcome == "tests_unparseable"


def test_isolation_kills_a_non_terminating_test() -> None:
    """The public-corpus path needs the same timeout as the authored one."""
    r = run_isolated_tests(GOOD, "def test_spin():\n    while True:\n        pass\n", timeout_s=3.0)
    assert r.outcome == "timeout"
    assert r.case_fraction == 0.0


def test_isolation_preserves_partial_credit() -> None:
    r = run_isolated_tests(HALF, FUNCS, timeout_s=10.0)
    assert r.case_fraction == pytest.approx(2 / 3)


# ── stdin/stdout grading, the shape DeepCoder actually uses ───────────────────────────────────

from reward.by_tests import grade_by_stdio, normalise_output  # noqa: E402
from reward.limits import run_isolated_stdio  # noqa: E402

DOUBLER = "import sys\nn = int(sys.stdin.readline())\nprint(n * 2)\n"
IO_TESTS = [{"input": "5\n", "output": "10"},
            {"input": "3\n", "output": "6"},
            {"input": "7\n", "output": "14"}]


def test_stdio_partial_credit() -> None:
    """Four of five inputs correct must score 0.8, not fail."""
    tests = [*IO_TESTS, {"input": "1\n", "output": "999"}]
    r = grade_by_stdio(DOUBLER, tests)
    assert r.passed == 3 and r.total == 4
    assert r.case_fraction == pytest.approx(0.75)
    assert r.solved is False


def test_stdio_all_correct() -> None:
    r = grade_by_stdio(DOUBLER, IO_TESTS)
    assert r.solved is True and r.case_fraction == 1.0


def test_trailing_whitespace_is_not_a_difference() -> None:
    """A judge does not fail a correct program over a newline, and neither does this."""
    assert normalise_output("10 \n\n") == normalise_output("10")
    r = grade_by_stdio("print('10   ')\n", [{"input": "", "output": "10\n\n"}])
    assert r.solved is True


def test_each_case_gets_a_clean_namespace() -> None:
    """A program that mutates module state must not be scored against its own leftovers."""
    src = ("import sys\n"
           "seen = globals().setdefault('seen', 0) + 1\n"
           "globals()['seen'] = seen\n"
           "print(seen)\n")
    r = grade_by_stdio(src, [{"input": "", "output": "1"}, {"input": "", "output": "1"}])
    assert r.passed == 2, "state leaked between cases; the second run saw the first run's globals"


def test_a_crashing_case_does_not_stop_the_others() -> None:
    src = "import sys\nn = int(sys.stdin.readline())\nprint(10 // n)\n"
    r = grade_by_stdio(src, [{"input": "0\n", "output": "x"},      # ZeroDivisionError
                             {"input": "2\n", "output": "5"},
                             {"input": "5\n", "output": "2"}])
    assert r.passed == 2 and r.total == 3


def test_stdio_isolation_kills_an_infinite_loop() -> None:
    r = run_isolated_stdio("while True:\n    pass\n", IO_TESTS, timeout_s=3.0)
    assert r.outcome == "timeout" and r.case_fraction == 0.0
