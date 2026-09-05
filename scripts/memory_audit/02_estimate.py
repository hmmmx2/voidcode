"""Step 2 — Derive the theoretical static-state budget from the measured parameter count.

All figures in GiB (2**30 bytes). The A6000's "48 GB" is 48 GiB nominal
(49140 MiB usable after ECC/display reserve), so GiB is the honest unit for
comparison. Never rounds in the caller's favour.
"""
import json
import sys

GIB = 1024 ** 3

# Static per-parameter byte costs. (weights, grads, fp32_master, opt_m, opt_v)
CONFIGS = {
    "1_adamw_fp32_bf16mixed": dict(
        label="AdamW FP32 states, BF16 mixed precision, no tricks",
        w=4, g=4, master=0, m=4, v=4, grad_ckpt=False,
        note="Torch-AMP style: FP32 weights ARE the master copy. BF16 autocast "
             "copies are transient. Equivalent to the 2+2+4+4+4 DeepSpeed layout.",
    ),
    "2_adamw8bit_gc": dict(
        label="8-bit AdamW + gradient checkpointing",
        w=4, g=4, master=0, m=1, v=1, grad_ckpt=True,
        note="FP32 master retained; bitsandbytes AdamW8bit blockwise states.",
    ),
    "3_adamw8bit_no_master": dict(
        label="8-bit AdamW, no FP32 master weights",
        w=2, g=2, master=0, m=1, v=1, grad_ckpt=True,
        note="Pure BF16 weights and grads. Risks stale-update/underflow.",
    ),
    "4_adafactor_bf16_gc": dict(
        label="Adafactor, BF16, gradient checkpointing",
        w=2, g=2, master=0, m=0, v=0, grad_ckpt=True,
        note="beta1=None so no first moment. Factored second moment is O(rows+cols), "
             "added separately below, not per-parameter.",
    ),
    "5_galore_r128_8bit_layerwise": dict(
        label="GaLore rank 128, 8-bit states, layer-wise updates, grad ckpt",
        w=2, g=0, master=0, m=0, v=0, grad_ckpt=True,
        note="Layer-wise hooks free each grad immediately after its update, so "
             "grads are O(largest single tensor), added separately below.",
    ),
    "6_zero3_full_cpu_offload": dict(
        label="DeepSpeed ZeRO-3, full CPU offload of params + optimizer",
        w=0, g=0, master=0, m=0, v=0, grad_ckpt=True,
        note="GPU holds only the currently-gathered shard + activations. "
             "Full 16 B/param lands in HOST RAM instead - checked separately.",
    ),
}


def factored_second_moment_bytes(cfg):
    """Adafactor keeps a row and a column vector per >=2D tensor, FP32."""
    h, i, v, L = cfg["hidden"], cfg["inter"], cfg["vocab"], cfg["layers"]
    kv = cfg["kv_heads"] * (h // cfg["attn_heads"])
    mats = []
    for _ in range(L):
        mats += [(h, h), (kv, h), (kv, h), (h, h)]      # q, k, v, o
        mats += [(i, h), (i, h), (h, i)]                # gate, up, down
    mats += [(v, h), (v, h)]                            # embed_tokens, lm_head
    return sum((r + c) * 4 for r, c in mats)


def galore_extra_bytes(cfg, rank=128):
    """Projection matrix P (FP32) + projected 8-bit moments, per target matrix."""
    h, i, v, L = cfg["hidden"], cfg["inter"], cfg["vocab"], cfg["layers"]
    kv = cfg["kv_heads"] * (h // cfg["attn_heads"])
    mats = []
    for _ in range(L):
        mats += [(h, h), (kv, h), (kv, h), (h, h), (i, h), (i, h), (h, i)]
    proj = sum(min(r, c) * rank * 4 for r, c in mats)          # P, FP32
    states = sum(min(r, c) * rank * 2 for r, c in mats)        # 8-bit m + v
    largest_grad = max(r * c for r, c in mats) * 2             # BF16, one live at a time
    embed_grad = v * h * 2 * 2                                 # embed+lm_head stay dense BF16
    embed_opt = v * h * 2 * 2                                  # their 8-bit m+v
    return proj + states + largest_grad + embed_grad + embed_opt


def main():
    meta = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else dict(
        params=7_615_616_512, hidden=3584, inter=18944, vocab=152064,
        layers=28, attn_heads=28, kv_heads=4,
    )
    P = meta["params"]
    budget_gib = 48.0
    headroom_gib = 4.0

    print(f"P = {P:,} parameters ({P/1e9:.4f} B)")
    print(f"1 byte/param = {P/GIB:.4f} GiB\n")
    rows = []
    for key, c in CONFIGS.items():
        per_param = c["w"] + c["g"] + c["master"] + c["m"] + c["v"]
        static = per_param * P
        extra = 0.0
        if key.startswith("4_"):
            extra = factored_second_moment_bytes(meta)
        elif key.startswith("5_"):
            extra = galore_extra_bytes(meta)
        total = (static + extra) / GIB
        fits = total <= (budget_gib - headroom_gib)
        rows.append((key, c, per_param, total, extra / GIB, fits))
        print(f"{key}")
        print(f"  {c['label']}")
        print(f"  bytes/param = {c['w']}(w) + {c['g']}(g) + {c['master']}(master) "
              f"+ {c['m']}(m) + {c['v']}(v) = {per_param}")
        print(f"  static state       = {total - extra/GIB:8.2f} GiB")
        if extra:
            print(f"  non-per-param extra= {extra/GIB:8.2f} GiB")
        print(f"  TOTAL (excl. acts) = {total:8.2f} GiB")
        print(f"  clears 48 GiB with 4 GiB headroom (<= 44.00 GiB)? "
              f"{'YES' if fits else 'NO'}\n")

    json.dump(
        [dict(config=k, label=c["label"], bytes_per_param=pp,
              total_gib=round(t, 3), extra_gib=round(e, 3), fits_44gib=f)
         for k, c, pp, t, e, f in rows],
        open("scripts/memory_audit/out_estimates.json", "w"), indent=2)


if __name__ == "__main__":
    main()
