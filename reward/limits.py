"""Run untrusted model output under a wall-clock timeout, and rlimits where the OS has them.

`grader.run_cases` executes its input with `exec` in the calling process, and says so: *"Not
sandboxed. Callers that handle model output must go through `limits.run_isolated`."* That module did
not exist. This is it.

WHY IT IS NEEDED, DISCOVERED THE OBVIOUS WAY
---------------------------------------------
The base pass-rate measurement called `grade()` directly on generated code and **hung for 25 minutes
on problem 7 of 60** before anyone noticed, holding the GPU idle at 2%. The problem was `bpe-merge`,
which declares `timeLimitMs: 200` — a limit nothing in the reward path was reading. A merge loop
with a wrong stopping condition does not raise, it spins.

GRPO makes this structural rather than unlucky. A training run executes G completions per prompt,
thousands per epoch, all of them written by a model that is being actively pushed toward unusual
outputs. **One `while True:` stalls training indefinitely and looks exactly like a slow step.**

WHAT THIS GUARANTEES, AND WHAT IT DOES NOT
-------------------------------------------
Guaranteed: a hard wall-clock bound. A submission that exceeds it is killed and scores zero, which
is the correct reward — code that does not terminate has not solved the problem.

On POSIX, additionally: an address-space rlimit and a CPU-time rlimit, so a memory bomb dies rather
than swapping the host to a standstill.

**Not** a security sandbox. The child can still open files and sockets; it is a separate process for
*termination*, not for containment. Treat the catalogue and the policy as semi-trusted, and do not
run this on the open internet's output without something stronger underneath.
"""
from __future__ import annotations

import contextlib
import multiprocessing as mp
import pathlib
import sys
import threading
from dataclasses import dataclass
from typing import Any

#: Generous against the catalogue's own limits (the largest is 2000 ms) while still bounding a
#: non-terminating submission to something a training loop can absorb.
DEFAULT_TIMEOUT_S = 10.0

#: 8 GiB, not 2. **This limit is on virtual address space, not resident memory**, and numpy alone
#: reserves several gigabytes of VA that it never commits. At 2048 the grading child did not fail
#: cleanly -- it thrashed against failing mmaps until the wall clock killed it, so a 0.2s grade
#: became a 60s timeout, and a timeout is scored as zero.
#:
#: Cost of getting this wrong: the first GRPO run on the A40 reported `solved_any: 0` on the 60
#: held-out problems, against 6/60 measured locally with the same model. Every correct answer was
#: scored zero. It was invisible on Windows because `_apply_rlimits` is a no-op there (no
#: `resource` module), so the limit had never once been exercised before the run moved to Linux.
#: A flat eval curve produced this way is indistinguishable from an honest "GRPO did not transfer".
#:
#: 8 GiB still bounds a genuine memory bomb -- the point of the limit -- while leaving room for the
#: scientific stack the catalogue's ML/DL problems import.
DEFAULT_MEMORY_MB = 8192


@dataclass
class IsolatedResult:
    solved: bool
    passed: list
    failed: list
    outcome: str
    error: str | None = None

    @property
    def case_fraction(self) -> float:
        """Partial credit, which is what the GRPO reward uses. Zero when nothing ran."""
        total = len(self.passed) + len(self.failed)
        return len(self.passed) / total if total else 0.0


