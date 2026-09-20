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

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# CHECKED WITHOUT IMPORTING, which matters more here than it usually would: this module's entire
# premise is that the trainer is never imported in-process, and `pytest.importorskip("torch")`
# would pull a gigabyte-scale module into the pytest session to answer a question about a child.
# `find_spec` answers it for free.
#
# All nineteen tests below go through `run_in_subprocess`, and `scripts/train_grpo.py` imports torch
# at line 44 — so on `ci.yml`'s ML tree job, which does not install torch on purpose, every one of
# them failed with `subprocess failed:` and a `ModuleNotFoundError` from the CHILD. That reads like
# a broken harness rather than an absent dependency, and it is the difference between a suite that
# says "not applicable here" and one that says "nineteen things are wrong".
if importlib.util.find_spec("torch") is None:
    pytest.skip(
        "scripts/train_grpo.py imports torch in the subprocess these tests drive",
        allow_module_level=True,
    )


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
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [self.generate(tok, p, group, max_new, temperature, greedy, seed) for p in prompts]\n"
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
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [self.generate(tok, p, group, max_new, temperature, greedy, seed) for p in prompts]\n"
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


def test_required_context_measures_the_templated_prompt_not_the_bare_one():
    """Under-asking makes vLLM REJECT a request mid-run, hours in.

    Uses a stub tokenizer so this needs no model download: the template adds a fixed overhead and
    one token per 4 characters, which is enough to distinguish "measured the template" from
    "measured the raw string".
    """
    result = run_in_subprocess(
        "from scripts.train_grpo import required_context\n"
        "class StubTok:\n"
        "    OVERHEAD = 'X' * 400  # what a chat template prepends\n"
        "    def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=True):\n"
        "        return self.OVERHEAD + msgs[0]['content']\n"
        "    def __call__(self, text):\n"
        "        return {'input_ids': [0] * (len(text) // 4)}\n"
        "from scripts.train_grpo import build_prompt\n"
        "probs = [{'id': 'a', 'prompt': 'a' * 100}, {'id': 'b', 'prompt': 'b' * 1000}]\n"
        "need = required_context(probs, StubTok(), max_new=512)\n"
        # What sizing from the RAW problem text would have asked for -- the mistake under test.
        "bare = max(len(p['prompt']) // 4 for p in probs) + 512\n"
        # Derived, not hardcoded: the wrapper is build_prompt's instruction text plus the stub's\n"
        # 400-char template overhead, and getting that arithmetic wrong is not what this pins.
        "expected = (len(StubTok.OVERHEAD + build_prompt(probs[1]['prompt'])) // 4) + 512\n"
        "print(json.dumps({'need': need, 'bare_would_say': bare, 'expected': expected}))\n"
    )
    assert result["need"] == result["expected"], result
    # The whole point: the templated length is strictly larger, and sizing from the bare prompt
    # would under-ask -- vLLM would then reject that problem at generation time, mid-run.
    assert result["need"] > result["bare_would_say"], "template overhead must be counted"
    # Sized by the LONGEST problem, so the shorter one fits with room to spare.
    assert result["need"] >= 862


def test_required_context_never_removes_a_problem():
    """It reports a number. Discarding training data to fit a fixed context was the old design."""
    result = run_in_subprocess(
        "from scripts.train_grpo import required_context\n"
        "class StubTok:\n"
        "    def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=True):\n"
        "        return msgs[0]['content']\n"
        "    def __call__(self, text):\n"
        "        return {'input_ids': [0] * (len(text) // 4)}\n"
        "from scripts.train_grpo import build_prompt\n"
        "probs = [{'id': str(i), 'prompt': 'a' * (100 * (i + 1))} for i in range(5)]\n"
        "need = required_context(probs, StubTok(), max_new=8)\n"
        "expected = (len(build_prompt(probs[-1]['prompt'])) // 4) + 8\n"
        "print(json.dumps({'need': need, 'expected': expected, 'n_in': len(probs)}))\n"
    )
    # Sized by the LARGEST problem, so every one of the five fits. The list is returned untouched:
    # the function's contract is to report a number, never to remove a problem.
    assert result["need"] == result["expected"]
    assert result["n_in"] == 5


