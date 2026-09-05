"""Fused add+RMSNorm against an fp32 eager oracle.

The interesting assertions are the negative ones. RMSNorm's backward has a term that is easy to
drop — the one accounting for RMS depending on every element of the row — and dropping it produces
gradients with the right direction and the wrong magnitude. Training still converges, more slowly,
and nothing announces it. So there is a test that computes the truncated gradient explicitly and
requires it to *disagree*, which is the only way to know the correct term is doing work.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch", reason="needs torch")

from training.kernels.rmsnorm import (  # noqa: E402
    eager_add_rmsnorm,
    fused_add_rmsnorm,
    fused_available,
)

pytestmark = pytest.mark.skipif(
    not fused_available(), reason="Triton + CUDA required; runs under WSL2 (D-010)"
)

N, D = 256, 3584          # Qwen2.5-7B's hidden size, so the fp32-accumulation claim is real
EPS = 1e-6


def inputs(dtype=torch.bfloat16, seed=0):
    torch.manual_seed(seed)
    x = torch.randn(N, D, device="cuda", dtype=dtype, requires_grad=True)
    res = torch.randn(N, D, device="cuda", dtype=dtype, requires_grad=True)
    w = torch.randn(D, device="cuda", dtype=dtype, requires_grad=True)
    return x, res, w


def run(fn, x, res, w, grad_y, grad_r=None):
    x_, res_, w_ = (t.detach().clone().requires_grad_(True) for t in (x, res, w))
    y, r = fn(x_, res_, w_, EPS)
    if grad_r is None:
        y.backward(grad_y)
    else:
        torch.autograd.backward([y, r], [grad_y, grad_r])
    return y.detach(), r.detach(), x_.grad, res_.grad, w_.grad


def test_forward_matches_the_oracle() -> None:
    x, res, w = inputs()
    gy = torch.randn_like(x)
    ey, er, *_ = run(eager_add_rmsnorm, x, res, w, gy)
    fy, fr, *_ = run(fused_add_rmsnorm, x, res, w, gy)

    torch.testing.assert_close(fy.float(), ey.float(), rtol=2e-2, atol=2e-2)
    # The residual must come back exactly — it is a plain add, and the next block consumes it.
    torch.testing.assert_close(fr.float(), er.float(), rtol=0, atol=0)


def test_gradients_match_the_oracle() -> None:
    x, res, w = inputs()
    gy = torch.randn_like(x)
    _, _, edx, edres, edw = run(eager_add_rmsnorm, x, res, w, gy)
    _, _, fdx, fdres, fdw = run(fused_add_rmsnorm, x, res, w, gy)

    torch.testing.assert_close(fdx.float(), edx.float(), rtol=2e-2, atol=2e-2)
    torch.testing.assert_close(fdres.float(), edres.float(), rtol=2e-2, atol=2e-2)
    torch.testing.assert_close(fdw.float(), edw.float(), rtol=2e-2, atol=2e-2)
    # x and residual are the same node mathematically, so their gradients must be identical.
    torch.testing.assert_close(fdx.float(), fdres.float(), rtol=0, atol=0)


def test_the_residual_branch_gradient_is_carried() -> None:
    """`r` is consumed twice — by the norm and by the next block. Missing the second is silent."""
    x, res, w = inputs()
    gy, gr = torch.randn_like(x), torch.randn_like(x)

    _, _, edx, *_ = run(eager_add_rmsnorm, x, res, w, gy, gr)
    _, _, fdx, *_ = run(fused_add_rmsnorm, x, res, w, gy, gr)

    torch.testing.assert_close(fdx.float(), edx.float(), rtol=2e-2, atol=2e-2)

    # And it genuinely changes the answer: without the second path the gradient differs.
    _, _, no_branch, *_ = run(fused_add_rmsnorm, x, res, w, gy)
    assert not torch.allclose(fdx.float(), no_branch.float(), rtol=1e-2), (
        "adding a gradient on the residual output changed nothing — dr_out is being ignored"
    )


def test_the_mean_term_in_the_backward_is_load_bearing() -> None:
    """Prove the hard term does work, by computing the truncated version and requiring a mismatch.

    dr = (dn - n * mean(dn * n)) * rstd. Dropping the `n * mean(dn * n)` piece is the classic
    simplification: it is dimensionally fine, points the right way, and is wrong in magnitude.
    """
    x, res, w = inputs()
    gy = torch.randn_like(x)
    _, _, correct, *_ = run(fused_add_rmsnorm, x, res, w, gy)

    r = (x + res).detach().float()
    rstd = torch.rsqrt(r.pow(2).mean(-1, keepdim=True) + EPS)
    dn = gy.float() * w.detach().float()
    truncated = dn * rstd                               # the term dropped

    assert not torch.allclose(correct.float(), truncated, rtol=5e-2, atol=5e-2), (
        "the truncated gradient matches the kernel's — the mean term is not being applied"
    )


def test_fp32_accumulation_over_3584_elements() -> None:
    """bf16 summation of D squares lands in a denominator, scaling the whole row."""
    x, res, w = inputs(dtype=torch.bfloat16)
    fy, _, *_ = run(fused_add_rmsnorm, x, res, w, torch.randn_like(x))

    xf, resf, wf = (t.detach().float() for t in (x, res, w))
    exact, _ = eager_add_rmsnorm(xf, resf, wf, EPS)

    err = (fy.float() - exact).abs().max()
    assert err < 0.3, f"max error {err:.4f} against the fp32 oracle suggests low-precision accumulation"


def test_dweight_is_deterministic_run_to_run() -> None:
    """Per-block partials plus a final sum, not atomics — P2b's gradient check needs reproducibility."""
    x, res, w = inputs()
    gy = torch.randn_like(x)
    first = run(fused_add_rmsnorm, x, res, w, gy)[4]
    for _ in range(3):
        again = run(fused_add_rmsnorm, x, res, w, gy)[4]
        torch.testing.assert_close(again, first, rtol=0, atol=0)


