"""Every name in `src/` resolves. A lint gate, in the test suite, on purpose.

WHY THIS EXISTS

A fleet-slot lease was threaded through six `_release_slot` call sites by editing each to read
`lease=slot_lease`. One of those six is inside `_semaphore_wrapped`, a module-level function where
`slot_lease` is a local of the request handler and simply does not exist. Every streaming request
would have raised `NameError` in the `finally` that releases its slot and settles its credit.

**419 tests passed.** They could not have caught it: nothing in the suite drives that generator,
because doing so means a live model, which is the one thing `conftest.py` refuses to depend on. The
bug was invisible to every test and to a careful reading, and `ruff --select F821` found it in under
a second.

WHY IT IS A TEST AND NOT ONLY A CI STEP

CI runs on push. A test runs while the change is being made, which is when the information is worth
having — and this project has repeatedly shipped configuration and wiring that was never executed.
The failure mode being guarded is precisely "the code is never run, so nothing notices".

The rule scope is deliberately narrow: F821 only. This is not a style gate and should not grow into
one. It answers a single question -- does every name resolve -- which is the question the test suite
structurally cannot answer for any module it declines to import.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"


def _ruff_available() -> bool:
    if shutil.which("ruff"):
        return True
    probe = subprocess.run(
        [sys.executable, "-m", "ruff", "--version"], capture_output=True, text=True
    )
    return probe.returncode == 0


@pytest.mark.skipif(not _ruff_available(), reason="ruff is not installed")
def test_no_undefined_names_anywhere_in_src():
    """F821, across every module, including the ones the suite will not import."""
    result = subprocess.run(
        [sys.executable, "-m", "ruff", "check", str(SRC), "--select", "F821", "--no-cache"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        "a name in src/ does not resolve. This is the check that would have caught "
        "`lease=slot_lease` inside `_semaphore_wrapped`, where the whole suite could not:\n\n"
        + (result.stdout or result.stderr)
    )


@pytest.mark.skipif(not _ruff_available(), reason="ruff is not installed")
def test_the_gate_actually_fails_on_an_undefined_name(tmp_path):
    """Guards the guard.

    A subprocess check that silently stopped running -- a renamed rule, a changed exit code, a ruff
    that is present but broken -- would pass forever while checking nothing. So the same invocation
    is pointed at a file that definitely has the defect, and must reject it.
    """
    bad = tmp_path / "definitely_broken.py"
    bad.write_text("def f():\n    return not_a_real_name\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-m", "ruff", "check", str(bad), "--select", "F821", "--no-cache"],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, "the lint gate no longer detects an undefined name"
    assert "F821" in result.stdout
