"""How much does an eval move when the POLICY DOES NOT CHANGE?

The uncapped run's most eye-catching number is `holdout_greedy_solved` 55 -> 66 at step 100. Greedy
decoding is deterministic in principle, which is the entire reason this project chose it as the
metric whose movement "cannot be sampling noise". But its trajectory across the run was
55, 50, 45, 52, 66 -- swings of +/-10 in BOTH directions on a policy that was changing slowly and
monotonically. Something other than the policy is moving it.

The suspected cause is known and was introduced deliberately: batching the eval. vLLM's continuous
batching changes the numerics of a request depending on what else is in flight with it, so greedy
decoding is not bitwise-reproducible across runs whose batch composition differs. The eval also runs
`--eval-group 4` sampled completions alongside the greedy one, so the batch is never identical.

THE MEASUREMENT: hold the policy completely fixed and run the identical eval N times. Whatever
spread appears is the eval's own noise floor, and no claim smaller than it survives.

  spread ~ +/-10 on greedy_solved  -> the +11 at step 100 is indistinguishable from noise
  spread ~ +/-2                    -> the +11 is real and the mid-run dips were the anomaly

Deliberately reuses the trainer's own evaluate/evaluate_holdout/VLLMRollouts rather than
reimplementing them: a noise floor measured with a DIFFERENT eval path would not bound the numbers
this run actually produced.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

# Repo root from this file, not a hardcoded pod path: the script has to be runnable locally to be
# lintable and reviewable, and a path that only resolves on the rented box cannot be checked before
# it is needed.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.train_grpo import (
    VLLMRollouts,
    evaluate,
    evaluate_holdout,
    load_band,
    split_holdout,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--adapter", default="", help="policy under test; empty = base model")
    ap.add_argument("--corpus", default="data/deepcoder-band-30b-templated.json")
    ap.add_argument("--source", default="data/deepcoder-sample.json")
    ap.add_argument("--eval-set", default="data/catalogue.json")
    ap.add_argument("--vllm-model", default="QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ")
    ap.add_argument("--model", default="Qwen/Qwen3-Coder-30B-A3B-Instruct")
    # Every flag below MUST match the run being bounded, or the floor describes a different eval.
    ap.add_argument("--holdout", type=int, default=120)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--eval-group", type=int, default=4)
    ap.add_argument("--max-new", type=int, default=1024)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--grade-timeout", type=float, default=40.0)
    ap.add_argument("--max-cases", type=int, default=0)
    ap.add_argument("--gpu-util", type=float, default=0.85)
    ap.add_argument("--max-len", type=int, default=5120)
    ap.add_argument("--out", default="/workspace/VC/docs/rl/greedy-noise-floor.json")
    args = ap.parse_args()

    from transformers import AutoTokenizer

    # Same band, same seed, same split -> the SAME 120 held-out problems the run reported on.
    train = load_band(Path(args.corpus), Path(args.source), 0.1, 0.9, "band")
    train, holdout = split_holdout(train, args.holdout, args.seed)
    eval_problems = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    if isinstance(eval_problems, dict):
        eval_problems = eval_problems.get("problems", [])
    print(f"holdout={len(holdout)} catalogue={len(eval_problems)} (train={len(train)})", flush=True)

    tok = AutoTokenizer.from_pretrained(args.model)
    engine = VLLMRollouts(args.vllm_model, args.gpu_util, args.max_len, 32,
                          Path("/workspace/noise_adapters"))
    if args.adapter:
        engine.adapter_dir = args.adapter
        engine.lora_id = 1
        print(f"policy under test: {args.adapter}", flush=True)
    else:
        print("policy under test: base model, no adapter", flush=True)

    rows = []
    for i in range(1, args.repeats + 1):
        # THE POLICY IS NOT TOUCHED BETWEEN ITERATIONS. Any movement below is the instrument.
        row = {"repeat": i}
        row.update(evaluate(None, tok, eval_problems, args.eval_group, args.max_new,
                            args.temperature, args.grade_timeout, engine=engine))
        row.update(evaluate_holdout(None, tok, holdout, args.eval_group, args.max_new,
                                    args.temperature, args.grade_timeout, engine=engine,
                                    max_cases=args.max_cases))
        rows.append(row)
        print(f"repeat {i}: greedy_solved={row['greedy_solved']} "
              f"holdout_greedy_solved={row['holdout_greedy_solved']} "
              f"holdout_mean_cf={row['holdout_mean_case_fraction']}", flush=True)

    print("\n=== NOISE FLOOR (identical policy, identical flags) ===")
    summary = {"repeats": args.repeats, "adapter": args.adapter or "base", "rows": rows}
    for key in ("greedy_solved", "greedy_case_fraction", "mean_case_fraction",
                "holdout_greedy_solved", "holdout_greedy_case_fraction",
                "holdout_mean_case_fraction", "holdout_solved_any"):
        vals = [r[key] for r in rows]
        spread = max(vals) - min(vals)
        sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
        summary[key] = {"values": vals, "spread": round(spread, 4), "sd": round(sd, 4)}
        print(f"  {key:32} {vals}  spread={spread:.4f}  sd={sd:.4f}")

    g = summary["holdout_greedy_solved"]["spread"]
    print("\n  The run reported holdout_greedy_solved 55 -> 66 (+11) at step 100.")
    print(f"  Identical-policy spread here: {g}.")
    print("  VERDICT:", "the +11 is INSIDE the noise floor" if g >= 11 else
          "the +11 EXCEEDS the noise floor" if g <= 5 else
          "inconclusive -- the floor is a substantial fraction of the claimed effect")

    Path(args.out).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
