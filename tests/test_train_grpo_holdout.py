"""The in-domain holdout, which decides what a flat eval curve is allowed to mean.

Worth testing rather than eyeballing on a pod: the 30B run cost hours of rented A40 time and came
back with `greedy_solved` flat at 18/60, and the run as built could not distinguish "GRPO learned
nothing" from "GRPO learned something that does not transfer". `evaluate_holdout` exists to separate
those two, so a bug in it would substitute one unfalsifiable run for another.

Everything here runs in a SUBPROCESS. `scripts/train_grpo.py` imports `scripts.base_pass_rate`, and
two `scripts` packages exist in this repo (root and apps/api) — whichever is imported first wins for
the whole pytest session. Importing the trainer in-process broke three unrelated tests the last time
that was tried (see the note in tests/test_rl_eval.py).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def run_in_subprocess(body: str) -> dict:
    """Execute `body` against the trainer and return whatever it prints as JSON on the last line."""
    script = (
        "import sys, json\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        + body
    )
    out = subprocess.run([sys.executable, "-c", script],
                         capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        pytest.fail(f"subprocess failed:\n{out.stdout}\n{out.stderr}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_holdout_split_is_disjoint_deterministic_and_not_a_tail_slice():
    """Disjointness is the correctness property; the shuffle is the one that makes it in-domain."""
    result = run_in_subprocess(
        "from scripts.train_grpo import split_holdout\n"
        "band = [{'id': f'{src}-{i}', 'source': src}\n"
        "        for src, n in (('primeintellect', 90), ('lcbv5', 6), ('codeforces', 4))\n"
        "        for i in range(n)]\n"
        "train, held = split_holdout(band, 20, seed=7)\n"
        "again, held2 = split_holdout(band, 20, seed=7)\n"
        "other, held3 = split_holdout(band, 20, seed=8)\n"
        "ids = lambda xs: [x['id'] for x in xs]\n"
        "print(json.dumps({\n"
        "    'n_train': len(train), 'n_held': len(held),\n"
        "    'overlap': len(set(ids(train)) & set(ids(held))),\n"
        "    'covers_band': sorted(ids(train) + ids(held)) == sorted(ids(band)),\n"
        "    'deterministic': ids(held) == ids(held2),\n"
        "    'seed_matters': ids(held) != ids(held3),\n"
        "    'sources_held': sorted({x['source'] for x in held}),\n"
        "    'tail_slice': ids(held) == ids(band[-20:]),\n"
        "    'order_preserved': ids(held) == [i for i in ids(band) if i in set(ids(held))],\n"
        "}))\n"
    )
    assert result["n_train"] == 80 and result["n_held"] == 20
    assert result["overlap"] == 0, "a held-out problem was also trained on"
    assert result["covers_band"], "the split lost or duplicated problems"
    assert result["deterministic"], "same seed must reproduce the same split"
    assert result["seed_matters"]
    assert not result["tail_slice"], "an unshuffled tail would hold out one source, not a sample"
    # 20 of 100 drawn at random cannot plausibly miss the 90-problem source; the small ones may be
    # missed by chance, so only the dominant one is asserted.
    assert "primeintellect" in result["sources_held"]
    assert result["order_preserved"], "corpus order should survive the selection"


def test_holdout_split_off_by_default():
    result = run_in_subprocess(
        "from scripts.train_grpo import split_holdout\n"
        "band = [{'id': str(i)} for i in range(5)]\n"
        "train, held = split_holdout(band, 0, seed=1)\n"
        "print(json.dumps({'n_train': len(train), 'n_held': len(held)}))\n"
    )
    assert result == {"n_train": 5, "n_held": 0}


def test_evaluate_holdout_grades_through_the_stdio_path_the_reward_uses():
    """One solvable problem, one group of {correct, wrong}, greedy correct.

    Pins the arithmetic AND the plumbing: a wrong grading path here would score the correct
    submission zero, which is exactly the failure that made the first 30B eval read all-zero.
    """
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        "GOOD = '```python\\na, b = map(int, input().split())\\nprint(a + b)\\n```'\n"
        "BAD  = '```python\\nprint(0)\\n```'\n"
        "class FakeEngine:\n"
        "    def generate(self, tok, prompt, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [GOOD] if greedy else [GOOD, BAD][:group]\n"
        "problems = [{'id': 'sum', 'prompt': 'add two numbers',\n"
        "             'tests': [{'input': '2 3\\n', 'output': '5\\n'},\n"
        "                       {'input': '10 -3\\n', 'output': '7\\n'}]}]\n"
        "m = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                     timeout_s=30.0, engine=FakeEngine())\n"
        "print(json.dumps(m))\n"
    )
    assert result["holdout_problems"] == 1
    # GOOD passes both cases (1.0), BAD passes neither (0.0).
    assert result["holdout_mean_case_fraction"] == pytest.approx(0.5)
    assert result["holdout_solved_any"] == 1, "the group contained a fully correct solution"
    assert result["holdout_greedy_solved"] == 1
    assert result["holdout_greedy_case_fraction"] == pytest.approx(1.0)


def test_evaluate_holdout_reports_zero_rather_than_crashing_on_a_dead_group():
    """A group where nothing works must still produce a row; a crash here would kill a 50-step run."""
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        "BAD = '```python\\nprint(0)\\n```'\n"
        "class FakeEngine:\n"
        "    def generate(self, tok, prompt, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [BAD] * (1 if greedy else group)\n"
        "problems = [{'id': 'sum', 'prompt': 'add two numbers',\n"
        "             'tests': [{'input': '2 3\\n', 'output': '5\\n'}]}]\n"
        "m = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                     timeout_s=30.0, engine=FakeEngine())\n"
        "print(json.dumps(m))\n"
    )
    assert result["holdout_solved_any"] == 0
    assert result["holdout_greedy_solved"] == 0
    assert result["holdout_mean_case_fraction"] == 0.0