# ── a grading stall must not masquerade as a measurement ───────────────────────────────────────
#
# run_isolated_stdio_batch does NOT raise on a batch timeout: it returns one dead verdict per
# source, every one with case_fraction 0.0. Read through .case_fraction alone that is
# indistinguishable from "every completion scored the same" -- a dead group. dead_groups is the
# primary diagnostic of the G=16 run and the whole hypothesis is a prediction about it, so a stall
# inflating it would corrupt the one number the run exists to produce.

LOOP = "```python\nwhile True:\n    pass\n```"
GOOD_SUM = "```python\na, b = map(int, input().split())\nprint(a + b)\n```"
ZERO = "```python\nprint(0)\n```"
SUM_TESTS = [{"input": "2 3\n", "output": "5\n"}]
SUM_PROBLEM = {"id": "sum", "prompt": "add two numbers", "tests": SUM_TESTS}


def test_reward_for_group_skips_a_stalled_batch_instead_of_scoring_it_a_dead_group():
    result = run_in_subprocess(
        "from scripts.train_grpo import reward_for_group\n"
        f"LOOP = {LOOP!r}\n"
        f"GOOD = {GOOD_SUM!r}\n"
        "from scripts.train_grpo import extract_code\n"
        f"tests = {SUM_TESTS!r}\n"
        "r = reward_for_group([extract_code(GOOD), extract_code(LOOP)], tests, timeout_s=2.0)\n"
        "print(json.dumps({'rewards': r}))\n"
    )
    # [] means "skip this step". [0.0, 0.0] would have been counted as a dead group.
    assert result["rewards"] == [], (
        "a stalled batch was returned as all-zero rewards, which reward_for_group's caller "
        "counts as a dead group")


def test_holdout_greedy_survives_a_sampled_sibling_that_hangs():
    """greedy_solved is justified as 'cannot be sampling noise'. Shared-batch grading broke that."""
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        f"LOOP = {LOOP!r}\n"
        f"GOOD = {GOOD_SUM!r}\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [self.generate(tok, p, group, max_new, temperature, greedy, seed) for p in prompts]\n"
        "    def generate(self, tok, prompt, group, max_new, temperature, greedy=False, seed=None):\n"
        "        # greedy is CORRECT; one sampled sibling never terminates\n"
        "        return [GOOD] if greedy else [GOOD, LOOP][:group]\n"
        f"problems = [{SUM_PROBLEM!r}]\n"
        "m = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                     timeout_s=2.0, engine=FakeEngine())\n"
        "print(json.dumps(m))\n"
    )
    assert result["holdout_greedy_solved"] == 1, (
        "a hanging SAMPLE zeroed the deterministic greedy metric -- the exact defect the "
        "separate greedy child exists to prevent")
    assert result["holdout_greedy_case_fraction"] == pytest.approx(1.0)
    assert result["holdout_stalled"] >= 1, "the stall must be reported, not silently absorbed"


def test_holdout_se_is_clustered_over_problems_not_completions():
    """Two problems x 4 identical-within-problem scores: per-completion SE would be far smaller."""
    result = run_in_subprocess(
        "import torch, statistics\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        f"ALL = {GOOD_SUM!r}\n"
        f"NONE = {ZERO!r}\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [self.generate(tok, p, group, max_new, temperature, greedy, seed) for p in prompts]\n"
        "    def generate(self, tok, prompt, group, max_new, temperature, greedy=False, seed=None):\n"
        "        # problem A solved by every completion, problem B by none\n"
        "        src = ALL if 'AAA' in prompt else NONE\n"
        "        return [src] * (1 if greedy else group)\n"
        f"problems = [dict({SUM_PROBLEM!r}, id='a', prompt='AAA'),\n"
        f"            dict({SUM_PROBLEM!r}, id='b', prompt='BBB')]\n"
        "m = evaluate_holdout(None, None, problems, group=4, max_new=64, temperature=0.8,\n"
        "                     timeout_s=30.0, engine=FakeEngine())\n"
        "print(json.dumps(m))\n"
    )
    # Problem means are 1.0 and 0.0 -> SE over 2 problems = 0.5. A per-completion SE over the
    # 8 values (four 1.0s, four 0.0s) would be 0.5345/sqrt(8) = 0.189, i.e. 2.6x too small.
    assert result["holdout_mean_case_fraction"] == pytest.approx(0.5)
    assert result["holdout_case_fraction_se"] == pytest.approx(0.5, abs=0.01), (
        f"SE {result['holdout_case_fraction_se']} looks per-completion, not clustered")
    assert result["holdout_graded"] == 2


