"""Scaffold a correctly-shaped catalog item.

Run:  python scripts/new_item.py <slug> --concepts a,b --title "..." [--method name] [--category DL]

Replaces `apps/api/scripts/merge_authored.py`, which merged authored JSON into the five content
scripts that no longer exist.

WHY A GENERATOR RATHER THAN A TEMPLATE FILE
----------------------------------------------
The first three items authored by hand needed **four** corrections, and none was caught by review
or by the 79 unit tests — every one surfaced from running `verify_problems`, a KeyError at a time:

  1. `code_templates` must be a LIST of {language, judge0_language_id, template_code, driver_code}.
     A dict of module-level functions cannot be executed by Judge0 and presents as every
     submission failing, not as a broken problem.
  2. Test cases need `order_index`, contiguous from 0.
  3. Case fields are `stdin` / `expected_output` / `label`, not `input` / `output`.
  4. Three of eight expected values were simply wrong.

The loader now rejects 1-3 at load. This script prevents them being written in the first place, and
`--verify` addresses 4 by executing the reference against the cases before the file is trusted —
because a wrong expectation tells a learner their correct answer is wrong, which is worse than a
missing question.

WHAT IT DELIBERATELY DOES NOT DO
-----------------------------------
It does not write the description, the reference solution, or the expected outputs. Those are the
authoring judgement, and a generator that guesses them would produce plausible content nobody
checked — the two-quality-tier failure V1 exists to end. It writes the scaffold and the `TODO`s.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OUT = ROOT / "content" / "problems"


def scaffold(slug: str, title: str, concepts: list[str], category: str, method: str,
             difficulty: str) -> dict:
    return {
        "slug": slug,
        "title": title,
        "difficulty": difficulty,
        "categories": [category],
        "concepts": concepts,
        "description": "TODO: state the problem. Say what makes it non-obvious, not just what to "
                       "compute — the question is the teaching.",
        # False, because these were chosen by whoever ran this script rather than inferred by the
        # migration's keyword rules. Set review_needed true again if you are unsure.
        "inferred_concepts": False,
        "review_needed": False,
        "source_kind": "problem",
        "order_index": next_order_index(),
        "code_templates": [{
            "language": "Python",
            "judge0_language_id": 71,
            "template_code": (
                f"class Solution(object):\n"
                f"    def {method}(self, TODO):\n"
                f'        """\n'
                f"        :type TODO:\n"
                f"        :rtype:\n"
                f'        """\n'
            ),
            # The piece most easily forgotten, and the one whose absence is least visible: without
            # it Judge0 runs a file that defines a class and does nothing, and empty output reads
            # as a wrong answer.
            "driver_code": (
                "import sys\n"
                "_in = sys.stdin.read()\n"
                f"print(Solution().{method}(TODO))\n"
            ),
        }],
        "reference_solution": (
            f"class Solution(object):\n"
            f"    def {method}(self, TODO):\n"
            f"        raise NotImplementedError  # TODO\n"
        ),
        "test_cases": [
            {"label": "Case 1", "order_index": 0, "inputs": [], "stdin": "TODO",
             "expected_output": "TODO", "is_hidden": False},
            {"label": "Case 2", "order_index": 1, "inputs": [], "stdin": "TODO",
             "expected_output": "TODO", "is_hidden": False},
            {"label": "Hidden 1", "order_index": 2, "inputs": [], "stdin": "TODO",
             "expected_output": "TODO", "is_hidden": True},
        ],
        "hints": ["TODO"],
    }


def next_order_index() -> int:
    """One past the highest existing problem, so the contiguity check the verifier makes holds."""
    from features.content import by_kind

    used = [r.get("order_index") or 0 for r in by_kind("problem")]
    return max(used, default=0) + 1


def verify_expectations(item: dict) -> int:
    """Execute the reference against every case. Catches wrong expected values before anyone
    trusts them — which is the failure that survived review on the first three hand-written items.
    """
    template = item["code_templates"][0]
    source = item["reference_solution"] + "\n" + template["driver_code"]
    failures = 0
    for case in item["test_cases"]:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
            fh.write(source)
            path = fh.name
        proc = subprocess.run([sys.executable, path], input=case["stdin"],
                              capture_output=True, text=True, timeout=15)
        got = proc.stdout.strip()
        want = str(case["expected_output"]).strip()
        if got != want:
            failures += 1
            print(f"  FAIL {case['label']}: stdin={case['stdin']!r} "
                  f"expected={want!r} actual={got!r}"
                  + (f"  stderr={proc.stderr.strip()[:120]!r}" if proc.stderr.strip() else ""))
        else:
            print(f"  pass {case['label']}")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--title", default="")
    ap.add_argument("--concepts", required=True, help="comma-separated taxonomy concept ids")
    ap.add_argument("--category", default="Systems")
    ap.add_argument("--method", default="solve")
    ap.add_argument("--difficulty", default="medium", choices=("easy", "medium", "hard"))
    ap.add_argument("--verify", action="store_true",
                    help="execute an EXISTING item's reference against its cases and exit")
    args = ap.parse_args()

    path = OUT / f"{args.slug}.yaml"

    if args.verify:
        if not path.exists():
            print(f"no such item: {path}")
            return 1
        item = yaml.safe_load(path.read_text(encoding="utf-8"))
        failures = verify_expectations(item)
        print(f"\n{failures} failure(s)" if failures else "\nall expectations reproduce")
        return 1 if failures else 0

    if path.exists():
        print(f"{path.name} already exists — refusing to overwrite authored content")
        return 1

    from features.taxonomy import load_taxonomy

    concepts = [c.strip() for c in args.concepts.split(",") if c.strip()]
    valid = set(load_taxonomy().concepts)
    unknown = [c for c in concepts if c not in valid]
    if unknown:
        # Fail here rather than at load: a typo'd concept drops the item out of ranking and course
        # assembly silently, and the author is the only person who knows what was meant.
        print(f"unknown concepts: {unknown}")
        return 1

    item = scaffold(args.slug, args.title or args.slug.replace("-", " ").title(),
                    concepts, args.category, args.method, args.difficulty)
    OUT.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(item, sort_keys=False, allow_unicode=True, width=100),
                    encoding="utf-8")
    print(f"wrote {path}")
    print("Fill in every TODO, then:")
    print(f"  python scripts/new_item.py {args.slug} --verify")
    print("  cd apps/api && python -m scripts.verify_problems")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
