"""The sandbox that `grader.run_cases` says callers must use, and that did not exist.

The measurement that found this hung for 25 minutes on generated code with a non-terminating loop.
So the test that matters is not "does a good solution still pass" — it is "does a bad one stop".
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reward.limits import run_isolated

PROBLEM = {
    "id": "add-two", "title": "Add", "entry": "add", "normalise": None,
    "cases": [
        {"id": "a", "args": [1, 2], "visible": True},
        {"id": "b", "args": [10, -3], "visible": False},
    ],
    "reference": "def add(a, b):\n    return a + b\n",
}


def test_a_correct_solution_still_passes() -> None:
    r = run_isolated(PROBLEM, "def add(a, b):\n    return a + b\n")
    assert r.solved is True
    assert r.case_fraction == 1.0


def test_a_wrong_solution_scores_partial_not_zero() -> None:
    """Partial credit is what gives GRPO a gradient when nothing fully solves the problem."""
    # Keyed on b, not a: both fixture cases have a > 0, so a condition on a passes both and the
    # first version of this test asserted that a solution was wrong when it was in fact correct.
    r = run_isolated(PROBLEM, "def add(a, b):\n    return a + b if b > 0 else 999\n")
    assert r.solved is False
    assert 0.0 < r.case_fraction < 1.0


def test_an_infinite_loop_is_killed_and_scores_zero() -> None:
    """The bug this module exists for. Must return, not hang."""
    started = time.monotonic()
    r = run_isolated(PROBLEM, "def add(a, b):\n    while True:\n        pass\n", timeout_s=3.0)
    elapsed = time.monotonic() - started

    assert r.solved is False
    assert r.outcome == "timeout"
    assert r.case_fraction == 0.0
    assert elapsed < 15.0, f"took {elapsed:.1f}s; the timeout is not being enforced"


def test_a_crashing_solution_scores_zero_without_taking_the_parent_down() -> None:
    r = run_isolated(PROBLEM, "def add(a, b):\n    raise RuntimeError('boom')\n")
    assert r.solved is False
    assert r.case_fraction == 0.0


def test_sys_exit_in_the_submission_does_not_end_the_run() -> None:
    """A learner — or a policy — can call sys.exit. In-process that would kill the trainer."""
    r = run_isolated(PROBLEM, "import sys\nsys.exit(0)\ndef add(a, b):\n    return a + b\n")
    assert r.solved is False


def test_a_memory_bomb_does_not_take_the_host_with_it() -> None:
    """POSIX rlimit. On Windows only the wall clock applies, so this asserts termination either way."""
    started = time.monotonic()
    r = run_isolated(PROBLEM,
                     "def add(a, b):\n    x = [0] * (10 ** 10)\n    return len(x)\n",
                     timeout_s=8.0, memory_mb=256)
    assert r.solved is False
    assert time.monotonic() - started < 20.0


def test_a_numpy_solution_survives_the_default_memory_limit() -> None:
    """The regression for the limit being on VIRTUAL address space, not resident memory.

    The bomb test above only asserts the limit *kills* things. Nothing asserted that a legitimate
    solution *survives* it, and that is the direction the bug went: `DEFAULT_MEMORY_MB` was 2048,
    numpy reserves several GiB of VA it never commits, and the child thrashed against failing
    mmaps until the wall clock killed it. A 0.2s grade became a 60s timeout, and a timeout scores
    zero — so the GRPO eval reported solved_any 0/60 against 6/60 measured on the same model.

    It was invisible for the whole of development because `_apply_rlimits` is a no-op on Windows
    (no `resource` module), so this branch had never once been exercised. Measured on Linux:
    2048 -> timeout at 60s, 8192 -> solved in 0.2s.

    Asserted at the *default*, deliberately. Pinning a number here would pass while the default
    that every caller actually uses stayed broken.
    """
    pytest.importorskip("resource", reason="rlimits are POSIX-only; a no-op on Windows")
    numpy_solution = (
        "import numpy as np\n"
        "def add(a, b):\n"
        "    return int(np.array([a, b]).sum())\n"
    )
    started = time.monotonic()
    r = run_isolated(PROBLEM, numpy_solution)     # DEFAULT_MEMORY_MB, no override
    elapsed = time.monotonic() - started

    assert r.outcome != "timeout", (
        f"a numpy solution timed out under the default memory limit after {elapsed:.1f}s — "
        "RLIMIT_AS is too low again; it caps virtual address space, not resident memory"
    )
    assert r.solved is True


def test_works_when_the_parent_has_cuda_initialised() -> None:
    """The regression. A CUDA context does not survive fork(), and the caller is a training loop.

    With the fork start method this returned a timeout for a *correct* solution, because the child
    died of MemoryError before it could grade anything. The whole first isolated pass-rate run
    scored 0/8 on problems the model had solved. spawn fixes it; this test is why it stays.
    """
    torch = pytest.importorskip("torch", reason="needs torch")
    if not torch.cuda.is_available():
        pytest.skip("no CUDA device; fork/spawn makes no difference without one")

    torch.zeros(1).cuda()
    torch.cuda.synchronize()

    r = run_isolated(PROBLEM, "def add(a, b):\n    return a + b\n")
    assert r.solved is True, f"grading broke with CUDA live in the parent: {r.outcome} {r.error}"
    assert r.outcome == "ran"
