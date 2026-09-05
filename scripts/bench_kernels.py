"""Throughput and peak memory for both kernels, against the baseline each must actually beat.

Run on a datacenter card. The local box is WDDM, where a wall-clock figure is not quotable, so this
is the measurement that decides whether each kernel is kept — and specifically whether the RMSNorm
kernel, which reached only memory *parity* with `F.rms_norm`, earns its place on speed instead.

Baselines are the real PyTorch ops, not the eager oracles in the test suite. Beating a deliberately
naive reference proves nothing; that mistake was already made once here.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from training.kernels.cross_entropy import fused_available, fused_cross_entropy
from training.kernels.rmsnorm import fused_add_rmsnorm

IGNORE_INDEX = -100


def timed(fn, iters=30, warmup=8):
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    start = time.perf_counter()
    for _ in range(iters):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - start) / iters * 1000.0  # ms/iter


def peak_of(fn):
    torch.cuda.synchronize()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    before = torch.cuda.memory_allocated()
    fn()
    torch.cuda.synchronize()
    return (torch.cuda.max_memory_allocated() - before) / 1024**2


def bench_cross_entropy(rows=512, vocab=152064):
    torch.manual_seed(0)
    target = torch.randint(0, vocab, (rows,), device="cuda")

    def make(fn):
        def step():
            x = torch.randn(rows, vocab, device="cuda", dtype=torch.bfloat16, requires_grad=True)
            loss = fn(x * 1.0, target, ignore_index=IGNORE_INDEX, reduction="mean")
            loss.backward()
        return step

    return {
        "shape": [rows, vocab],
        "baseline_ms": timed(make(F.cross_entropy)),
        "fused_ms": timed(make(fused_cross_entropy)),
        "baseline_peak_mib": peak_of(make(F.cross_entropy)),
        "fused_peak_mib": peak_of(make(fused_cross_entropy)),
    }


def bench_rmsnorm(rows=2048, cols=3584):
    def native(x, res, w, eps):
        r = x + res
        return F.rms_norm(r, (r.shape[-1],), w, eps), r

    def make(fn):
        def step():
            torch.manual_seed(0)
            x = torch.randn(rows, cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
            res = torch.randn(rows, cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
            w = torch.randn(cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
            y, _ = fn(x, res, w, 1e-6)
            y.backward(torch.ones_like(y))
        return step

    return {
        "shape": [rows, cols],
        "baseline_ms": timed(make(native), iters=20),
        "fused_ms": timed(make(fused_add_rmsnorm), iters=20),
        "baseline_peak_mib": peak_of(make(native)),
        "fused_peak_mib": peak_of(make(fused_add_rmsnorm)),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    if not fused_available():
        print("Triton unavailable — refusing to report numbers that would be the baseline twice")
        return 1

    props = torch.cuda.get_device_properties(0)
    record = {
        "spec": args.spec,
        "device": props.name,
        "capability": f"{props.major}.{props.minor}",
        "torch": torch.__version__,
        "cross_entropy": bench_cross_entropy(),
        "rmsnorm": bench_rmsnorm(),
    }

    for name in ("cross_entropy", "rmsnorm"):
        r = record[name]
        r["speedup"] = round(r["baseline_ms"] / r["fused_ms"], 3)
        r["memory_saved_pct"] = round((1 - r["fused_peak_mib"] / r["baseline_peak_mib"]) * 100, 1)
        print(f"\n{name}  shape={r['shape']}")
        print(f"  time    baseline {r['baseline_ms']:8.3f} ms   fused {r['fused_ms']:8.3f} ms   "
              f"speedup {r['speedup']:.2f}x")
        print(f"  memory  baseline {r['baseline_peak_mib']:8.1f} MiB  fused {r['fused_peak_mib']:8.1f} MiB  "
              f"saved {r['memory_saved_pct']:+.1f}%")

    if args.out:
        Path(args.out).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
