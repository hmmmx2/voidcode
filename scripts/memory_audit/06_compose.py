"""Step 3/5 — Validate the estimator on measured data, then extrapolate to the 7.6B target.

Activation model (all terms measured on this machine, not assumed):

  A(L, h, inter, V, b, s) = L*b*s*h*2            gradient-checkpoint boundaries
                          + K*b*s*inter*2 + C    within-layer recompute peak
                          + b*s*V*LOGIT_B        loss head (logits + fp32 upcast + grad)

K, C and LOGIT_B are fitted from scripts 05 (synthetic sweeps); the composed model
is then tested against real Qwen2.5-0.5B / 1.5B checkpoints.
"""
import json

GIB = 1024 ** 3

# ---- Fitted from out_arch.jsonl (real 7B hidden geometry, vocab=1024 sweep) ----
K_RECOMPUTE = 6.846           # copies of the [b,s,inter] bf16 tensor held at peak
C_RECOMPUTE_GIB = 0.129       # seq-independent workspace
# ---- Fitted from out_logits.jsonl (real vocab, tiny hidden) --------------------
LOGIT_BYTES = 13.83           # bytes per (token x vocab) element at peak

STATIC_BIAS = 1.025           # measured static ran 0.5-2.5% above the pure formula

MODELS = {
    "Qwen2.5-0.5B-Instruct": dict(P=494_032_768, L=24, h=896, inter=4864, V=151936),
    "Qwen2.5-1.5B-Instruct": dict(P=1_543_714_304, L=28, h=1536, inter=8960, V=151936),
    "Qwen2.5-7B-Instruct":   dict(P=7_615_616_512, L=28, h=3584, inter=18944, V=152064),
}

BYTES_PER_PARAM = {
    "1_adamw_fp32_bf16mixed": 16,
    "2_adamw8bit_gc": 10,
    "3_adamw8bit_no_master": 6,
    "4_adafactor_bf16_gc": 4,
}


def activation_gib(m, s, b=1):
    ckpt = m["L"] * b * s * m["h"] * 2
    recompute = K_RECOMPUTE * b * s * m["inter"] * 2 + C_RECOMPUTE_GIB * GIB
    logits = b * s * m["V"] * LOGIT_BYTES
    return (ckpt + recompute + logits) / GIB


def galore_static_gib(m, rank=128):
    """BF16 weights + rank-r projections/states + dense embed & lm_head handling."""
    h, i, V, L = m["h"], m["inter"], m["V"], m["L"]
    w = m["P"] * 2
    mats = []
    for _ in range(L):
        mats += [(h, h), (h, h), (i, h), (i, h), (h, i)]
    proj = sum(min(r, c) * rank * 4 for r, c in mats)
    st = sum(min(r, c) * rank * 2 for r, c in mats)
    largest = max(r * c for r, c in mats) * 2
    dense = V * h * 2 * 2 * 2          # embed+lm_head grads and 8-bit states
    return (w + proj + st + largest + dense) / GIB