# ── batched generation must preserve prompt order ──────────────────────────────────────────────
#
# evaluate/evaluate_holdout and the batched training step all do
# `zip(problems, sampled, greedies, strict=True)`. `strict=True` catches a LENGTH mismatch but says
# nothing about ORDER, and a reordering would grade every group against a different problem's
# tests -- producing plausible numbers that are entirely wrong. vLLM documents input order, so this
# pins the contract rather than the implementation.


def test_generate_groups_returns_one_group_per_prompt_in_prompt_order():
    result = run_in_subprocess(
        "from scripts.train_grpo import generate_groups\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        # content derived from the prompt, so a reordering is detectable\n"
        "        return [[f'{p}#{i}' for i in range(group)] for p in prompts]\n"
        "prompts = ['alpha', 'beta', 'gamma']\n"
        "out = generate_groups(None, None, prompts, group=2, max_new=8, temperature=0.8,\n"
        "                      engine=FakeEngine())\n"
        "print(json.dumps({'n_groups': len(out), 'sizes': [len(g) for g in out], 'flat': out}))\n"
    )
    assert result["n_groups"] == 3, "one group per prompt"
    assert result["sizes"] == [2, 2, 2]
    assert result["flat"] == [["alpha#0", "alpha#1"], ["beta#0", "beta#1"], ["gamma#0", "gamma#1"]], (
        "batched generation reordered its outputs -- every group would be graded against the "
        "wrong problem's tests")


def test_generate_groups_is_one_engine_call_not_one_per_prompt():
    """The whole point: N prompts must reach the engine together so it can batch them."""
    result = run_in_subprocess(
        "from scripts.train_grpo import generate_groups\n"
        "class CountingEngine:\n"
        "    calls = 0\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        CountingEngine.calls += 1\n"
        "        return [['x'] * group for _ in prompts]\n"
        "e = CountingEngine()\n"
        "generate_groups(None, None, ['a','b','c','d'], group=4, max_new=8, temperature=0.8, engine=e)\n"
        "print(json.dumps({'calls': CountingEngine.calls}))\n"
    )
    assert result["calls"] == 1, f"{result['calls']} engine calls for 4 prompts; batching lost"


def test_generate_groups_handles_an_empty_batch():
    """A step whose batch is empty must not reach the engine at all."""
    result = run_in_subprocess(
        "from scripts.train_grpo import generate_groups\n"
        "class Boom:\n"
        "    def generate_many(self, *a, **k):\n"
        "        raise AssertionError('engine called with no prompts')\n"
        "out = generate_groups(None, None, [], group=4, max_new=8, temperature=0.8, engine=Boom())\n"
        "print(json.dumps({'out': out}))\n"
    )
    assert result["out"] == []


# ── the adapter publisher must not fill the disk ───────────────────────────────────────────────
#
# publish() writes a fresh directory on every step that produces an update, and the adapter is
# 53,528,920 bytes (measured: artifacts/policy-30b-g16/adapter_model.safetensors). Nothing deleted
# them. At 50 steps and a 56% update rate that was ~32 directories and invisible; batching takes the
# publish rate to ~100%, so a 3000-step run would write ~150 GiB onto a 150 GB volume that already
# holds ~90 GB. It would die of ENOSPC past step 1000, hours into an unattended run.
#
# `publish` is exercised unbound, with a stub `self`, so this needs neither vLLM nor a GPU.


def test_publish_keeps_only_the_two_most_recent_adapters(tmp_path):
    result = run_in_subprocess(
        "import types, os\n"
        "from scripts.train_grpo import VLLMRollouts\n"
        f"work = {str(tmp_path / 'vllm_adapters')!r}\n"
        "os.makedirs(work, exist_ok=True)\n"
        "from pathlib import Path\n"
        "me = types.SimpleNamespace(workdir=Path(work), lora_id=0, adapter_dir='')\n"
        "class Model:\n"
        "    def save_pretrained(self, d):\n"
        "        os.makedirs(d, exist_ok=True)\n"
        "        open(os.path.join(d, 'adapter_model.safetensors'), 'wb').write(b'x' * 1024)\n"
        "for _ in range(6):\n"
        "    VLLMRollouts.publish(me, Model())\n"
        "left = sorted(os.listdir(work))\n"
        "print(json.dumps({'left': left, 'lora_id': me.lora_id,\n"
        "                  'serving': os.path.basename(me.adapter_dir)}))\n"
    )
    # Two, not one: vLLM caches by id and may still hold the adapter it is currently serving.
    assert result["left"] == ["adapter-5", "adapter-6"], (
        f"publish left {result['left']} behind; 3000 steps of this fills the volume")
    assert result["lora_id"] == 6
    assert result["serving"] == "adapter-6", "the engine must be pointed at the newest adapter"


