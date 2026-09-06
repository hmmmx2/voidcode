"""Filter a public corpus to the 10-90% base-pass band, using vLLM for the rollouts.

The band filter that `base_pass_rate.py` does for the 60 authored problems, pointed at a
stdin/stdout corpus and driven by vLLM instead of HuggingFace `generate`. That swap is the whole
reason this needs a rented card: `generate` measured ~13 s/problem, which is ~87 hours for 24K.

**vLLM cannot run under WSL2** — no UVA, see D-011 — so this script only ever runs on Linux.

The number it exists to produce is the **in-band fraction**: what share of a random sample lands
between 10% and 90% base pass rate. That decides whether filtering all 24K is worth it, and how much
usable corpus a GRPO run would actually have.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PROMPT = ("Solve this competitive programming problem in Python 3. Read from standard input and "
          "write to standard output.\n\n{problem}\n\n"
          "Return only the complete program in a single ```python code block.")


def extract_code(text: str) -> str:
    """Must match `train_grpo.extract_code`, including its tolerance of a missing closing fence.

    The regex this replaced required a CLOSING ```. At `--max-new 640` a completion that runs out of
    tokens mid-code has no closing fence, so the regex matched nothing and the whole prose blob was
    returned as "source" -- which fails to compile and scores 0. The trainer, grading the same text,
    keeps the partial code and scores partial credit. A band measured with the stricter extractor
    therefore understates precisely the problems sitting near the token limit, and understating a
    pass rate pushes a problem down into (or below) the band it does not belong in.
    """
    if "```" not in text:
        return text.strip()
    body = text.split("```", 1)[1]
    if body.startswith("python"):
        body = body[len("python"):]
    return body.split("```", 1)[0].strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="data/deepcoder-sample.json")
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--group", type=int, default=8)
    ap.add_argument("--max-new", type=int, default=640)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--grade-timeout", type=float, default=8.0)
    ap.add_argument("--util", type=float, default=0.85)
    ap.add_argument("--lo", type=float, default=0.10)
    ap.add_argument("--hi", type=float, default=0.90)
    # Median 101 cases per problem, and grading is 8 completions x 2,000 problems. Capping at 20
    # cuts the grading phase ~5x and costs nothing for this purpose: the filter only has to place a
    # problem in the 10-90% band, not score it precisely. The full case list is kept in the corpus
    # file and the GRPO reward uses all of it at training time.
    ap.add_argument("--max-cases", type=int, default=20,
                    help="cases per problem used for banding; 0 uses all")
    ap.add_argument("--out")
    args = ap.parse_args()

    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from vllm import LLM, SamplingParams

    from reward.limits import run_isolated_stdio_batch

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    problems = corpus["problems"][: args.limit] if args.limit else corpus["problems"]
    print(f"corpus: {len(problems)} problems from {corpus.get('source')}", flush=True)

    engine = LLM(model=args.model, gpu_memory_utilization=args.util, max_model_len=4096,
                 dtype="bfloat16", disable_log_stats=True)
    sampling = SamplingParams(n=args.group, max_tokens=args.max_new,
                              temperature=args.temperature, top_p=0.95)

    # THE BAND MUST BE MEASURED THE WAY THE POLICY IS ACTUALLY PROMPTED.
    #
    # This originally handed vLLM raw strings. `LLM.generate(list[str])` tokenizes them verbatim, so
    # an -Instruct model was measured OFF its own chat template while every other stage of the
    # pipeline -- train_grpo.VLLMRollouts.generate, and base_pass_rate, which produced the numbers
    # the band gets compared against -- wraps the prompt in `apply_chat_template`. The band is a
    # property of the model/corpus/PROMPT triple, and an off-template model is a different, weaker
    # model: problems it half-solves are recorded as in-band when the templated policy solves them
    # on every sample, which is dead-from-the-top during training and looks exactly like "GRPO did
    # not work". docs/rl/METRICS.md records which band files predate this fix.
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    # One batched call for the whole corpus: vLLM's continuous batching is the entire reason this
    # is hours instead of days, and issuing one prompt at a time would give most of that back.
    prompts = [tok.apply_chat_template(
        [{"role": "user", "content": PROMPT.format(problem=p["prompt"][:6000])}],
        tokenize=False, add_generation_prompt=True) for p in problems]
    print("generating...", flush=True)
    outputs = engine.generate(prompts, sampling)

    results = []
    harness_errors: list[str] = []
    # strict=False preserves the pre-existing behaviour exactly: this pairing was written
    # against zip's default, and this path only runs on a rented GPU against the filtered
    # corpus, so tightening it to strict=True here would be an untested semantic change.
    for problem, output in zip(problems, outputs, strict=False):
        cases = problem["tests"][: args.max_cases] if args.max_cases else problem["tests"]
        passed = 0
        partial = 0.0
        try:
            verdicts = run_isolated_stdio_batch(
                [extract_code(c.text) for c in output.outputs], cases,
                timeout_s=args.grade_timeout)
        except RuntimeError as exc:
            harness_errors.append(f"{problem['id']}: {exc}")
            verdicts = []
        for v in verdicts:
            passed += int(v.solved)
            partial += v.case_fraction
        rate = passed / args.group
        results.append({"id": problem["id"], "source": problem["source"],
                        "pass_rate": rate, "n_cases": problem["n_cases"], "cases_graded": len(cases),
                        "mean_case_fraction": round(partial / args.group, 4)})
        if len(results) % 25 == 0:
            in_band = sum(1 for r in results if args.lo <= r["pass_rate"] <= args.hi)
            print(f"  {len(results)}/{len(problems)}  in-band so far {in_band}", flush=True)

    usable = [r for r in results if args.lo <= r["pass_rate"] <= args.hi]
    always = [r for r in results if r["pass_rate"] > args.hi]
    never = [r for r in results if r["pass_rate"] < args.lo]
    partial_only = [r for r in never if r["mean_case_fraction"] > 0]

    summary = {
        "corpus": corpus.get("source"), "model": args.model, "group": args.group, "max_cases": args.max_cases,
        "problems": len(results), "band": [args.lo, args.hi],
        "usable": len(usable), "always_solved": len(always), "never_solved": len(never),
        "never_but_partial": len(partial_only),
        "in_band_fraction": round(len(usable) / max(len(results), 1), 4),
        "with_any_signal": len(usable) + len(partial_only),
        "mean_pass_rate": round(sum(r["pass_rate"] for r in results) / max(len(results), 1), 4),
        "harness_errors": len(harness_errors),
        "harness_error_sample": harness_errors[:5],
        "results": results,
    }
    print("\n" + "=" * 58)
    print(f"  usable ({args.lo:.0%}-{args.hi:.0%}) : {len(usable):5d} / {len(results)}"
          f"   ({summary['in_band_fraction']:.1%})")
    print(f"  always solved            : {len(always):5d}")
    print(f"  never solved             : {len(never):5d}  of which {len(partial_only)} score partial")
    print(f"  with ANY signal          : {summary['with_any_signal']:5d}")
    print(f"  mean pass rate           : {summary['mean_pass_rate']:.3f}")
    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
