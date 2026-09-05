"""Build a catalog item from a spec, and refuse to write it unless it earns its place.

Used by the item specs in `scripts/authoring/items/`. Run one with:

    python scripts/authoring/build_item.py <spec_module>        # check only
    python scripts/authoring/build_item.py <spec_module> --write

WHY A HARNESS INSTEAD OF WRITING YAML
----------------------------------------
Two rules produced every item that verified first time, and both are mechanical, so neither should
depend on the author remembering them.

**Expected values are computed, never typed.** Three of eight hand-written expectations were wrong
on the first authored items, and a wrong expectation tells a learner their correct answer is wrong
— worse than a missing question. Here they come from executing the reference.

**Every plausible wrong answer must fail a case.** Executing the reference proves the file agrees
with itself. It cannot tell you whether a learner who misunderstood the problem passes anyway. A
spec declares its own mutants and this refuses to write if one survives.

That check is not theoretical: `clip-contrastive-loss` was tagged `numerical_stability`, warned
about overflow, hinted at subtracting the row max — and a solution that skipped the subtraction
passed every case, because at the temperature it used nothing overflowed. The claim was decorative
until a mutant found it.

**And at least one value must be known independently.** A reference that is self-consistently wrong
passes both checks above. `checks` in a spec is a list of (case label, expected) pairs derived from
the maths rather than from the code — log(2) for a uniform 2-way softmax, and so on.
"""
from __future__ import annotations

import argparse
import importlib
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

OUT = ROOT / "content" / "problems"


def _run(source: str, stdin: str) -> tuple[str, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(source)
        path = fh.name
    proc = subprocess.run([sys.executable, path], input=stdin, capture_output=True, text=True,
                          timeout=20)
    return proc.stdout.strip(), proc.stderr.strip()


def build(spec) -> tuple[dict, list[str]]:
    """Returns the item and a list of problems with it. Empty list means it may be written."""
    problems: list[str] = []
    reference = spec.REFERENCE + "\n" + spec.DRIVER

    cases = []
    for i, (label, stdin, hidden) in enumerate(spec.CASES):
        out, err = _run(reference, stdin)
        if err and not out:
            problems.append(f"reference crashed on {label}: {err.splitlines()[-1][:100]}")
            out = "<crash>"
        print(f"  {label:10} -> {out}")
        cases.append({"label": label, "order_index": i, "inputs": [], "stdin": stdin,
                      "expected_output": out, "is_hidden": hidden})

    by_label = {c["label"]: c["expected_output"] for c in cases}

    # Values known from the maths, not from the code. Without at least one, a reference that is
    # wrong in a self-consistent way passes everything else here.
    if not getattr(spec, "CHECKS", None):
        problems.append("spec declares no independent CHECKS — every value would come from the "
                        "reference, so a self-consistently wrong reference would pass")
    for label, want in getattr(spec, "CHECKS", []):
        got = by_label.get(label)
        if got != want:
            problems.append(f"independent check failed on {label}: maths says {want!r}, "
                            f"reference produced {got!r}")
        else:
            print(f"  independent check: {label} == {want}")

    # Every plausible wrong solution must fail at least one case.
    survivors = []
    for name, mutant_src in spec.MUTANTS.items():
        # A mutant that cannot run is not a kill — it would "fail" every case for the wrong reason
        # and report false confidence in the case set.
        _, err = _run(mutant_src + "\n" + spec.DRIVER, spec.CASES[0][1])
        if err and "Error" in err and "Overflow" not in err and "Math" not in err:
            head = err.splitlines()[-1][:80]
            if any(t in head for t in ("SyntaxError", "NameError", "IndentationError")):
                problems.append(f"mutant {name!r} does not run ({head}) — it cannot kill anything")
                continue
        killed_by = [c["label"] for c in cases
                     if _run(mutant_src + "\n" + spec.DRIVER, c["stdin"])[0] != c["expected_output"]]
        if killed_by:
            print(f"  killed   {name:42} by {', '.join(killed_by)}")
        else:
            print(f"  SURVIVED {name:42} <- no case tests this")
            survivors.append(name)
    if survivors:
        problems.append(f"{len(survivors)} mutant(s) survived: {', '.join(survivors)}")

    from features.content import by_kind

    item = {
        "slug": spec.SLUG,
        "title": spec.TITLE,
        "difficulty": spec.DIFFICULTY,
        "categories": spec.CATEGORIES,
        "concepts": spec.CONCEPTS,
        "description": spec.DESCRIPTION,
        # Chosen by whoever wrote the spec, not inferred by the migration's keyword rules.
        "inferred_concepts": False,
        "review_needed": False,
        "source_kind": "problem",
        "order_index": max((r.get("order_index") or 0 for r in by_kind("problem")), default=0) + 1,
        "code_templates": [{"language": "Python", "judge0_language_id": 71,
                            "template_code": spec.TEMPLATE, "driver_code": spec.DRIVER}],
        "reference_solution": spec.REFERENCE,
        "test_cases": cases,
        "hints": spec.HINTS,
    }
    return item, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("spec", help="module under scripts.authoring.items, e.g. autograd_fanout")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    spec = importlib.import_module(f"scripts.authoring.items.{args.spec}")
    print(f"{spec.SLUG}")
    item, problems = build(spec)

    if problems:
        print("\nNOT WRITTEN:")
        for p in problems:
            print(f"  - {p}")
        return 1

    path = OUT / f"{spec.SLUG}.yaml"
    print(f"\n  all checks passed{' — writing' if args.write else ' (use --write)'}")
    if args.write:
        path.write_text(yaml.safe_dump(item, sort_keys=False, allow_unicode=True, width=100),
                        encoding="utf-8")
        print(f"  wrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
