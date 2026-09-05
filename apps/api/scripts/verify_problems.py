"""
Prove every problem's expected output by running a reference solution.

    cd apps/api
    python -m scripts.verify_problems

This is the test that makes the content trustworthy. For each problem it
composes `REFERENCE_SOLUTIONS[slug]` with that problem's `driver_code` — the
same concatenation the execution router performs before sending source to
Judge0 — feeds it each test case's `stdin`, and asserts stdout matches
`expected_output` byte for byte.

WHY THIS EXISTS RATHER THAN A HAND-CHECKED TABLE

Five of the eight problems return floats. Judge0 compares stdout as a plain
string, so `0.09003057317038046` and `0.090031` are a wrong answer, and an
expectation typed from a calculator is a test case that passes for its author
and fails for everyone else. Running the reference is the only way to know the
expectation is reachable.

It doubles as a regression test for the drivers, which nothing else exercises:
a driver that reads `_in[2]` when the test case only supplies two lines fails
loudly here instead of in front of a user.

It also checks properties a string comparison cannot — that softmax rows sum to
1, that hidden cases exist, that slugs and order_index values are unique — so a
copy-paste slip in the content module is caught at author time.

NOTE: this runs the reference solutions with the local interpreter, not inside
Judge0's sandbox. It proves the expectations and the drivers are correct; it
does not prove Judge0 is reachable. Run the app for that.
"""

import ast
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Content comes from the one-file-per-item loader. reference_solution now lives ON each
# item rather than in a side dict, which is what stopped the migration losing all 50 of
# them: an item and its answer can no longer drift into separate files.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from features.content import by_kind

# Only test-graded items. Rubric-graded ones (CUDA kernels, ML systems design) carry no
# reference solution or test cases by design — V5 descoped the GPU sandbox, so they are
# graded by a human or a judge. Running them through this verifier would report every one
# as "no reference solution", which is a true statement about a false expectation.
_ALL = by_kind("problem")
PROBLEMS = [p for p in _ALL if p.get("grading", "tests") != "rubric"]
_RUBRIC = [p for p in _ALL if p.get("grading") == "rubric"]
REFERENCE_SOLUTIONS = {p["slug"]: p["reference_solution"]
                       for p in PROBLEMS if p.get("reference_solution")}

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def run_case(source: str, stdin: str) -> tuple[bool, str]:
    """Execute composed source against one stdin. Returns (ok, stdout-or-error)."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", source],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT"
    if proc.returncode != 0:
        tail = proc.stderr.strip().splitlines()
        return False, tail[-1] if tail else "non-zero exit, no stderr"
    return True, proc.stdout.strip()


def main() -> int:
    failures: list[str] = []
    checked = 0

    # ── Structural checks the string comparison cannot make ──────────────
    slugs = [p["slug"] for p in PROBLEMS]
    if len(set(slugs)) != len(slugs):
        failures.append("duplicate slug in PROBLEMS")
    orders = [p["order_index"] for p in PROBLEMS if p.get("order_index") is not None]
    if sorted(orders) != list(range(1, len(orders) + 1)):
        failures.append(f"order_index must be 1..{len(PROBLEMS)} with no gaps, got {sorted(orders)}")
    missing_ref = set(slugs) - set(REFERENCE_SOLUTIONS)
    if missing_ref:
        failures.append(f"no reference solution for: {sorted(missing_ref)}")

    for problem in PROBLEMS:
        slug = problem["slug"]
        print(f"\n{slug}  {DIM}{problem['difficulty']}{RESET}")

        if slug not in REFERENCE_SOLUTIONS:
            print(f"  {RED}no reference solution{RESET}")
            continue

        templates = problem["code_templates"]
        if len(templates) != 1 or templates[0]["language"] != "Python":
            failures.append(f"{slug}: expected exactly one Python template")
        driver = templates[0]["driver_code"]
        source = REFERENCE_SOLUTIONS[slug] + "\n" + driver

        cases = problem["test_cases"]
        if not any(c["is_hidden"] for c in cases):
            failures.append(f"{slug}: no hidden test case")
        if sorted(c["order_index"] for c in cases) != list(range(len(cases))):
            failures.append(f"{slug}: test-case order_index must be 0..n-1")

        for case in cases:
            checked += 1
            ok, got = run_case(source, case["stdin"])
            want = case["expected_output"]
            tag = "hidden" if case["is_hidden"] else "visible"

            if ok and got == want:
                print(f"  {GREEN}pass{RESET}  {case['label']:<10} {DIM}{tag}{RESET}  {got}")
            else:
                print(f"  {RED}FAIL{RESET}  {case['label']:<10} {DIM}{tag}{RESET}")
                print(f"        stdin    {case['stdin']!r}")
                print(f"        expected {want!r}")
                print(f"        actual   {got!r}")
                failures.append(f"{slug}/{case['label']}")

        # Softmax must produce a distribution. A stable implementation that
        # returns garbage in the right format would pass the string comparison
        # for a crafted expectation but fail this.
        if slug == "stable-softmax":
            for case in cases:
                ok, got = run_case(source, case["stdin"])
                if ok:
                    total = sum(ast.literal_eval(got))
                    if abs(total - 1.0) > 1e-5:
                        failures.append(f"{slug}/{case['label']}: probabilities sum to {total}")

    print(f"\n{'-' * 60}")
    if failures:
        print(f"{RED}{len(failures)} failure(s){RESET} across {checked} case(s):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(f"{GREEN}All {checked} test cases across {len(PROBLEMS)} problems verified.{RESET}")
    print(f"{DIM}Every expected_output is reproducible from its reference solution.{RESET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
