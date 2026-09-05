"""Does GRPO's colocated setup fit in 16 GiB? Measured for training, derived for the KV cache.

P3a budgets 22 hours on a rented A40 for GRPO iteration. If Qwen2.5-Coder-1.5B with LoRA and a
colocated vLLM fits on the local card, those hours leave the meter entirely. That is worth measuring
rather than estimating, because "it probably fits" is how a phase gets budgeted twice.

WHAT IS MEASURED AND WHAT IS DERIVED, KEPT SEPARATE ON PURPOSE
--------------------------------------------------------------
  measured   the policy model loaded in bf16, LoRA adapters attached, and a real forward+backward
             at the intended sequence length. Peak reserved, from the allocator.
  derived    the KV cache, from the model's own config by the standard formula. Exact arithmetic,
             not a guess -- but vLLM adds its own overhead on top, so the headroom figure is a
             floor and is labelled as one.

Deriving the cache rather than installing vLLM is a deliberate trade: vLLM is a multi-gigabyte
install whose own allocator would then have to be untangled from the measurement. The formula is
unambiguous and the conclusion only needs to be right about whether there is room, not to three
decimal places.
"""
from __future__ import annotations

import argparse
import json

import torch

GIB = 1024 ** 3


def kv_cache_bytes(cfg, seqs: int, seq_len: int, dtype_bytes: int = 2) -> int:
    """Standard KV cache size. Grouped-query attention makes this much smaller than it looks.

    2 (K and V) * layers * kv_heads * head_dim * seq_len * batch * bytes.
    Qwen2.5 uses GQA, so kv_heads is far below attention heads -- 2 against 12 on the 1.5B.
    """
    head_dim = cfg.hidden_size // cfg.num_attention_heads
    kv_heads = getattr(cfg, "num_key_value_heads", cfg.num_attention_heads)
    return 2 * cfg.num_hidden_layers * kv_heads * head_dim * seq_len * seqs * dtype_bytes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--seq", type=int, default=1024)
    ap.add_argument("--group", type=int, default=8, help="GRPO completions per prompt")
    ap.add_argument("--gen-len", type=int, default=1024)
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--fused-loss", action="store_true",
                    help="route the loss through the P4a Triton kernel instead of F.cross_entropy")
    ap.add_argument("--out")
    args = ap.parse_args()

    from peft import LoraConfig, get_peft_model
    from transformers import AutoConfig, AutoModelForCausalLM

    total = torch.cuda.get_device_properties(0).total_memory
    cfg = AutoConfig.from_pretrained(args.model)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16).cuda()
    weights = torch.cuda.memory_allocated()

    lora = LoraConfig(r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.0,
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                      "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model.config.use_cache = False
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
    ids = torch.randint(0, cfg.vocab_size, (1, args.seq), device="cuda")

    backend = "torch_cross_entropy"
    if args.fused_loss:
        import sys
        from pathlib import Path as _P
        sys.path.insert(0, str(_P(__file__).resolve().parents[1]))
        from training.kernels.hf_loss import fused_causal_lm_loss, loss_backend
        backend = loss_backend()

    for _ in range(3):
        if args.fused_loss:
            loss, _ = fused_causal_lm_loss(model, ids, labels=ids)
        else:
            loss = model(input_ids=ids, labels=ids).loss
        loss.backward()
        opt.step()
        opt.zero_grad(set_to_none=True)
    torch.cuda.synchronize()

    train_peak = torch.cuda.max_memory_reserved()
    kv = kv_cache_bytes(cfg, args.group, args.seq + args.gen_len)
    # Colocate keeps a second copy of the weights for the inference engine.
    inference_weights = weights
    floor = train_peak + inference_weights + kv

    record = {
        "model": args.model,
        "loss_backend": backend,
        "device_total_gib": round(total / GIB, 2),
        "params_b": round(sum(p.numel() for p in model.parameters()) / 1e9, 3),
        "lora_trainable_m": round(trainable / 1e6, 2),
        "measured_weights_gib": round(weights / GIB, 2),
        "measured_train_peak_gib": round(train_peak / GIB, 2),
        "derived_kv_cache_gib": round(kv / GIB, 2),
        "derived_inference_weights_gib": round(inference_weights / GIB, 2),
        "derived_colocate_floor_gib": round(floor / GIB, 2),
        "headroom_gib": round((total - floor) / GIB, 2),
        "fits": bool(floor < total),
        "assumptions": {"seq": args.seq, "gen_len": args.gen_len, "group": args.group,
                        "lora_r": args.lora_r, "kv_dtype_bytes": 2},
    }
    print(json.dumps(record, indent=2))
    print()
    print(f"  training measured : {record['measured_train_peak_gib']:6.2f} GiB")
    print(f"  + inference copy  : {record['derived_inference_weights_gib']:6.2f} GiB   (derived)")
    print(f"  + KV cache        : {record['derived_kv_cache_gib']:6.2f} GiB   (derived, "
          f"{args.group} seqs x {args.seq + args.gen_len} tokens)")
    print(f"  = floor           : {record['derived_colocate_floor_gib']:6.2f} GiB "
          f"of {record['device_total_gib']:.2f}")
    print(f"  headroom          : {record['headroom_gib']:6.2f} GiB  -> "
          f"{'FITS' if record['fits'] else 'DOES NOT FIT'}")
    print("\n  Floor, not a total: vLLM adds its own allocator overhead and CUDA graph buffers.")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, sort_keys=True)
            fh.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
