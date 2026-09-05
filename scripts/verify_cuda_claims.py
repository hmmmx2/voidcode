"""Measure the factual claims in the CUDA content items. Runs ON THE POD.

These items are rubric-graded design questions, so there is no reference solution to compile. What
they DO have is specific factual assertions, and an interview-prep platform asserting a wrong number
is worse than one asserting nothing. This measures them.

Any claim that fails here gets the ITEM corrected, not the measurement explained away.
"""
import time

import torch

DEV = "cuda"
torch.backends.cuda.matmul.allow_tf32 = False   # measure fp32 as fp32, not as tf32


def timed(fn, warmup=10, iters=50):
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - t0) / iters


def banner(n, title):
    print(f"\n{'='*72}\nCLAIM {n}: {title}\n{'='*72}")


# ── Claim 1: tensor-core-eligibility-design ─────────────────────────────────
banner(1, "K=4093 and fp32 keep a matmul off the tensor cores")
print("  item asserts: dtype must be reduced precision, and dims should be multiples")
print("  of the MMA tile (8/16). K=4093 is the trap.\n")
M = N = 4096
for dtype, label in ((torch.float32, "fp32"), (torch.bfloat16, "bf16")):
    for K, kind in ((4096, "aligned  "), (4093, "unaligned")):
        a = torch.randn(M, K, device=DEV, dtype=dtype)
        b = torch.randn(K, N, device=DEV, dtype=dtype)
        t = timed(lambda a=a, b=b: torch.mm(a, b))
        tflops = (2 * M * N * K) / t / 1e12
        print(f"  {label} K={K} {kind}  {t*1e3:7.2f} ms   {tflops:7.2f} TFLOP/s")
        del a, b
        torch.cuda.empty_cache()
print("\n  also: tf32 enabled (what torch does by default for fp32 matmul)")
torch.backends.cuda.matmul.allow_tf32 = True
a = torch.randn(M, 4096, device=DEV, dtype=torch.float32)
b = torch.randn(4096, N, device=DEV, dtype=torch.float32)
t = timed(lambda a=a, b=b: torch.mm(a, b))
print(f"  fp32+tf32 K=4096          {t*1e3:7.2f} ms   {(2*M*N*4096)/t/1e12:7.2f} TFLOP/s")
torch.backends.cuda.matmul.allow_tf32 = False
del a, b
torch.cuda.empty_cache()


# ── Claim 2: kernel-launch-overhead-design ──────────────────────────────────
banner(2, "per-launch overhead is roughly 5 microseconds")
print("  item asserts: 400 launches x 5us = a 2 ms floor per forward pass,")
print("  invisible to the roofline model.\n")
x = torch.randn(1024, device=DEV)          # tiny: cost is launch, not work
def one_launch():
    x.add_(1.0)
per = timed(one_launch, warmup=100, iters=2000)
print(f"  measured per-launch: {per*1e6:6.2f} us")
print(f"  implied floor for 400 launches: {per*400*1e3:6.3f} ms")

def four_hundred():
    for _ in range(400):
        x.add_(1.0)
seq = timed(four_hundred, warmup=5, iters=20)
print(f"  400 sequential launches, measured: {seq*1e3:6.3f} ms")

g = torch.cuda.CUDAGraph()
torch.cuda.synchronize()
s = torch.cuda.Stream()
s.wait_stream(torch.cuda.current_stream())
with torch.cuda.stream(s):
    for _ in range(3):
        four_hundred()
torch.cuda.current_stream().wait_stream(s)
with torch.cuda.graph(g):
    for _ in range(400):
        x.add_(1.0)
graphed = timed(lambda: g.replay(), warmup=5, iters=20)
print(f"  same 400 via CUDA graph:           {graphed*1e3:6.3f} ms"
      f"   ({seq/graphed:.1f}x faster)")


# ── Claim 3: flashattention-online-softmax-design ───────────────────────────
banner(3, "the online (tiled) softmax is EXACT, not an approximation")
print("  item asserts: running max + running sum with rescaling reproduces softmax")
print("  exactly; no scores are dropped, only the accumulation order changes.\n")

def online_attention(q, k, v, block=128):
    """FlashAttention's accumulation, written plainly: one pass over key/value blocks."""
    n, d = k.shape
    m = torch.full((q.shape[0],), float("-inf"), device=q.device, dtype=torch.float32)
    l_sum = torch.zeros(q.shape[0], device=q.device, dtype=torch.float32)
    acc = torch.zeros(q.shape[0], d, device=q.device, dtype=torch.float32)
    for start in range(0, n, block):
        kb = k[start:start + block]
        vb = v[start:start + block]
        s = (q.float() @ kb.float().T) / (d ** 0.5)
        m_new = torch.maximum(m, s.max(dim=-1).values)
        # the rescale: everything accumulated so far is re-based onto the new maximum
        alpha = torch.exp(m - m_new)
        p = torch.exp(s - m_new[:, None])
        l_sum = l_sum * alpha + p.sum(dim=-1)
        acc = acc * alpha[:, None] + p @ vb.float()
        m = m_new
    return acc / l_sum[:, None]

torch.manual_seed(0)
Q, KV, D = 256, 2048, 64
q = torch.randn(Q, D, device=DEV)
k = torch.randn(KV, D, device=DEV)
v = torch.randn(KV, D, device=DEV)
ref = torch.softmax((q.float() @ k.float().T) / (D ** 0.5), dim=-1) @ v.float()
for block in (64, 128, 512, 2048):
    out = online_attention(q, k, v, block=block)
    err = (out - ref).abs().max().item()
    print(f"  block={block:5d}  max abs diff vs full softmax = {err:.3e}")
print(f"\n  fp32 epsilon for reference: {torch.finfo(torch.float32).eps:.3e}")
print("  (a true approximation would show error that GROWS as the block shrinks)")

print("\nDONE")