def main():
    print("=" * 78)
    print("ESTIMATOR VALIDATION - activation model vs measured (real checkpoints)")
    print("=" * 78)
    measured_act = {   # from 05_arch_probe --pretrained, grads resident
        ("Qwen2.5-0.5B-Instruct", 1024): 2.0822,
        ("Qwen2.5-0.5B-Instruct", 4096): 8.3248,
        ("Qwen2.5-1.5B-Instruct", 1024): 2.1294,
        ("Qwen2.5-1.5B-Instruct", 4096): 8.5079,
    }
    print(f"{'model':24s} {'seq':>5s} {'pred GiB':>9s} {'meas GiB':>9s} {'err %':>8s}")
    worst = 0.0
    for (name, s), meas in sorted(measured_act.items()):
        pred = activation_gib(MODELS[name], s)
        err = 100 * (pred - meas) / meas
        worst = max(worst, abs(err))
        print(f"{name:24s} {s:5d} {pred:9.3f} {meas:9.3f} {err:+8.2f}")
    print(f"\nworst absolute activation error: {worst:.2f}%  "
          f"({'PASS' if worst <= 15 else 'FAIL'} the 15% gate)")

    print("\n" + "=" * 78)
    print("STATIC-STATE VALIDATION - bytes/param formula vs measured")
    print("=" * 78)
    static_meas = {
        ("Qwen2.5-0.5B-Instruct", "1_adamw_fp32_bf16mixed"): 7.399,
        ("Qwen2.5-0.5B-Instruct", "2_adamw8bit_gc"): 4.648,
        ("Qwen2.5-0.5B-Instruct", "3_adamw8bit_no_master"): 2.817,
        ("Qwen2.5-0.5B-Instruct", "4_adafactor_bf16_gc"): 1.886,
        ("Qwen2.5-1.5B-Instruct", "2_adamw8bit_gc"): 14.445,
        ("Qwen2.5-1.5B-Instruct", "3_adamw8bit_no_master"): 8.810,
        ("Qwen2.5-1.5B-Instruct", "4_adafactor_bf16_gc"): 5.776,
    }
    print(f"{'model':24s} {'config':24s} {'pred':>8s} {'meas':>8s} {'err %':>8s}")
    sworst = 0.0
    for (name, cfg), meas in sorted(static_meas.items()):
        pred = BYTES_PER_PARAM[cfg] * MODELS[name]["P"] / GIB
        err = 100 * (pred - meas) / meas
        sworst = max(sworst, abs(err))
        print(f"{name:24s} {cfg:24s} {pred:8.3f} {meas:8.3f} {err:+8.2f}")
    print(f"\nworst absolute static error: {sworst:.2f}%  "
          f"({'PASS' if sworst <= 15 else 'FAIL'} the 15% gate)")
    for name, cfg in [("Qwen2.5-0.5B-Instruct", "galore"),
                      ("Qwen2.5-1.5B-Instruct", "galore")]:
        pred = galore_static_gib(MODELS[name])
        meas = {"Qwen2.5-0.5B-Instruct": 1.7198,
                "Qwen2.5-1.5B-Instruct": 4.3504}[name]
        print(f"{name:24s} {'5_galore_r128':24s} {pred:8.3f} {meas:8.3f} "
              f"{100*(pred-meas)/meas:+8.2f}")

    print("\n" + "=" * 78)
    print("TARGET: Qwen2.5-7B-Instruct (P = 7,615,616,512) on a 48 GiB A6000")
    print("=" * 78)
    m7 = MODELS["Qwen2.5-7B-Instruct"]
    CAP, HEAD = 48.0, 4.0
    print(f"{'config':30s} {'seq':>5s} {'static':>8s} {'act':>7s} {'PEAK':>8s} "
          f"{'free@48':>8s}  verdict")
    out = []
    for cfg, bpp in list(BYTES_PER_PARAM.items()) + [("5_galore_r128_8bit_layerwise", None)]:
        for s in (1024, 2048, 4096):
            static = (galore_static_gib(m7) if bpp is None
                      else bpp * m7["P"] / GIB) * STATIC_BIAS
            act = activation_gib(m7, s)
            peak = static + act
            free = CAP - peak
            ok = peak <= CAP - HEAD
            print(f"{cfg:30s} {s:5d} {static:8.2f} {act:7.2f} {peak:8.2f} "
                  f"{free:8.2f}  {'FITS' if ok else 'DOES NOT FIT'}")
            out.append(dict(config=cfg, seq=s, static_gib=round(static, 2),
                            activation_gib=round(act, 2), peak_gib=round(peak, 2),
                            free_at_48gib=round(free, 2), fits_with_4gib_headroom=ok))
        print()
    json.dump(out, open("scripts/memory_audit/out_7b_projection.json", "w"), indent=2)


if __name__ == "__main__":
    main()
