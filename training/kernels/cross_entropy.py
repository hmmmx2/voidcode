"""Fused cross-entropy in Triton: the kernel the memory audit actually asked for.

WHY THIS ONE FIRST
------------------
Not because loss kernels are fashionable. Because the measurement says so: at sequence length 1024,
**2.04 GiB of 2.57 GiB** of activation memory is the loss head, and all 28 transformer layers
together are 0.19 GiB. Fusing attention would optimise the 7%.

WHERE THE MEMORY GOES
---------------------
`F.cross_entropy(logits, target)` on an ``[N, V]`` logits tensor -- with Qwen's V of ~152k, N of
1024, that is already ~300 MiB in bf16 -- does roughly this:

    log_softmax(logits)     ->  a second [N, V] tensor, in fp32, so ~600 MiB
    stored for backward     ->  that second tensor is kept alive until backward
    backward                ->  a third [N, V] for the gradient

Three tensors of the largest shape in the model. The fused version keeps **one**: it computes the
log-sum-exp per row into an ``[N]`` vector during forward, and in backward recomputes the softmax
from the logits it already has and writes the gradient **in place over the logits**. Peak drops from
~3x[N,V] to 1x[N,V] plus two [N] vectors.

The trade is arithmetic: the exponentials are computed twice, once in each direction. That is the
right trade when the tensor is 300 MiB and the GPU has 16 or 48 GiB.

WHAT IS EASY TO GET WRONG HERE
------------------------------
  ignore_index   masked positions must contribute exactly zero loss *and* exactly zero gradient.
                 Getting the loss right and the gradient wrong is silent: the loss curve looks
                 correct while padding tokens quietly steer the model. Multipack makes this the
                 common case, not an edge case, since every packed batch is full of them.
  reduction      "mean" must divide by the number of *unmasked* tokens, not by N. Dividing by N
                 scales the whole gradient by a factor that drifts with how well the batch packed.
  fp32 accumul.  the max-subtraction and the sum of exponentials are done in fp32 regardless of the
                 input dtype. In bf16, summing 152k exponentials loses the tail entirely.

Every one of those is a test in `tests/test_kernels.py`, compared against `F.cross_entropy`.

**Triton requires Linux.** There is no official Windows build, and `torch.utils._triton.has_triton()`
reports False on the Windows install. On this machine the kernel work therefore runs under WSL2,
which reaches the same physical GPU. Import of this module is safe without Triton -- the fallback is
`F.cross_entropy`, and `fused_available()` says which one you are getting rather than letting a
silent fallback masquerade as a working kernel.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

try:
    import triton
    import triton.language as tl

    _HAVE_TRITON = True
except ImportError:  # pragma: no cover - exercised by being on Windows
    triton = None
    tl = None
    _HAVE_TRITON = False

IGNORE_INDEX = -100


def fused_available() -> bool:
    """Whether the Triton path can actually run here.

    Checked explicitly so a benchmark cannot report a 'fused' number that was really
    `F.cross_entropy` on a machine without Triton.
    """
    return _HAVE_TRITON and torch.cuda.is_available()


if _HAVE_TRITON:

    @triton.jit
    def _ce_forward(
        logits_ptr, target_ptr, loss_ptr, lse_ptr,
        stride_n,
        n_cols,
        ignore_index,
        BLOCK: tl.constexpr,
    ):
        """One program per row. Two streaming passes, no [N, V] intermediate."""
        row = tl.program_id(0)
        base = logits_ptr + row * stride_n
        target = tl.load(target_ptr + row)

        if target == ignore_index:
            tl.store(loss_ptr + row, 0.0)
            tl.store(lse_ptr + row, 0.0)
            return

        # Pass 1: running max, in fp32 regardless of input dtype.
        row_max = -float("inf")
        for start in range(0, n_cols, BLOCK):
            cols = start + tl.arange(0, BLOCK)
            mask = cols < n_cols
            vals = tl.load(base + cols, mask=mask, other=-float("inf")).to(tl.float32)
            row_max = tl.maximum(row_max, tl.max(vals, axis=0))

        # Pass 2: sum of exp(x - max). Two passes rather than an online update because the
        # streaming variant costs a rescale per block and this is bandwidth-bound anyway.
        acc = 0.0
        for start in range(0, n_cols, BLOCK):
            cols = start + tl.arange(0, BLOCK)
            mask = cols < n_cols
            vals = tl.load(base + cols, mask=mask, other=-float("inf")).to(tl.float32)
            acc += tl.sum(tl.where(mask, tl.exp(vals - row_max), 0.0), axis=0)

        lse = row_max + tl.log(acc)
        target_logit = tl.load(base + target).to(tl.float32)

        tl.store(lse_ptr + row, lse)
        tl.store(loss_ptr + row, lse - target_logit)

    @triton.jit
    def _ce_backward(
        logits_ptr, target_ptr, lse_ptr, grad_out_ptr,
        stride_n,
        n_cols,
        ignore_index,
        scale,
        BLOCK: tl.constexpr,
    ):
        """Writes the gradient **in place over the logits**. That is the memory saving."""
        row = tl.program_id(0)
        base = logits_ptr + row * stride_n
        target = tl.load(target_ptr + row)

        if target == ignore_index:
            # Zero the row: a masked position must not contribute gradient. Leaving the logits
            # in place here would silently train on padding.
            for start in range(0, n_cols, BLOCK):
                cols = start + tl.arange(0, BLOCK)
                tl.store(base + cols, 0.0, mask=cols < n_cols)
            return

        lse = tl.load(lse_ptr + row)
        upstream = tl.load(grad_out_ptr + row).to(tl.float32) * scale

        for start in range(0, n_cols, BLOCK):
            cols = start + tl.arange(0, BLOCK)
            mask = cols < n_cols
            vals = tl.load(base + cols, mask=mask, other=0.0).to(tl.float32)
            # d(loss)/d(logit_j) = softmax_j - 1[j == target]
            grad = tl.exp(vals - lse) - tl.where(cols == target, 1.0, 0.0)
            tl.store(base + cols, (grad * upstream).to(base.dtype.element_ty), mask=mask)


class _FusedCrossEntropy(torch.autograd.Function):
    @staticmethod
    def forward(ctx, logits: torch.Tensor, target: torch.Tensor, ignore_index: int, reduction: str):
        if logits.ndim != 2:
            raise ValueError(f"logits must be [N, V], got {tuple(logits.shape)}")
        logits = logits.contiguous()
        n_rows, n_cols = logits.shape

        loss = torch.empty(n_rows, dtype=torch.float32, device=logits.device)
        lse = torch.empty(n_rows, dtype=torch.float32, device=logits.device)

        BLOCK = 8192 if n_cols >= 8192 else max(128, triton.next_power_of_2(n_cols))
        _ce_forward[(n_rows,)](
            logits, target, loss, lse,
            logits.stride(0), n_cols, ignore_index,
            BLOCK=BLOCK, num_warps=8,
        )

        ctx.save_for_backward(logits, target, lse)
        ctx.ignore_index = ignore_index
        ctx.reduction = reduction
        ctx.block = BLOCK
        # Divide by *unmasked* count, never by n_rows -- see the module docstring.
        ctx.n_valid = int((target != ignore_index).sum())

        if reduction == "mean":
            return loss.sum() / max(ctx.n_valid, 1)
        if reduction == "sum":
            return loss.sum()
        return loss

    @staticmethod
    def backward(ctx, grad_output):
        logits, target, lse = ctx.saved_tensors
        n_rows, n_cols = logits.shape

        if ctx.reduction in ("mean", "sum"):
            per_row = grad_output.expand(n_rows).contiguous().to(torch.float32)
            scale = 1.0 / max(ctx.n_valid, 1) if ctx.reduction == "mean" else 1.0
        else:
            per_row = grad_output.contiguous().to(torch.float32)
            scale = 1.0

        _ce_backward[(n_rows,)](
            logits, target, lse, per_row,
            logits.stride(0), n_cols, ctx.ignore_index, scale,
            BLOCK=ctx.block, num_warps=8,
        )
        # `logits` now holds the gradient. Returned directly: allocating a fresh [N, V] here would
        # give back exactly the memory this kernel exists to save.
        return logits, None, None, None


def fused_cross_entropy(
    logits: torch.Tensor,
    target: torch.Tensor,
    ignore_index: int = IGNORE_INDEX,
    reduction: str = "mean",
) -> torch.Tensor:
    """Drop-in for ``F.cross_entropy`` on ``[N, V]`` logits, minus two ``[N, V]`` tensors.

    Falls back to ``F.cross_entropy`` when Triton is unavailable. **The gradient is written over
    ``logits``**, so do not rely on its value after backward.
    """
    if not fused_available():
        return F.cross_entropy(logits, target, ignore_index=ignore_index, reduction=reduction)
    if reduction not in ("mean", "sum", "none"):
        raise ValueError(f"reduction must be mean/sum/none, got {reduction!r}")
    return _FusedCrossEntropy.apply(logits, target, ignore_index, reduction)
