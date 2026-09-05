"""Can a vLLM engine and a LoRA trainer share one 16 GiB card?

This decides where P3a runs. The earlier fit measurement derived a colocate *floor* of 11.61 GiB
against 15.93 available — but it derived the inference side from the model config and said so,
because vLLM's own allocator overhead and CUDA graph buffers were not in it. 4.32 GiB of headroom
is comfortable or insufficient depending entirely on what vLLM does with it, and no amount of
arithmetic settles that.

WHY THE ORDER MATTERS
---------------------
**vLLM pre-allocates its KV cache pool as a fraction of *total* GPU memory, not of free memory.**
`gpu_memory_utilization=0.9` on an empty card takes 14 GiB; the same setting alongside a resident
trainer takes 14 GiB it does not have. So the trainer is loaded **first**, and vLLM is given a
deliberately small fraction of what remains. Loading vLLM first would produce a misleading pass
followed by an OOM the moment training allocates.

WHAT COUNTS AS SUCCESS
----------------------
Not "vLLM started". Both must be resident **and** able to do their jobs: a real generation and a
real forward/backward, interleaved, which is what GRPO does every step. Measuring them separately
would miss exactly the fragmentation this is testing for.

A second, quieter question: **does vLLM support sm_120 at all?** Blackwell consumer cards are newer
than much of the kernel coverage in the ecosystem, and a clean failure here is a useful result that
sends the filter pass to an A40 rather than to a debugging session.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

GIB = 1024 ** 3


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--util", type=float, default=0.28,
                    help="vLLM gpu_memory_utilization, as a fraction of TOTAL card memory")
    ap.add_argument("--seq", type=int, default=1024)
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--gen", type=int, default=64)
    ap.add_argument("--out")
    args = ap.parse_args()

    import torch

    total = torch.cuda.get_device_properties(0).total_memory
    record = {"device": torch.cuda.get_device_name(0),
              "capability": ".".join(map(str, torch.cuda.get_device_capability(0))),
              "total_gib": round(total / GIB, 2), "util": args.util, "stage": "start"}

    def mark(stage: str) -> None:
        torch.cuda.synchronize()
        record[f"{stage}_gib"] = round(torch.cuda.memory_reserved() / GIB, 2)
        record["stage"] = stage
        print(f"  {stage:<28}{record[f'{stage}_gib']:6.2f} GiB reserved", flush=True)

    # ── trainer first, deliberately ───────────────────────────────────────────────────────────
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16).cuda()
    lora = LoraConfig(r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.0,
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                      "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model.config.use_cache = False
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
    mark("trainer_loaded")

    # ── then vLLM, on what is left ────────────────────────────────────────────────────────────
    os.environ.setdefault("VLLM_WORKER_MULTIPROC_METHOD", "spawn")
    try:
        from vllm import LLM, SamplingParams

        engine = LLM(model=args.model, gpu_memory_utilization=args.util,
                     max_model_len=args.seq + args.gen, enforce_eager=True,
                     dtype="bfloat16", disable_log_stats=True)
        mark("vllm_loaded")
    except Exception as exc:
        record["vllm_error"] = f"{type(exc).__name__}: {exc}"[:400]
        record["fits"] = False
        print(f"\n  vLLM failed to start: {record['vllm_error']}")
        if args.out:
            Path(args.out).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        return 1

    # ── interleave, because that is what GRPO does ────────────────────────────────────────────
    from training.kernels.hf_loss import fused_causal_lm_loss

    ids = torch.randint(0, tok.vocab_size, (1, args.seq), device="cuda")
    for step in range(2):
        out = engine.generate(["def add(a, b):"],
                              SamplingParams(max_tokens=args.gen, temperature=0.8))
        loss, _ = fused_causal_lm_loss(model, ids, labels=ids)
        loss.backward()
        opt.step()
        opt.zero_grad(set_to_none=True)
        mark(f"after_interleaved_step_{step}")

    record["generated_chars"] = len(out[0].outputs[0].text)
    record["peak_gib"] = round(torch.cuda.max_memory_reserved() / GIB, 2)
    record["headroom_gib"] = round((total - torch.cuda.max_memory_reserved()) / GIB, 2)
    record["fits"] = True

    print(f"\n  peak reserved               {record['peak_gib']:6.2f} GiB of {record['total_gib']}")
    print(f"  headroom                    {record['headroom_gib']:6.2f} GiB")
    print(f"  generation produced         {record['generated_chars']} chars")
    print("\n  BOTH RESIDENT AND WORKING — P3a can run locally")

    if args.out:
        Path(args.out).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