# ── how the grading child is started ──────────────────────────────────────────────
#
# MEASURED, on the training pod: 21.8s per grading call with a heavy `__main__`, 1.7s with a light
# one. Identical work; a 13x difference. train_grpo.py and filter_corpus.py import torch at module
# scope, and the child re-runs the parent's `__main__` before it unpickles the target, so every
# grading call paid a full torch import. A 60-problem eval spent ~25 minutes on it at 0% GPU.
#
# The first attempt at this was `forkserver` with `set_forkserver_preload([])`, on the theory that
# the ['__main__'] default preload was the culprit. It measured 24.3s -- no change -- because the
# preload list only governs the forkserver SERVER process. Each individual `Process.start()` calls
# `spawn.get_preparation_data`, which records how to rebuild `__main__` unconditionally
# (`init_main_from_name` when the parent was run with `-m`, else `init_main_from_path`), and the
# child runs it through `runpy` regardless of start method. Verified on the pod: start method
# `forkserver`, preload `[]`, and the child still reported 1081 modules with torch among them.
#
# So the fix has to remove the import itself, not the mechanism that triggers it: point `__main__`
# at an empty module for the duration of `start()`. See `_light_main`.
#
# `forkserver` is kept anyway -- one clean server process, children forked from THAT rather than a
# fresh interpreter each time -- but it is now the smaller half of the saving, not the fix.
#
# Forking stays safe here for the same reason `spawn` was chosen originally -- a CUDA context does
# not survive fork -- because the forkserver is a clean process that never imports torch or touches
# a device. It is the TRAINER that must never be forked, and it never is.
#
# forkserver is POSIX-only, so Windows keeps `spawn`. Same platform split the rlimits already have.
def _grading_context():
    """A context whose children fork from a clean server rather than re-exec the interpreter."""
    try:
        ctx = mp.get_context("forkserver")
        ctx.set_forkserver_preload([])
        return ctx
    except (ValueError, AttributeError, OSError):
        return mp.get_context("spawn")


#: Empty module the grading child runs in place of the parent's `__main__`.
_MP_STUB = str(pathlib.Path(__file__).with_name("_mp_stub.py"))

#: `_light_main` mutates a global (`sys.modules['__main__']`), so two threads starting grading
#: children at once could restore each other's `__file__`. Grading is single-threaded in the
#: trainer; this makes it safe anyway, and costs nothing because it is held only across `start()`.
_MAIN_LOCK = threading.Lock()


@contextlib.contextmanager
def _light_main():
    """Swap `__main__` for an empty file while a child is started, so the child does not re-import it.

    Only `Process.start()` needs wrapping: that is where `get_preparation_data` reads `__main__`
    and pickles the answer into the child's payload.

    `__file__` is REPOINTED rather than deleted because `get_preparation_data` dereferences it
    unguarded on win32 (`main_module.__file__.endswith('.exe')`); deleting it would trade a slow
    grader on Linux for a crashing one on Windows. `__spec__` is cleared as well, or a parent
    launched with `python -m ...` takes the `init_main_from_name` branch and re-imports by name.
    """
    main = sys.modules.get("__main__")
    if main is None:  # pragma: no cover - no interpreter without one
        yield
        return
    had_file = hasattr(main, "__file__")
    prev_file = getattr(main, "__file__", None)
    prev_spec = getattr(main, "__spec__", None)
    main.__file__ = _MP_STUB
    main.__spec__ = None
    try:
        yield
    finally:
        main.__spec__ = prev_spec
        if had_file:
            main.__file__ = prev_file
        else:
            del main.__file__


def _start_child(ctx, target, args):
    """Construct and start a grading child, paying the light-`__main__` dance once per call site."""
    proc = ctx.Process(target=target, args=args)
    with _MAIN_LOCK, _light_main():
        proc.start()
    return proc


def _apply_rlimits(memory_mb: int, cpu_seconds: int) -> None:
    """POSIX only. Best effort: a platform without `resource` still gets the wall-clock bound."""
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows
        return
    limit = memory_mb * 1024 * 1024
    for which, value in ((resource.RLIMIT_AS, limit), (resource.RLIMIT_CPU, cpu_seconds)):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass


def _child_tests(queue, source: str, test_code: str, memory_mb: int, cpu_seconds: int) -> None:
    _apply_rlimits(memory_mb, cpu_seconds)
    try:
        from reward.by_tests import grade_by_tests

        r = grade_by_tests(source, test_code)
        queue.put(("ok", r.solved, r.passed, r.total, r.outcome, r.error))
    except BaseException as exc:
        queue.put(("harness_error", False, 0, 0, "harness_error", f"{type(exc).__name__}: {exc}"))


