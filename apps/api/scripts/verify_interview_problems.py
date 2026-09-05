"""
Derive and check every expected_output in the interview problem bank.

    python -m scripts.verify_interview_problems            # check
    python -m scripts.verify_interview_problems --write    # fill them in

Same job as `verify_problems.py`, and deliberately the same method: compose the
reference solution with the driver exactly as the client does
(`buildExecutableCode` is `userCode + "\\n" + driverCode`), run it on each case's
stdin, and compare stdout byte-for-byte.

`--write` is the difference. The catalogue's expectations were transcribed by
hand and then checked; these are *generated*, because at forty questions and
~160 cases a human transcribing float output will get one wrong, and a wrong
expectation fails a correct answer — the worst failure mode a grader has.

Runs on the local interpreter rather than Judge0. That is a real gap: it proves
the expectation matches the reference, not that the code runs in the sandbox.
The `--sandbox-check` pass narrows it by rejecting imports the Judge0 image does
not have.
"""

import ast
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from features.content import by_kind

# Keyed the way the original dict was - by the un-prefixed key, not the slug. The two
# differ (`implement-auc` vs `iq-implement-auc`) and that mismatch already cost 38
# reference solutions once; keeping the original keying here means this verifier reports
# the same identifiers it always did.
_ITEMS = by_kind("interview_problem")
INTERVIEW_PROBLEMS = {p["slug"].removeprefix("iq-"): p for p in _ITEMS}
INTERVIEW_REFERENCE_SOLUTIONS = {p["slug"].removeprefix("iq-"): p["reference_solution"]
                                 for p in _ITEMS if p.get("reference_solution")}

# Judge0's python:3 image ships the standard library and nothing else. Catching
# this here rather than at submit time is the difference between an authoring
# error and a question that is broken for every user who opens it.
BANNED_IMPORTS = {
    "numpy", "np", "torch", "sklearn", "scipy", "pandas", "tensorflow",
    "jax", "cupy", "numba", "matplotlib",
}


def run_case(source: str, stdin: str) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            [sys.executable, "-c", source],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return False, "<timeout>"
    if proc.returncode != 0:
        return False, (proc.stderr or "").strip()
    return True, proc.stdout.strip()


def banned_imports_in(source: str) -> list[str]:
    """Module names the Judge0 sandbox cannot provide."""
    found: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"<syntax error: {exc}>"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in BANNED_IMPORTS:
                    found.append(root)
        elif isinstance(node, ast.ImportFrom) and node.module:
            root = node.module.split(".")[0]
            if root in BANNED_IMPORTS:
                found.append(root)
    return found


def main() -> None:
    write = "--write" in sys.argv
    failures: list[str] = []
    changed = 0
    checked = 0

    for key, problem in INTERVIEW_PROBLEMS.items():
        reference = INTERVIEW_REFERENCE_SOLUTIONS.get(key)
        if not reference:
            failures.append(f"{key}: no reference solution")
            continue

        templates = [
            t for t in problem["code_templates"] if t["language"] == "Python"
        ]
        if len(templates) != 1:
            failures.append(f"{key}: expected exactly one Python template")
            continue
        driver = templates[0]["driver_code"]

        for source, label in ((reference, "reference"), (driver, "driver")):
            banned = banned_imports_in(source)
            if banned:
                failures.append(
                    f"{key}: {label} imports {sorted(set(banned))}, "
                    "which Judge0 does not have"
                )

        cases = problem["test_cases"]
        if not any(c["is_hidden"] for c in cases):
            failures.append(f"{key}: no hidden test case")
        indices = sorted(c["order_index"] for c in cases)
        if indices != list(range(len(cases))):
            failures.append(f"{key}: order_index must be 0..n-1, got {indices}")

        source = reference + "\n" + driver
        for case in cases:
            checked += 1
            ok, got = run_case(source, case["stdin"])
            if not ok:
                failures.append(f"{key} / {case['label']}: reference failed -- {got}")
                continue

            want = case["expected_output"]
            if write:
                if want != got:
                    case["expected_output"] = got
                    changed += 1
            elif want != got:
                failures.append(
                    f"{key} / {case['label']}: expected {want!r}, reference gives {got!r}"
                )

    if write and changed:
        _rewrite(changed)

    print(f"checked {checked} case(s) across {len(INTERVIEW_PROBLEMS)} question(s)")
    if failures:
        print(f"\nFAILED with {len(failures)} problem(s):")
        for failure in failures:
            print(f"  - {failure}")
        sys.exit(1)
    print("all expectations match the reference solutions")


def _rewrite(changed: int) -> None:
    """
    Emit derived expectations for the author to paste in.

    Deliberately does NOT rewrite the source file. A script that edits the file
    holding the answers, using output it generated itself, removes the one
    review step that would catch a reference solution which is confidently
    wrong. Printing keeps a human in the loop for the ~30 seconds it costs.
    """
    out = {
        key: {c["label"]: c["expected_output"] for c in p["test_cases"]}
        for key, p in INTERVIEW_PROBLEMS.items()
    }
    path = Path(__file__).with_name("derived_expectations.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"derived {changed} expectation(s) -> {path.name}")


if __name__ == "__main__":
    main()
