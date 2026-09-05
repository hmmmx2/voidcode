"""Do an item's test cases actually catch the mistakes the problem is about?

Run:  python scripts/authoring/mutation_check.py

Point it at an item by editing MUTANTS below - each entry is a plausible WRONG solution, and every
one of them must fail at least one case. `verify_problems` proves the expected values are
reproducible from the reference; it cannot tell you whether a learner who misunderstood the problem
would also pass.

It earned its place immediately. `clip-contrastive-loss` is tagged `numerical_stability`, its
description warns that a raw exp overflows, and its hints say to subtract the row max - and a
solution that skipped the max subtraction passed every case. Cosine similarities live in [-1, 1],
so at the temperature of 0.07 the problem used, the logits only reach ~13 and nothing overflows.
The claim was untested. A case at temperature 0.001, where CLIP's learned temperature can
plausibly land, drives the logits to ~900 and kills it.

A case set that only the correct answer passes is the claim; a case set every plausible wrong
answer also passes is a problem that teaches nothing and marks everyone correct.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")
import yaml

doc = yaml.safe_load(Path("content/problems/clip-contrastive-loss.yaml").read_text(encoding="utf-8"))
driver = doc["code_templates"][0]["driver_code"]
cases = doc["test_cases"]

MUTANTS = {
    "rows only (one direction)": '''import math
class Solution(object):
    def clip_loss(self, sims, temperature):
        n = len(sims)
        logits = [[s / temperature for s in row] for row in sims]
        total = 0.0
        for i, row in enumerate(logits):
            top = max(row)
            total += top + math.log(sum(math.exp(v - top) for v in row)) - row[i]
        return round(total / n, 4)
''',
    "ignores temperature": '''import math
class Solution(object):
    def clip_loss(self, sims, temperature):
        n = len(sims)
        logits = [list(row) for row in sims]
        def ce(rows):
            t = 0.0
            for i, row in enumerate(rows):
                top = max(row)
                t += top + math.log(sum(math.exp(v - top) for v in row)) - row[i]
            return t / len(rows)
        cols = [[logits[r][c] for r in range(n)] for c in range(n)]
        return round((ce(logits) + ce(cols)) / 2, 4)
''',
    "no max subtraction": '''import math
class Solution(object):
    def clip_loss(self, sims, temperature):
        n = len(sims)
        logits = [[s / temperature for s in row] for row in sims]
        def ce(rows):
            t = 0.0
            for i, row in enumerate(rows):
                t += math.log(sum(math.exp(v) for v in row)) - row[i]
            return t / len(rows)
        cols = [[logits[r][c] for r in range(n)] for c in range(n)]
        return round((ce(logits) + ce(cols)) / 2, 4)
''',
    "sums instead of averaging directions": '''import math
class Solution(object):
    def clip_loss(self, sims, temperature):
        n = len(sims)
        logits = [[s / temperature for s in row] for row in sims]
        def ce(rows):
            t = 0.0
            for i, row in enumerate(rows):
                top = max(row)
                t += top + math.log(sum(math.exp(v - top) for v in row)) - row[i]
            return t / len(rows)
        cols = [[logits[r][c] for r in range(n)] for c in range(n)]
        return round(ce(logits) + ce(cols), 4)
''',
}


def run(source, stdin):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(source)
        path = fh.name
    p = subprocess.run([sys.executable, path], input=stdin, capture_output=True, text=True, timeout=15)
    return (p.stdout.strip() if p.returncode == 0 else f"<error: {p.stderr.strip().splitlines()[-1][:60]}>")


# The reference must pass, or a "kill" below means nothing.
for c in cases:
    got = run(doc["reference_solution"] + "\n" + driver, c["stdin"])
    assert got == c["expected_output"], f"reference disagrees on {c['label']}: {got}"
print("reference passes all cases\n")

survivors = []
for name, src in MUTANTS.items():
    killed_by = []
    for c in cases:
        if run(src + "\n" + driver, c["stdin"]) != c["expected_output"]:
            killed_by.append(c["label"])
    if killed_by:
        print(f"  KILLED  {name:38} by {', '.join(killed_by)}")
    else:
        print(f"  SURVIVED {name:37} <-- the cases do not test this")
        survivors.append(name)

print()
print(f"{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} mutants killed")
raise SystemExit(1 if survivors else 0)