def test_memory_is_at_parity_with_torch_rms_norm() -> None:
    """The honest baseline, and the honest result: parity, not a saving.

    The first version of this compared against `eager_add_rmsnorm` and reported a 68% saving. That
    was meaningless — the eager function is the *correctness oracle*, written the obvious way with
    fp32 upcasts, and beating it proves nothing. `torch.nn.functional.rms_norm` is already a fused
    native op, and against it this kernel reaches parity and no better.

    Asserted as a band rather than as a win, so that a regression still fails the test while the
    result stays truthful about what was actually achieved.
    """
    rows, cols = 2048, 3584

    def native(x, res, w, eps):
        r = x + res
        return torch.nn.functional.rms_norm(r, (r.shape[-1],), w, eps), r

    def peak(fn) -> int:
        torch.manual_seed(0)
        x = torch.randn(rows, cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
        res = torch.randn(rows, cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
        w = torch.randn(cols, device="cuda", dtype=torch.bfloat16, requires_grad=True)
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        before = torch.cuda.memory_allocated()
        y, r = fn(x, res, w, EPS)
        y.backward(torch.ones_like(y))
        torch.cuda.synchronize()
        used = torch.cuda.max_memory_allocated() - before
        del x, res, w, y, r
        return used

    base = peak(native)
    fused = peak(fused_add_rmsnorm)
    mib = 1024**2
    print()
    print(f"  F.rms_norm {base/mib:7.1f} MiB   fused {fused/mib:7.1f} MiB   "
          f"{(fused / base - 1) * 100:+.1f}%")

    assert fused < base * 1.05, (
        f"fused {fused/mib:.1f} MiB is more than 5% above F.rms_norm's {base/mib:.1f} MiB — "
        f"the dweight partial buffer has probably regressed; check ROWS"
    )
