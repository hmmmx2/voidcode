"""Break the grader on purpose and confirm the differential test notices.

A grader whose own test suite cannot detect a broken grader is decoration. Each mutant below is a
plausible mistake someone could make porting `bootstrap.py`, not a random edit — the negative-zero
collapse and the `.tolist()` call in particular exist in the original because something went wrong
without them, and this asserts that removing them is now caught rather than rediscovered.

    python tests/mutate_grader.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRADER = ROOT / "reward" / "grader.py"

MUTANTS: list[tuple[str, str, str]] = [
    (
        "rounding is dropped, so float64 noise decides the verdict",
        "        rounded = round(value, places)\n        return 0.0 if rounded == 0 else rounded",
        "        return value",
    ),
    (
        "negative zero is no longer collapsed",
        "        return 0.0 if rounded == 0 else rounded",
        "        return rounded",
    ),
    (
        "numpy arrays are compared as arrays, not as lists",
        "    tolist = getattr(value, \"tolist\", None)\n    if callable(tolist):\n        value = tolist()",
        "    pass",
    ),
    (
        "the normalise expression is ignored",
        "            if normalise_fn is not None:\n                value = normalise_fn(value)",
        "            pass",
    ),
    (
        "normalise runs in the exercise's namespace, so a learner can redefine json",
        '    namespace: dict[str, Any] = {"json": json}',
        "    namespace: dict[str, Any] = {}",
    ),
    (
        "rounding to 6 places instead of 8",
        "ROUND_PLACES = 8",
        "ROUND_PLACES = 6",
    ),
    (
        "hidden cases are skipped when grading",
        "    for case in cases:",
        "    for case in [c for c in cases if c.get('visible', True)]:",
    ),
    (
        "a raised exception counts as a pass",
        "        if got is not None and got.ok and got.repr_ == wanted.repr_:",
        "        if got is not None and got.repr_ == wanted.repr_ or (got is not None and not got.ok):",
    ),
    (
        "everything passes",
        "        if got is not None and got.ok and got.repr_ == wanted.repr_:",
        "        if True:",
    ),
    (
        "a missing entry point is graded as ran",
        '        return RunOutcome(outcome="missing_entry", error=f"No function named `{entry}` was defined.")',
        '        return RunOutcome(outcome="ran", cases=[])',
    ),
]


def main() -> int:
    original = GRADER.read_text(encoding="utf-8")
    survivors: list[str] = []

    for name, before, after in MUTANTS:
        if before not in original:
            print(f"?? SKIP   {name}")
            continue

        GRADER.write_text(original.replace(before, after, 1), encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "pytest", "tests/test_differential.py", "-q", "--no-header"],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
        finally:
            GRADER.write_text(original, encoding="utf-8")

        if proc.returncode != 0:
            line = next(
                (ln for ln in proc.stdout.splitlines() if ln.startswith("FAILED")),
                "(failed)",
            )
            print(f"KILLED   {name}\n           {line[:110]}")
        else:
            survivors.append(name)
            print(f"SURVIVED {name}")

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    if survivors:
        print("survivors:\n  " + "\n  ".join(survivors))
    return 1 if survivors else 0


if __name__ == "__main__":
    raise SystemExit(main())
