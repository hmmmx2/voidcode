#!/usr/bin/env python
"""Held-out pass@1, base vs post-RL — the standalone P3 harness behind `make rl-eval`.

WHY THIS EXISTS SEPARATELY FROM train_grpo.evaluate()
-----------------------------------------------------
`train_grpo.evaluate()` runs inside the training loop and reports `greedy_solved` (greedy pass@1)
and `solved` — but `solved` is **pass@G**, incremented when *any* of the G samples solves the
problem. Neither is the sampled unbiased pass@1, and the loop stores only those aggregates.

That cost real analysis. `METRICS.md` carried "Base pass@1 on held-out: NOT MEASURED" for months
while the run records existed, because the sampled estimator is **not recoverable** from an
aggregate: you need per-problem success counts and only the totals were kept. This harness records
`c` (successes) and `n` (samples) for every problem, so pass@k for any k is computable afterwards
without touching a GPU again.

WHAT IS DELIBERATELY REUSED
---------------------------
`generate_group`, `eval_build_prompt`, `eval_extract_code` and `run_isolated_batch` are imported
from the trainer rather than reimplemented. If this file grew its own prompt builder or grader, its
"base" number would silently stop being comparable to the loop's own step-0 number, and the
comparison this harness exists to make would be meaningless.

The seed discipline is copied for the same reason: the RNG is reset to the same value before every
arm, so two arms see the *same* sampling draws (common random numbers) and their difference
reflects the policy rather than two independent doses of noise.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from reward.limits import run_isolated_batch
from rl.estimators import bootstrap_ci, pass_at_k, wilson
from scripts.base_pass_rate import build_prompt as eval_build_prompt
from scripts.base_pass_rate import extract_code as eval_extract_code
from scripts.train_grpo import generate_group


def eval_arm(name: str, model_path: str, problems: list[dict], group: int, max_new: int,
             temperature: float, timeout_s: float, seed: int) -> dict:
    print(f"\n=== arm '{name}': {model_path} ===", flush=True)
    tok = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    # BFLOAT16, NOT FLOAT16 — matching train_grpo.py line 368.
    #
    # This was found the hard way. With fp16 the base arm scored greedy 3/60 where the loop's own
    # step-0 recorded 4/60. Greedy decoding is deterministic, so that gap is not sampling noise:
    # fp16 and bf16 have different mantissa/exponent splits, the logits differ, and argmax lands
    # somewhere else on at least one problem. A harness that silently evaluates a
    # differently-rounded model is not measuring the same policy the trainer trained.
    load = {"device_map": "cuda:0", "trust_remote_code": True}
    try:
        model = AutoModelForCausalLM.from_pretrained(model_path, dtype=torch.bfloat16, **load)
    except TypeError as exc:                    # same 4.x/5.x kwarg split as merge_lora.py
        if "dtype" not in str(exc):
            raise
        model = AutoModelForCausalLM.from_pretrained(model_path, torch_dtype=torch.bfloat16, **load)
    model.eval()

    # Common random numbers: every arm sees the same draws.
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    records = []
    for i, p in enumerate(problems, 1):
        texts = generate_group(model, tok, eval_build_prompt(p), group, max_new, temperature)
        g_text = generate_group(model, tok, eval_build_prompt(p), 1, max_new, temperature,
                                greedy=True)
        sources = [eval_extract_code(t, p["entry"]) for t in texts + g_text]
        try:
            verdicts = run_isolated_batch(p, sources, timeout_s=timeout_s)
        except RuntimeError as exc:
            print(f"  harness error on {p['id']}: {exc}", flush=True)
            continue
        sampled, greedy = verdicts[:-1], verdicts[-1]
        c = sum(1 for v in sampled if v.case_fraction >= 1.0)
        records.append({
            "id": p["id"],
            "n": len(sampled),
            "c": c,                              # the field whose absence blocked pass@1
            "greedy_solved": bool(greedy.case_fraction >= 1.0),
            "greedy_case_fraction": round(greedy.case_fraction, 4),
            "mean_case_fraction": round(
                sum(v.case_fraction for v in sampled) / len(sampled), 4) if sampled else 0.0,
        })
        if i % 10 == 0:
            print(f"  {i}/{len(problems)} problems", flush=True)

    del model
    torch.cuda.empty_cache()

    n_prob = len(records)
    g_solved = sum(r["greedy_solved"] for r in records)
    g_lo, g_hi = wilson(g_solved, n_prob)
    p1 = [pass_at_k(r["n"], r["c"], 1) for r in records]
    p1_mean = sum(p1) / n_prob if n_prob else 0.0
    p1_lo, p1_hi = bootstrap_ci(p1, seed=seed)

    passk = {}
    for k in sorted({k for k in (1, 2, 4, 8, group) if k <= group}):
        vals = [pass_at_k(r["n"], r["c"], k) for r in records if r["n"] >= k]
        passk[f"pass@{k}"] = round(sum(vals) / len(vals), 4) if vals else None

    return {
        "arm": name,
        "model": model_path,
        "problems": n_prob,
        "group": group,
        "greedy_pass@1": {
            "solved": g_solved, "n": n_prob,
            "value": round(g_solved / n_prob, 4) if n_prob else 0.0,
            "wilson95": [round(g_lo, 4), round(g_hi, 4)],
        },
        "sampled_pass@1_unbiased": {
            "value": round(p1_mean, 4),
            "bootstrap95": [round(p1_lo, 4), round(p1_hi, 4)],
        },
        "pass@k": passk,
        "per_problem": records,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Held-out pass@1, base vs post-RL")
    ap.add_argument("--eval-set", required=True, help="data/catalogue.json — the held-out 60")
    ap.add_argument("--arm", action="append", required=True, metavar="NAME=PATH",
                    help="repeatable, e.g. --arm base=Qwen/Qwen2.5-Coder-1.5B-Instruct "
                         "--arm post=/workspace/policy-step200")
    # DEFAULTS ARE COPIED FROM train_grpo.py ON PURPOSE.
    #
    # They were not, at first, and it showed immediately: with max_new=512 the base arm scored
    # greedy 3/60 where the loop's own step-0 recorded 4/60. Greedy decoding is deterministic, so a
    # difference there is not noise -- it was the shorter generation budget truncating a solution
    # that 640 tokens completes. A harness whose "base" number cannot be compared to the loop's
    # step 0 defeats its own purpose, so any change to these must be made in both files.
    #
    # --group is the deliberate exception: the loop evaluates at 4 to keep training cheap, while 8
    # halves the variance of the pass@k estimates this harness exists to produce. Pass --group 4
    # when the goal is a strict like-for-like against a specific in-loop step.
    ap.add_argument("--group", type=int, default=8,
                    help="samples per problem (the n in pass@k). train_grpo evaluates at 4; "
                         "use --group 4 for a strict like-for-like with an in-loop step")
    ap.add_argument("--max-new", type=int, default=640, help="matches train_grpo.py")
    ap.add_argument("--temperature", type=float, default=0.8, help="matches train_grpo.py")
    ap.add_argument("--grade-timeout", type=float, default=8.0, help="matches train_grpo.py")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--out", default="rl_eval.json")
    args = ap.parse_args()

    problems = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))["problems"]
    print(f"held-out problems: {len(problems)}  group: {args.group}  seed: {args.seed}")

    arms = []
    for spec in args.arm:
        if "=" not in spec:
            print(f"--arm needs NAME=PATH, got {spec!r}", file=sys.stderr)
            return 2
        name, path = spec.split("=", 1)
        arms.append(eval_arm(name, path, problems, args.group, args.max_new,
                             args.temperature, args.grade_timeout, args.seed))

    print("\n" + "=" * 78)
    print(f"{'arm':>10} {'greedy pass@1':>28} {'sampled pass@1 (unbiased)':>32}")
    print("-" * 78)
    for a in arms:
        g, s = a["greedy_pass@1"], a["sampled_pass@1_unbiased"]
        print(f"{a['arm']:>10} {g['solved']:>3}/{g['n']} {g['value']:.4f} "
              f"[{g['wilson95'][0]:.3f},{g['wilson95'][1]:.3f}]"
              f"   {s['value']:.4f} [{s['bootstrap95'][0]:.3f},{s['bootstrap95'][1]:.3f}]")

    if len(arms) == 2:
        a, b = arms
        dg = b["greedy_pass@1"]["value"] - a["greedy_pass@1"]["value"]
        ds = b["sampled_pass@1_unbiased"]["value"] - a["sampled_pass@1_unbiased"]["value"]
        one = 1.0 / a["problems"] if a["problems"] else 0.0
        print(f"\ndelta greedy  {dg:+.4f}  ({dg / one:+.1f} problems; one problem = {one:.4f})")
        print(f"delta sampled {ds:+.4f}")
        lo_a, hi_a = a["sampled_pass@1_unbiased"]["bootstrap95"]
        lo_b, hi_b = b["sampled_pass@1_unbiased"]["bootstrap95"]
        overlap = not (hi_a < lo_b or hi_b < lo_a)
        print("VERDICT:", "intervals OVERLAP — no significant change"
              if overlap else "intervals are DISJOINT — significant change")

    Path(args.out).write_text(json.dumps({"arms": arms}, indent=1), encoding="utf-8")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
