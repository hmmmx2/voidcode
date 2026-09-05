"""P3b: how much faster is vLLM than HF `generate` for GRPO rollouts?

GRPO spends almost all of its wall clock generating. Each step samples G completions for one
prompt, and the P3a run measured that directly: 200 steps at G=16 took roughly two and a half
hours on an A40, of which the optimizer step is a rounding error. If the trainer and the sampler
are split across the two cards, the sampler is the thing worth making fast.

WHAT IS MEASURED, AND WHAT IS NOT
----------------------------------
This times **generation only**, on identical prompts with identical sampling parameters, on the
same card. It does not train, grade, or claim anything about reward. A throughput ratio is the
whole deliverable, because P3a already established that the recipe produces no measurable transfer
-- P3b makes the loop faster, not better, and the write-up should say so.

The prompts are the 60 local problems. They are the right shape (real instructions, real length
distribution) and they avoid shipping a 928 MB corpus to a metered pod to time a decode loop.

WHY THE COMPARISON NEEDS CARE
------------------------------
Three ways this measurement could flatter vLLM and mean nothing:

  * **Different token counts.** vLLM stops at EOS per sequence; HF pads to `max_new_tokens` unless
    told otherwise. Comparing wall clock while one produces half the tokens is not a speedup. Both
    tokens/s and total tokens are reported so the reader can see it.
  * **Warmup.** vLLM's first call builds CUDA graphs and profiles memory. One prompt is discarded
    from both before timing starts.
  * **Batching.** HF `generate` with num_return_sequences=G already batches; vLLM's advantage is
    continuous batching across *prompts*, so single-prompt-at-a-time understates it. Both are timed
    the way the GRPO loop actually calls them -- one prompt, G completions -- and a second vLLM row
    submits all prompts at once to show the ceiling.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def load_prompts(path: str, limit: int) -> list[str]:
    from scripts.base_pass_rate import build_prompt

    problems = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(problems, dict):
        problems = problems.get("problems", [])
    return [build_prompt(p) for p in problems[:limit]]


def bench_hf(model_id: str, prompts: list[str], group: int, max_new: int,
             temperature: float) -> dict:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(
        model_id, torch_dtype=torch.bfloat16, device_map="cuda:0")
    model.eval()

    def one(prompt: str) -> int:
        chat = tok.apply_chat_template([{"role": "user", "content": prompt}],
                                       tokenize=False, add_generation_prompt=True)
        enc = tok(chat, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**enc, do_sample=True, temperature=temperature, top_p=0.95,
                                 max_new_tokens=max_new, num_return_sequences=group,
                                 pad_token_id=tok.pad_token_id or tok.eos_token_id)
        return int((out[:, enc["input_ids"].shape[1]:] != (tok.pad_token_id or tok.eos_token_id)).sum())

    one(prompts[0])                                   # warmup, discarded
    started = time.time()
    tokens = sum(one(p) for p in prompts[1:])
    elapsed = time.time() - started
    return {"backend": "hf_generate", "prompts": len(prompts) - 1, "tokens": tokens,
            "seconds": round(elapsed, 2), "tokens_per_s": round(tokens / max(elapsed, 1e-9), 1)}


def bench_vllm(model_id: str, prompts: list[str], group: int, max_new: int,
               temperature: float, util: float, all_at_once: bool) -> dict:
    from transformers import AutoTokenizer
    from vllm import LLM, SamplingParams

    # **Apply the chat template here too.** The first version of this function passed the raw
    # prompt straight to llm.generate() while bench_hf applied the template, so the two backends
    # were not being given the same input at all: without the template the model never emits
    # <|im_end|> reliably and runs on toward max_tokens. Measured effect — vLLM produced 66,587
    # tokens against HF's 28,809 for the same 12 prompts, and the resulting "3.3x" was mostly
    # vLLM being handed a harder task and doing more work, not doing the same work faster.
    tok = AutoTokenizer.from_pretrained(model_id)
    templated = [tok.apply_chat_template([{"role": "user", "content": p}],
                                         tokenize=False, add_generation_prompt=True)
                 for p in prompts]

    llm = LLM(model=model_id, dtype="bfloat16", gpu_memory_utilization=util,
              max_model_len=2048, enforce_eager=False)
    sp = SamplingParams(n=group, temperature=temperature, top_p=0.95, max_tokens=max_new)

    llm.generate([templated[0]], sp)                  # warmup, discarded
    rest = templated[1:]
    started = time.time()
    if all_at_once:
        outs = llm.generate(rest, sp)
    else:
        outs = []
        for p in rest:                                # one prompt at a time: how GRPO calls it
            outs.extend(llm.generate([p], sp))
    elapsed = time.time() - started
    tokens = sum(len(c.token_ids) for o in outs for c in o.outputs)
    return {"backend": "vllm_batched" if all_at_once else "vllm_per_prompt",
            "prompts": len(rest), "tokens": tokens, "seconds": round(elapsed, 2),
            "tokens_per_s": round(tokens / max(elapsed, 1e-9), 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=("hf", "vllm", "vllm_batched"))
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--eval-set", default="data/catalogue.json")
    ap.add_argument("--limit", type=int, default=13, help="prompts incl. the discarded warmup")
    ap.add_argument("--group", type=int, default=16)
    ap.add_argument("--max-new", type=int, default=640)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--util", type=float, default=0.85)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    prompts = load_prompts(args.eval_set, args.limit)
    print(f"{args.backend}: {len(prompts) - 1} timed prompts x {args.group} completions", flush=True)

    if args.backend == "hf":
        result = bench_hf(args.model, prompts, args.group, args.max_new, args.temperature)
    else:
        result = bench_vllm(args.model, prompts, args.group, args.max_new, args.temperature,
                            args.util, args.backend == "vllm_batched")

    result.update({"model": args.model, "group": args.group, "max_new": args.max_new})
    print(json.dumps(result, indent=2), flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
