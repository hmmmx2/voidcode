"""How much does the eval move when the policy does not move at all?

That number is the detection threshold. A training effect smaller than it is not measurable by
this experiment, and reporting one would be reading tea leaves.

WHY THIS EXISTS
----------------
Three learning rates were compared before anyone asked what the eval could resolve. At lr=2e-6 the
policy provably did not move -- KL flat at ~3e-4 across 100 steps -- and `mean_case_fraction` still
fell 0.111 -> 0.0649, a 42% swing. Conclusions drawn from that ("2e-5 degrades the policy") were
conclusions about sampling variance.

The method is the obvious one and it had simply never been run: **evaluate the same unmodified
model twice.** The policy cannot have changed between the two calls, so every difference is
instrument noise.

WHAT A PASS LOOKS LIKE, AND WHAT EACH FAILURE MEANS
-----------------------------------------------------
  greedy identical         `do_sample=False` is deterministic. If A != B, the metric added
                           specifically to be noise-free is not, and the fix is wrong.
  sampled difference ~0    Common random numbers reseed to the same value before every eval. If
                           this is large, the seed reset is not taking effect and checkpoints are
                           still being compared on independent draws.

If both hold, a later change in the eval is a change in the policy. That is the whole point.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch

from scripts.train_grpo import evaluate


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", default="data/catalogue.json")
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--eval-group", type=int, default=8)
    ap.add_argument("--max-new", type=int, default=640)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--grade-timeout", type=float, default=8.0)
    ap.add_argument("--limit", type=int, default=0, help="use only the first N problems")
    ap.add_argument("--out", default="docs/eval-noise-floor.json")
    args = ap.parse_args()

    problems = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    if isinstance(problems, dict):
        problems = problems.get("problems", [])
    if args.limit:
        problems = problems[: args.limit]

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda")
    model.eval()

    print(f"evaluating {len(problems)} problems twice on an UNCHANGED policy", flush=True)
    a = evaluate(model, tok, problems, args.eval_group, args.max_new,
                 args.temperature, args.grade_timeout)
    print(f"  run A: {a}", flush=True)
    b = evaluate(model, tok, problems, args.eval_group, args.max_new,
                 args.temperature, args.grade_timeout)
    print(f"  run B: {b}", flush=True)

    keys = ["solve_rate", "mean_case_fraction", "greedy_case_fraction"]
    diffs = {k: abs(a[k] - b[k]) for k in keys}

    print("\n  metric                  run A     run B      |diff|")
    for k in keys:
        print(f"  {k:22s} {a[k]:8.4f}  {b[k]:8.4f}  {diffs[k]:10.4f}")
    print(f"\n  reported case_fraction_se: {a['case_fraction_se']:.4f}")
    print(f"  greedy_solved: A={a['greedy_solved']}  B={b['greedy_solved']}")

    greedy_ok = diffs["greedy_case_fraction"] < 1e-9 and a["greedy_solved"] == b["greedy_solved"]
    # Common random numbers should make this exact, but grading runs untrusted code in a
    # subprocess under a wall-clock timeout: a machine hiccup can flip one borderline case. Allow
    # a hair, and report the actual figure either way rather than hiding it behind the verdict.
    sampled_ok = diffs["mean_case_fraction"] < 0.005

    print()
    print(f"  greedy deterministic          : {'PASS' if greedy_ok else 'FAIL'}")
    print(f"  common random numbers working : {'PASS' if sampled_ok else 'FAIL'}")
    if not greedy_ok:
        print("  -> do_sample=False is not reproducing. The noise-free metric is not noise-free.")
    if not sampled_ok:
        print("  -> the seed reset is not taking effect; checkpoints see independent draws.")

    floor = max(diffs["mean_case_fraction"], 2 * a["case_fraction_se"])
    print(f"\n  DETECTION THRESHOLD for mean_case_fraction: {floor:.4f}")
    print("  A training effect smaller than this is not measurable by this experiment.")

    Path(args.out).write_text(json.dumps(
        {"model": args.model, "problems": len(problems), "eval_group": args.eval_group,
         "run_a": a, "run_b": b, "abs_diff": diffs,
         "greedy_deterministic": greedy_ok, "common_random_numbers_working": sampled_ok,
         "detection_threshold": round(floor, 4)}, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {args.out}", flush=True)
    return 0 if (greedy_ok and sampled_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