def test_publish_failure_degrades_instead_of_killing_the_run(tmp_path):
    """A full disk must cost freshness, not a multi-day run. save_policy already works this way."""
    result = run_in_subprocess(
        "import types, os\n"
        "from pathlib import Path\n"
        "from scripts.train_grpo import VLLMRollouts\n"
        f"work = {str(tmp_path / 'w2')!r}\n"
        "os.makedirs(work, exist_ok=True)\n"
        "me = types.SimpleNamespace(workdir=Path(work), lora_id=7, adapter_dir='/prev/adapter-7')\n"
        "class FullDisk:\n"
        "    def save_pretrained(self, d):\n"
        "        raise OSError(28, 'No space left on device')\n"
        "VLLMRollouts.publish(me, FullDisk())   # must NOT raise\n"
        "print(json.dumps({'lora_id': me.lora_id, 'adapter_dir': me.adapter_dir}))\n"
    )
    # The id must NOT advance: the engine keeps serving the last good adapter, and the next publish
    # retries the same slot rather than leaving a hole in the sequence.
    assert result["lora_id"] == 7
    assert result["adapter_dir"] == "/prev/adapter-7"


def test_max_cases_zero_means_all_cases_not_none():
    """`filter_corpus` documents 0 as "use all". The trainer sliced [:0] and graded against nothing.

    A silent, total corruption: every completion scores 0, every group is dead, and the run reports
    a clean flat curve. Pinned on the holdout path, which threads max_cases through.
    """
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        f"GOOD = {GOOD_SUM!r}\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [[GOOD] * (1 if greedy else group) for _ in prompts]\n"
        f"problems = [{SUM_PROBLEM!r}]\n"
        "m0 = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                      timeout_s=30.0, engine=FakeEngine(), max_cases=0)\n"
        "m1 = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                      timeout_s=30.0, engine=FakeEngine(), max_cases=20)\n"
        "print(json.dumps({'all_cases': m0['holdout_mean_case_fraction'],\n"
        "                  'capped': m1['holdout_mean_case_fraction']}))\n"
    )
    # The solution is correct, so it must score 1.0 either way. Before the fix, max_cases=0 sliced
    # the case list to empty and scored 0.0.
    assert result["all_cases"] == pytest.approx(1.0), (
        f"max_cases=0 graded against an empty case list: {result['all_cases']}")
    assert result["capped"] == pytest.approx(1.0)


def test_concurrent_eval_grading_keeps_verdicts_with_their_own_problem():
    """Grading runs in a thread pool now. A reordering would score every problem against another's
    tests and produce plausible, entirely wrong numbers -- the failure mode this project keeps
    hitting. Two problems with DIFFERENT correct answers, so a swap scores 0 instead of 1.
    """
    add = "```python\na, b = map(int, input().split())\nprint(a + b)\n```"
    mul = "```python\na, b = map(int, input().split())\nprint(a * b)\n```"
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        f"ADD = {add!r}\n"
        f"MUL = {mul!r}\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        # each prompt gets the solution correct for ITS OWN problem\n"
        "        return [[ADD if 'ADD' in p else MUL] * (1 if greedy else group) for p in prompts]\n"
        # 3 and 4: sum 7, product 12 -- distinct, so grading the wrong pair scores zero.
        f"IN = {'3 4' + chr(10)!r}\n"
        "def mk(name, out):\n"
        "    return {'id': name, 'prompt': name, 'tests': [{'input': IN, 'output': out}]}\n"
        f"S, P = {'7' + chr(10)!r}, {'12' + chr(10)!r}\n"
        "problems = [mk('ADD-a', S), mk('MUL-b', P), mk('ADD-c', S), mk('MUL-d', P)]\n"
        "m = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                     timeout_s=30.0, engine=FakeEngine(), max_cases=0)\n"
        "print(json.dumps(m))\n"
    )
    # Every problem receives its own correct solution, so all four must score 1.0. Any pairing
    # error drops the mean.
    assert result["holdout_mean_case_fraction"] == pytest.approx(1.0), (
        f"concurrent grading mispaired verdicts with problems: {result}")
    assert result["holdout_greedy_solved"] == 4
    assert result["holdout_solved_any"] == 4
    assert result["holdout_stalled"] == 0