def run_isolated_tests(source: str, test_code: str, timeout_s: float = DEFAULT_TIMEOUT_S,
                       memory_mb: int = DEFAULT_MEMORY_MB) -> IsolatedResult:
    """`grade_by_tests` behind the same timeout and rlimits as `run_isolated`.

    Public-corpus tests are the reward for a policy being actively pushed toward unusual output, so
    the isolation matters more here than for authored content, not less.
    """
    ctx = _grading_context()               # see _grading_context above
    queue = ctx.Queue()
    proc = _start_child(ctx, _child_tests,
                        (queue, source, test_code, memory_mb, int(timeout_s) + 1))
    proc.join(timeout_s)

    if proc.is_alive():
        proc.terminate(); proc.join(2.0)
        if proc.is_alive():
            proc.kill(); proc.join(2.0)
        return IsolatedResult(False, [], [], "timeout", f"exceeded {timeout_s}s wall clock")

    if queue.empty():
        return IsolatedResult(False, [], [], "died",
                              f"child exited with code {proc.exitcode} and no result")

    kind, solved, passed, total, outcome, error = queue.get()
    if kind == "harness_error":
        raise RuntimeError(f"grading harness failed: {error}")
    # Reuse IsolatedResult's shape: passed/failed as lists of case tokens keeps `case_fraction`
    # working unchanged, so callers do not branch on which corpus they are grading.
    return IsolatedResult(solved, [f"t{i}" for i in range(passed)],
                          [f"f{i}" for i in range(total - passed)], outcome, error)


def _child_stdio_batch(queue, sources: list, tests: list, memory_mb: int, cpu_seconds: int) -> None:
    _apply_rlimits(memory_mb, cpu_seconds)
    try:
        from reward.by_tests import grade_by_stdio

        out = []
        for src in sources:
            r = grade_by_stdio(src, tests)
            out.append((r.solved, r.passed, r.total, r.outcome, r.error))
        queue.put(("ok", out))
    except BaseException as exc:
        queue.put(("harness_error", f"{type(exc).__name__}: {exc}"))


def run_isolated_stdio_batch(sources: list, tests: list, timeout_s: float = DEFAULT_TIMEOUT_S,
                             memory_mb: int = DEFAULT_MEMORY_MB) -> list:
    """Grade every completion of one problem in a **single** child. Returns one result per source.

    `spawn` costs roughly a second, because it re-execs a fresh interpreter — and `fork` is not an
    option with a live CUDA context (see `run_isolated`). At 8 completions x 2,000 problems that is
    16,000 spawns and about four hours in which the actual grading is a rounding error. Capping
    cases per problem barely helped, because case execution was never the bottleneck: **the spawn
    was**. One child per problem instead of one per completion is ~8x, and it matters more in the
    GRPO loop than here, since that grades every step.

    The timeout is per *problem* rather than per completion, so a single non-terminating candidate
    still bounds the batch instead of the run.
    """
    ctx = _grading_context()
    queue = ctx.Queue()
    # CPU budget must scale with the BATCH, not one source.
    #
    # This passed int(timeout_s) + 1 -- a per-source budget -- to a child that grades every source
    # in the batch, while the parent below joins at timeout_s * len(sources). At --grade-timeout 60
    # with 4 sources that is 61 CPU-seconds to grade 4 sources x 20 cases inside a 240s wall
    # allowance. When RLIMIT_CPU fires the queue is empty and dead("died") is returned for ALL
    # sources, so a group that merely ran slowly is recorded as uniformly zero: a manufactured dead
    # group, indistinguishable from a genuine one because reward_for_group discards outcome.
    proc = _start_child(ctx, _child_stdio_batch,
                        (queue, sources, tests, memory_mb,
                         int(timeout_s * max(len(sources), 1)) + 1))
    proc.join(timeout_s * max(len(sources), 1))

    def dead(outcome: str, error: str) -> list:
        return [IsolatedResult(False, [], [], outcome, error) for _ in sources]

    if proc.is_alive():
        proc.terminate(); proc.join(2.0)
        if proc.is_alive():
            proc.kill(); proc.join(2.0)
        return dead("timeout", f"batch exceeded {timeout_s * len(sources)}s")
    if queue.empty():
        return dead("died", f"child exited with code {proc.exitcode}")

    kind, payload = queue.get()
    if kind == "harness_error":
        raise RuntimeError(f"grading harness failed: {payload}")
    return [IsolatedResult(solved, [f"t{i}" for i in range(passed)],
                           [f"f{i}" for i in range(total - passed)], outcome, error)
            for solved, passed, total, outcome, error in payload]


