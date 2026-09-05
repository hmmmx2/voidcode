"""Fused residual-add + RMSNorm in Triton.

WHY FUSE THE ADD IN, RATHER THAN JUST THE NORM
----------------------------------------------
RMSNorm is arithmetically trivial and entirely **memory-bandwidth-bound**, so the only thing worth
optimising is the number of times `[N, D]` crosses the memory bus. Eager PyTorch does:

    r = x + residual              read  2x[N,D], write [N,D]
    v = r.pow(2).mean(-1)         read  [N,D],   write [N]      (pow allocates another [N,D])
    n = r * rsqrt(v + eps)        read  [N,D],   write [N,D]
    y = n * weight                read  [N,D],   write [N,D]

Roughly seven `[N, D]` traversals and three temporaries. Fused: **two reads, two writes, one pass**.
The residual add belongs inside because `r` is needed twice — once as the norm's input and once as
the residual stream carried to the next block — and materialising it separately is the single
biggest avoidable cost here.

This is why the kernel returns **both** `y` and `r`. A version returning only `y` forces the caller
to recompute or re-materialise the residual, giving back the saving.

WHAT IS EASY TO GET WRONG
-------------------------
  fp32 accumulation   Qwen-7B has D=3584. Summing 3584 squares in bf16 loses the tail, and the
                      error lands in a *denominator*, so it scales the entire row. Accumulate in
                      fp32 regardless of input dtype.
  the backward term   d(r) is NOT simply `dy * w / rms`. RMS depends on every element of the row,
                      so there is a second term: `(dn - n * mean(dn * n)) / rms`. Dropping it gives
                      gradients that are correct in direction and wrong in magnitude — training
                      still converges, more slowly, and nothing announces the bug.
  the residual path   `r` is used twice, so its gradient is the sum of the norm's contribution and
                      whatever flows back from the next block. Missing the second is silent.
  dweight reduction   summed across rows. Done via per-block partials and a final `sum(0)` rather
                      than `atomic_add`, because atomics reorder float additions run-to-run and
                      P2b's gradient check wants near-bitwise reproducibility. The strip width is
                      load-bearing: at 4 rows per program the partial buffer was 7 MiB and made
                      this kernel *worse* than eager on peak memory.

MEASURED RESULT, AND IT IS NOT A WIN
------------------------------------
**This kernel does not beat `torch.nn.functional.rms_norm` on memory.** At 2048x3584 bf16, peak is
70.0 MiB for `F.rms_norm` against 70.1 MiB fused -- parity, not an improvement. PyTorch already
ships a fused rms_norm, so the only thing left to fuse was the residual add, and that is not where
the memory is.

The memory audit said as much before this was written: the loss head is 2.04 GiB of 2.57 GiB and all
28 transformer layers together are 0.19 GiB. This optimises inside the 7%. It is kept because it is
correct, tested, and cheap to keep, and because the remaining possible justification -- fewer kernel
launches and one pass over `[N, D]` instead of several -- is a *throughput* claim, and no throughput
figure may be quoted from this WDDM box. That measurement needs the A40.

Every one of those has a test in `tests/test_rmsnorm.py` that fails when the term is removed.

Linux only, like all Triton work here — see D-010. Imports cleanly without Triton and falls back to
an eager implementation; `fused_available()` reports which one you got.
"""
from __future__ import annotations

import torch

try:
    import triton
    import triton.language as tl

    _HAVE_TRITON = True
except ImportError:  # pragma: no cover - exercised by being on Windows
    triton = None
    tl = None
    _HAVE_TRITON = False


def fused_available() -> bool:
    return _HAVE_TRITON and torch.cuda.is_available()


def eager_add_rmsnorm(x, residual, weight, eps: float = 1e-6):
    """Reference. Deliberately written the obvious way, in fp32, as the oracle."""
    r = x + residual
    var = r.float().pow(2).mean(-1, keepdim=True)
    n = r.float() * torch.rsqrt(var + eps)
    return (n * weight.float()).to(x.dtype), r


