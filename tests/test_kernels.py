"""The fused cross-entropy kernel, against `F.cross_entropy` as the oracle.

A kernel is only worth having if it is (a) numerically the same and (b) actually cheaper. Both are
asserted here, because "it ran and the loss looked plausible" is how a subtly wrong loss ships.

The gradient tests deliberately route through an **intermediate** tensor rather than a leaf. The
kernel writes its gradient in place over the logits — that is the entire memory saving — and in a
real model the logits are the output of the LM head, never a leaf. Testing against a leaf would
either alias `.grad` onto the input's storage or trip autograd's version counter, and in both cases
would be testing a situation that never occurs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch", reason="needs torch")
import torch.nn.functional as F  # noqa: E402

from training.kernels.cross_entropy import (  # noqa: E402
    IGNORE_INDEX,
    fused_available,
    fused_cross_entropy,
)

pytestmark = pytest.mark.skipif(
    not fused_available(),
    reason="Triton + CUDA required; Triton has no official Windows build, so this runs under WSL2",
)

# Small enough to be quick, wide enough to exercise the multi-block path in the kernel.
N, V = 128, 32000


def logits_and_target(seed: int = 0, dtype=torch.bfloat16, masked: int = 0):
    torch.manual_seed(seed)
    x = torch.randn(N, V, device="cuda", dtype=dtype, requires_grad=True)
    target = torch.randint(0, V, (N,), device="cuda")
    if masked:
        target[:masked] = IGNORE_INDEX
    return x, target


def both_ways(x, target, reduction="mean"):
    """Loss and input-gradient from each implementation, via an intermediate as a model would."""
    out = {}
    for name, fn in (("ref", F.cross_entropy), ("fused", fused_cross_entropy)):
        x_ = x.detach().clone().requires_grad_(True)
        logits = x_ * 1.0  # intermediate: what an LM head produces
        loss = fn(logits, target, ignore_index=IGNORE_INDEX, reduction=reduction)
        (loss if loss.ndim == 0 else loss.sum()).backward()
        out[name] = (loss.detach().clone(), x_.grad.detach().clone())
    return out["ref"], out["fused"]


@pytest.mark.parametrize("reduction", ["mean", "sum"])
def test_loss_matches_the_reference(reduction: str) -> None:
    """`mean` and `sum` only — see the next test for why `none` cannot be compared this way."""
    x, target = logits_and_target()
    (ref_loss, _), (fused_loss, _) = both_ways(x, target, reduction)
    torch.testing.assert_close(fused_loss.float(), ref_loss.float(), rtol=2e-3, atol=2e-3)


def test_unreduced_loss_beats_the_bf16_reference() -> None:
    """`reduction="none"` cannot be checked against `F.cross_entropy` directly, and finding out
    why was worth more than the test.

    The naive version of this compared the two element-wise and failed by 0.031 absolute. The
    kernel was not wrong: `F.cross_entropy` returns **bf16** when unreduced, and a loss of
    12.468737 is simply not representable there — the nearest bf16 is 12.437500, and the gap is
    0.03123664855957, which is exactly the observed error. `mean` and `sum` hide this because
    PyTorch reduces in fp32.

    This kernel keeps its per-row losses in fp32, so the correct oracle is an fp32
    `F.cross_entropy`, and the honest assertion is not "we match the reference" but **"we are
    closer to the truth than the reference is"**.
    """
    x, target = logits_and_target()
    exact = F.cross_entropy(x.detach().float(), target, ignore_index=IGNORE_INDEX, reduction="none")
    ref = F.cross_entropy(x.detach(), target, ignore_index=IGNORE_INDEX, reduction="none")
    fused = fused_cross_entropy(x.detach().clone(), target, ignore_index=IGNORE_INDEX, reduction="none")

    assert fused.dtype is torch.float32, "unreduced losses must stay fp32 or this claim collapses"

    ref_err = (ref.float() - exact).abs().max()
    fused_err = (fused - exact).abs().max()
    print(f"\n  bf16 reference off by {ref_err:.6f}   fused off by {fused_err:.6f}")

    torch.testing.assert_close(fused, exact, rtol=1e-5, atol=1e-4)
    assert fused_err * 100 < ref_err, (
        f"fused ({fused_err:.6f}) should be far closer to the fp32 truth than the bf16 "
        f"reference ({ref_err:.6f}); if it is not, the fp32 accumulation is not working"
    )


@pytest.mark.parametrize("reduction", ["mean", "sum"])
def test_gradient_matches_the_reference(reduction: str) -> None:
    x, target = logits_and_target()
    (_, ref_grad), (_, fused_grad) = both_ways(x, target, reduction)
    torch.testing.assert_close(fused_grad.float(), ref_grad.float(), rtol=2e-3, atol=2e-3)


def test_masked_rows_contribute_no_loss_and_no_gradient() -> None:
    """The silent one. Getting loss right and gradient wrong trains on padding invisibly.

    Multipack makes this the common case rather than an edge case — every packed batch is full of
    prompt tokens masked out of the loss.
    """
    x, target = logits_and_target(masked=32)
    (ref_loss, ref_grad), (fused_loss, fused_grad) = both_ways(x, target, "mean")

    torch.testing.assert_close(fused_loss.float(), ref_loss.float(), rtol=2e-3, atol=2e-3)
    # Exactly zero, not merely small.
    assert fused_grad[:32].abs().max().item() == 0.0
    # And the unmasked rows are untouched by the masking.
    torch.testing.assert_close(fused_grad[32:].float(), ref_grad[32:].float(), rtol=2e-3, atol=2e-3)


def test_mean_divides_by_unmasked_count_not_row_count() -> None:
    """Dividing by N would scale every gradient by how well the batch happened to pack.

    Asserted by construction rather than by comparison: with half the rows masked, `mean` must equal
    `sum / (N/2)`. If the kernel divided by N the ratio would be 2x and the test above could still
    pass, because both implementations would agree on the *loss* while disagreeing with `sum`.
    """
    x, target = logits_and_target(masked=N // 2)

    x_ = x.detach().clone().requires_grad_(True)
    mean = fused_cross_entropy(x_ * 1.0, target, ignore_index=IGNORE_INDEX, reduction="mean")
    x2 = x.detach().clone().requires_grad_(True)
    total = fused_cross_entropy(x2 * 1.0, target, ignore_index=IGNORE_INDEX, reduction="sum")

    torch.testing.assert_close(mean.float(), (total / (N // 2)).float(), rtol=1e-4, atol=1e-4)


def test_every_row_masked_is_zero_rather_than_nan() -> None:
    """A fully-masked batch is rare but real, and 0/0 would poison the whole run."""
    x, target = logits_and_target(masked=N)
    loss = fused_cross_entropy(x * 1.0, target, ignore_index=IGNORE_INDEX, reduction="mean")

    assert torch.isfinite(loss).all(), "a fully-masked batch produced a non-finite loss"
    assert loss.item() == 0.0


def test_bf16_accumulates_in_fp32() -> None:
    """Summing 32k exponentials in bf16 loses the tail; the kernel must not.

    Compared against an fp32 reference rather than a bf16 one, so bf16 accumulation would show up as
    disagreement with the true value instead of two implementations being wrong together.
    """
    x, target = logits_and_target(dtype=torch.bfloat16)

    x_ = x.detach().clone().requires_grad_(True)
    fused = fused_cross_entropy(x_ * 1.0, target, ignore_index=IGNORE_INDEX, reduction="mean")
    exact = F.cross_entropy(x.detach().float(), target, ignore_index=IGNORE_INDEX, reduction="mean")

    torch.testing.assert_close(fused.float(), exact, rtol=5e-3, atol=5e-3)


def test_it_actually_uses_less_memory() -> None:
    """The whole point, measured. A correct kernel that saves nothing is not worth maintaining."""
    big_v = 152064  # Qwen2.5's vocabulary, which is what makes this worth doing
    rows = 512
    torch.manual_seed(0)
    target = torch.randint(0, big_v, (rows,), device="cuda")

    def peak(fn) -> int:
        x = torch.randn(rows, big_v, device="cuda", dtype=torch.bfloat16, requires_grad=True)
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        before = torch.cuda.memory_allocated()
        loss = fn(x * 1.0, target, ignore_index=IGNORE_INDEX, reduction="mean")
        loss.backward()
        torch.cuda.synchronize()
        used = torch.cuda.max_memory_allocated() - before
        del x, loss
        return used

    ref = peak(F.cross_entropy)
    fused = peak(fused_cross_entropy)
    mib = 1024**2
    print(f"\n  reference {ref/mib:8.1f} MiB   fused {fused/mib:8.1f} MiB   saved {(ref-fused)/mib:8.1f} MiB")

    assert fused < ref, f"fused used {fused/mib:.1f} MiB vs reference {ref/mib:.1f} MiB — no saving"