def _child_stdio(queue, source: str, tests: list, memory_mb: int, cpu_seconds: int) -> None:
    _apply_rlimits(memory_mb, cpu_seconds)
    try:
        from reward.by_tests import grade_by_stdio

        r = grade_by_stdio(source, tests)
        queue.put(("ok", r.solved, r.passed, r.total, r.outcome, r.error))
    except BaseException as exc:
        queue.put(("harness_error", False, 0, 0, "harness_error", f"{type(exc).__name__}: {exc}"))


def run_isolated_stdio(source: str, tests: list, timeout_s: float = DEFAULT_TIMEOUT_S,
                       memory_mb: int = DEFAULT_MEMORY_MB) -> IsolatedResult:
    """`grade_by_stdio` behind the same spawn, timeout and rlimits as everything else here.

    A competitive-programming solution that loops forever on one edge case is *more* likely than an
    authored one doing so, so this path needs the timeout most.
    """
    ctx = _grading_context()               # see _grading_context above
    queue = ctx.Queue()
    proc = _start_child(ctx, _child_stdio,
                        (queue, source, tests, memory_mb, int(timeout_s) + 1))
    proc.join(timeout_s)

    if proc.is_alive():
        proc.terminate(); proc.join(2.0)
        if proc.is_alive():
            proc.kill(); proc.join(2.0)
        return IsolatedResult(False, [], [], "timeout", f"exceeded {timeout_s}s wall clock")
    if queue.empty():
        return IsolatedResult(False, [], [], "died",
                              f"child exited with code {proc.exitcode} and no result")

    kind, solved, passed, total, outcome, error = queue.get()
    if kind == "harness_error":
        raise RuntimeError(f"grading harness failed: {error}")
    return IsolatedResult(solved, [f"t{i}" for i in range(passed)],
                          [f"f{i}" for i in range(total - passed)], outcome, error)


def _child_batch(queue, problem: dict, sources: list, memory_mb: int, cpu_seconds: int) -> None:
    _apply_rlimits(memory_mb, cpu_seconds)
    try:
        from reward.grader import grade

        out = []
        for src in sources:
            v = grade(problem, src)
            out.append((bool(v.solved), list(v.passed), list(v.failed), v.outcome, v.error))
        queue.put(("ok", out))
    except BaseException as exc:
        queue.put(("harness_error", f"{type(exc).__name__}: {exc}"))