def test_chunked_grading_keeps_scores_in_source_order():
    """Sources are graded in concurrent chunks now; adv[i] indexes by completion, so order is load-bearing."""
    result = run_in_subprocess(
        "from scripts.train_grpo import reward_for_group, extract_code, GRADE_CHUNK\n"
        f"ADD = {'```python' + chr(10) + 'a, b = map(int, input().split())' + chr(10) + 'print(a + b)' + chr(10) + '```'!r}\n"
        f"ZERO = {'```python' + chr(10) + 'print(0)' + chr(10) + '```'!r}\n"
        f"TESTS = {SUM_TESTS!r}\n"
        # 10 sources spanning >2 chunks, alternating correct/wrong so a reorder is visible.
        "srcs = [extract_code(ADD if i % 2 == 0 else ZERO) for i in range(10)]\n"
        "r = reward_for_group(srcs, TESTS, timeout_s=30.0)\n"
        "print(json.dumps({'rewards': r, 'chunk': GRADE_CHUNK}))\n"
    )
    assert len(result["rewards"]) == 10, f"lost sources across chunks: {result}"
    # Even indices are the correct program, odd are wrong. A chunk reordering breaks this pattern.
    assert result["rewards"] == [1.0, 0.0] * 5, (
        f"chunked grading returned scores out of source order: {result['rewards']}")


def test_a_dead_chunk_skips_the_group_rather_than_fabricating_spread():
    """Mixing a dead chunk's manufactured zeros with real scores would invent a gradient."""
    result = run_in_subprocess(
        "from scripts.train_grpo import reward_for_group, extract_code\n"
        f"ADD = {'```python' + chr(10) + 'a, b = map(int, input().split())' + chr(10) + 'print(a + b)' + chr(10) + '```'!r}\n"
        f"LOOP = {LOOP!r}\n"
        f"TESTS = {SUM_TESTS!r}\n"
        # First chunk all-hanging, later chunks fine: the group must be skipped, not partly scored.
        "srcs = [extract_code(LOOP)] * 4 + [extract_code(ADD)] * 4\n"
        "r = reward_for_group(srcs, TESTS, timeout_s=2.0)\n"
        "print(json.dumps({'rewards': r}))\n"
    )
    assert result["rewards"] == [], (
        f"a dead chunk was mixed with real scores, fabricating spread: {result['rewards']}")


def test_eval_max_cases_is_independent_of_the_training_reward():
    """An ablation must change the treatment without changing the measurement.

    --max-cases governs the training reward; --eval-max-cases governs the holdout metric. If one
    flag drove both, reverting the reward to 20 cases would silently redefine
    holdout_mean_case_fraction, and the ablation could not be compared against the run it ablates.
    """
    result = run_in_subprocess(
        "import torch\n"
        "from scripts.train_grpo import evaluate_holdout\n"
        f"GOOD = {GOOD_SUM!r}\n"
        f"ZERO = {ZERO!r}\n"
        "class FakeEngine:\n"
        "    def generate_many(self, tok, prompts, group, max_new, temperature, greedy=False, seed=None):\n"
        "        return [[GOOD] * (1 if greedy else group) for _ in prompts]\n"
        # 4 cases: the solution is correct on all of them, so any case count scores 1.0 -- what
        # differs is how many cases were consulted, which the graded/denominator reflects.
        f"IN = {'2 3' + chr(10)!r}\n"
        f"OUT = {'5' + chr(10)!r}\n"
        "problems = [{'id': 'sum', 'prompt': 'add', 'tests': [{'input': IN, 'output': OUT}] * 4}]\n"
        "m_all = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                         timeout_s=30.0, engine=FakeEngine(), max_cases=0)\n"
        "m_two = evaluate_holdout(None, None, problems, group=2, max_new=64, temperature=0.8,\n"
        "                         timeout_s=30.0, engine=FakeEngine(), max_cases=2)\n"
        "print(json.dumps({'all': m_all['holdout_mean_case_fraction'],\n"
        "                  'two': m_two['holdout_mean_case_fraction']}))\n"
    )
    # The parameter is honoured independently at the call site; a correct solution scores 1.0 under
    # either, which is what makes the two runs' metrics comparable when eval_max_cases is held fixed.
    assert result["all"] == pytest.approx(1.0)
    assert result["two"] == pytest.approx(1.0)