if _HAVE_TRITON:

    @triton.jit
    def _fwd(x_ptr, res_ptr, w_ptr, y_ptr, r_ptr, rstd_ptr,
             stride, n_cols, eps, BLOCK: tl.constexpr):
        row = tl.program_id(0)
        cols = tl.arange(0, BLOCK)
        mask = cols < n_cols

        x = tl.load(x_ptr + row * stride + cols, mask=mask, other=0.0).to(tl.float32)
        res = tl.load(res_ptr + row * stride + cols, mask=mask, other=0.0).to(tl.float32)
        r = x + res
        # Store the residual stream: the caller needs it, and recomputing it downstream would
        # undo the fusion.
        tl.store(r_ptr + row * stride + cols, r.to(r_ptr.dtype.element_ty), mask=mask)

        # fp32 mean of squares, always.
        var = tl.sum(tl.where(mask, r * r, 0.0), axis=0) / n_cols
        rstd = 1.0 / tl.sqrt(var + eps)
        tl.store(rstd_ptr + row, rstd)

        w = tl.load(w_ptr + cols, mask=mask, other=0.0).to(tl.float32)
        tl.store(y_ptr + row * stride + cols, (r * rstd * w).to(y_ptr.dtype.element_ty), mask=mask)

    @triton.jit
    def _bwd(dy_ptr, dr_out_ptr, r_ptr, w_ptr, rstd_ptr,
             dr_ptr, dw_partial_ptr,
             stride, n_cols, n_rows, ROWS: tl.constexpr, BLOCK: tl.constexpr):
        pid = tl.program_id(0)
        cols = tl.arange(0, BLOCK)
        mask = cols < n_cols
        w = tl.load(w_ptr + cols, mask=mask, other=0.0).to(tl.float32)

        # Each program owns a strip of rows and keeps its dweight partial in registers, so the
        # cross-row reduction is a deterministic tree rather than a race of atomics.
        dw_acc = tl.zeros([BLOCK], dtype=tl.float32)

        for i in range(ROWS):
            row = pid * ROWS + i
            if row < n_rows:
                off = row * stride + cols
                dy = tl.load(dy_ptr + off, mask=mask, other=0.0).to(tl.float32)
                r = tl.load(r_ptr + off, mask=mask, other=0.0).to(tl.float32)
                rstd = tl.load(rstd_ptr + row)

                n = r * rstd
                dw_acc += dy * n

                dn = dy * w
                # The term that is easy to drop: RMS depends on the whole row.
                mean_dn_n = tl.sum(tl.where(mask, dn * n, 0.0), axis=0) / n_cols
                dr = (dn - n * mean_dn_n) * rstd

                # r feeds the next block too, so add whatever came back from there.
                dr += tl.load(dr_out_ptr + off, mask=mask, other=0.0).to(tl.float32)
                tl.store(dr_ptr + off, dr.to(dr_ptr.dtype.element_ty), mask=mask)

        tl.store(dw_partial_ptr + pid * n_cols + cols, dw_acc, mask=mask)


class _FusedAddRMSNorm(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, residual, weight, eps):
        x = x.contiguous()
        residual = residual.contiguous()
        n_rows, n_cols = x.shape
        BLOCK = triton.next_power_of_2(n_cols)
        if BLOCK > 65536:
            raise ValueError(f"hidden size {n_cols} exceeds this kernel's single-block design")

        y = torch.empty_like(x)
        r = torch.empty_like(x)
        rstd = torch.empty(n_rows, dtype=torch.float32, device=x.device)

        _fwd[(n_rows,)](x, residual, weight, y, r, rstd,
                        x.stride(0), n_cols, eps, BLOCK=BLOCK, num_warps=8)

        ctx.save_for_backward(r, weight, rstd)
        ctx.eps, ctx.block, ctx.n_cols = eps, BLOCK, n_cols
        return y, r

    @staticmethod
    def backward(ctx, dy, dr_out):
        r, weight, rstd = ctx.saved_tensors
        n_rows, n_cols = r.shape
        dy = dy.contiguous()
        # `r` may be the final residual with nothing downstream, in which case autograd hands us
        # None rather than zeros.
        dr_out = torch.zeros_like(r) if dr_out is None else dr_out.contiguous()

        # 256 rows per program keeps dw_partial at ~0.1 MiB. At ROWS=4 the partial buffer was
        # 7 MiB and made this kernel measurably *worse* than F.rms_norm on peak memory.
        ROWS = 256
        n_programs = triton.cdiv(n_rows, ROWS)
        dr = torch.empty_like(r)
        dw_partial = torch.empty(n_programs, n_cols, dtype=torch.float32, device=r.device)

        _bwd[(n_programs,)](dy, dr_out, r, weight, rstd, dr, dw_partial,
                            r.stride(0), n_cols, n_rows,
                            ROWS=ROWS, BLOCK=ctx.block, num_warps=8)

        dw = dw_partial.sum(0).to(weight.dtype)
        # x and residual both received r, so both get the same gradient.
        return dr, dr, dw, None


def fused_add_rmsnorm(x, residual, weight, eps: float = 1e-6):
    """``(x + residual)`` normalised and scaled, plus the residual itself.

    Returns ``(y, r)`` where ``r = x + residual``. Falls back to the eager reference when Triton is
    unavailable, and ``fused_available()`` says which path ran.
    """
    if x.shape != residual.shape:
        raise ValueError(f"x {tuple(x.shape)} and residual {tuple(residual.shape)} must match")
    if not fused_available():
        return eager_add_rmsnorm(x, residual, weight, eps)
    return _FusedAddRMSNorm.apply(x, residual, weight, eps)