def run_isolated_batch(problem: dict[str, Any], sources: list,
                       timeout_s: float = DEFAULT_TIMEOUT_S,
                       memory_mb: int = DEFAULT_MEMORY_MB) -> list:
    """Grade every completion of one catalogue problem in a **single** child.

    The counterpart to `run_isolated_stdio_batch`, and it exists for the same measured reason: the
    spawn dominates, not the grading. `run_isolated` costs roughly a second per call because it
    re-execs a fresh interpreter, and `fork` is not available to avoid that — a CUDA context does
    not survive it (see `run_isolated`).

    This path is the GRPO **evaluation** set, where the arithmetic is worst: 60 problems x an eval
    group, once every `--eval-every` steps. At a group of 4 that is 240 spawns per eval, and the
    GPU sits idle through all of them. One child per problem makes it 60.

    The timeout is per *problem* rather than per completion, so one non-terminating candidate
    bounds the batch instead of the run.
    """
    ctx = _grading_context()
    queue = ctx.Queue()
    # Same per-source-budget-for-a-whole-batch mismatch as the stdio path above.
    proc = _start_child(ctx, _child_batch,
                        (queue, problem, sources, memory_mb,
                         int(timeout_s * max(len(sources), 1)) + 1))
    proc.join(timeout_s * max(len(sources), 1))

    def dead(outcome: str, error: str) -> list:
        return [IsolatedResult(False, [], [], outcome, error) for _ in sources]

    if proc.is_alive():
        proc.terminate(); proc.join(2.0)
        if proc.is_alive():
            proc.kill(); proc.join(2.0)
        return dead("timeout", f"batch exceeded {timeout_s * len(sources)}s")
    if queue.empty():
        return dead("died", f"child exited with code {proc.exitcode}")

    kind, payload = queue.get()
    if kind == "harness_error":
        # A bug here, not a bad submission. Surfaced rather than scored -- scoring it zero is how
        # the base pass-rate run once reported 0/4 on problems that were in fact solved.
        raise RuntimeError(f"grading harness failed: {payload}")
    return [IsolatedResult(solved, passed, failed, outcome, error)
            for solved, passed, failed, outcome, error in payload]


def _child(queue, problem: dict, source: str, memory_mb: int, cpu_seconds: int) -> None:
    _apply_rlimits(memory_mb, cpu_seconds)
    # Generated code prints. Left to the child's own stdout rather than captured, because
    # swallowing it here would also swallow a genuine traceback during debugging; callers that
    # care redirect at the process level.
    try:
        from reward.grader import grade

        verdict = grade(problem, source)
        queue.put(("ok", bool(verdict.solved), list(verdict.passed), list(verdict.failed),
                   verdict.outcome, verdict.error))
    except BaseException as exc:
        queue.put(("harness_error", False, [], [], "harness_error", f"{type(exc).__name__}: {exc}"))


def run_isolated(
    problem: dict[str, Any],
    source: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    memory_mb: int = DEFAULT_MEMORY_MB,
) -> IsolatedResult:
    """Grade ``source`` in a subprocess, killing it after ``timeout_s``.

    A timeout is a *result* — the submission scored zero — not an error, because to a reward
    function "did not terminate" and "returned the wrong answer" are the same thing.
    """
    # **spawn, always — never fork.** A CUDA context does not survive fork(), and the caller here
    # is a training loop with a model resident on the GPU. Forking from that state gave a child
    # that died with MemoryError, which this function then reported as a timeout and scored zero.
    # Every completion in the first isolated pass-rate run failed that way, turning a working
    # sandbox into a machine for producing zeros. spawn re-execs a clean interpreter and costs
    # roughly a second per call, which is the correct price for the result being real.
    ctx = _grading_context()
    queue = ctx.Queue()
    proc = _start_child(ctx, _child,
                        (queue, problem, source, memory_mb, int(timeout_s) + 1))
    proc.join(timeout_s)

    if proc.is_alive():
        proc.terminate()
        proc.join(2.0)
        if proc.is_alive():          # ignored SIGTERM; a tight C loop can
            proc.kill()
            proc.join(2.0)
        return IsolatedResult(False, [], [], "timeout",
                              f"exceeded {timeout_s}s wall clock")

    if queue.empty():
        # Killed by an rlimit, or died without reporting. Still a zero, not a crash.
        return IsolatedResult(False, [], [], "died",
                              f"child exited with code {proc.exitcode} and no result")

    kind, solved, passed, failed, outcome, error = queue.get()
    if kind == "harness_error":
        # A bug in this repository, not a bad submission. Surfaced rather than scored, because
        # scoring it zero is exactly how the base pass-rate run reported 0/4 on solved problems.
        raise RuntimeError(f"grading harness failed: {error}")
    return IsolatedResult(solved, passed, failed, outcome, error)
