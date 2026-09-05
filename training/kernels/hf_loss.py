"""Route a HuggingFace causal LM's loss through the fused cross-entropy kernel.

`model(input_ids=..., labels=...)` computes its own loss with `F.cross_entropy`, which materialises
`log_softmax` as a second `[N, V]` tensor and a third for the gradient. On Qwen2.5-Coder-1.5B that
is a 151936-token vocabulary, so each of those is ~0.3 GiB at sequence length 1024 — and the GRPO
fit measurement showed the training peak running at 3.5x the weights, most of it here.

So: ask the model for logits only, and compute the loss ourselves.

WHAT THIS DOES NOT FIX
----------------------
The logits themselves. `[B, S, V]` is produced by the LM head and is unavoidable without a chunked
head that never forms the full tensor. This removes the *extra* copies, not the original — which is
why the expected saving is roughly one `[N, V]`, not all of it. Claiming more than that would be
easy and wrong.

The shift is the standard causal one and is done here rather than inside the kernel, because the
kernel's contract is `[N, V]` logits against `[N]` targets and keeping it that way is what let it be
tested against `F.cross_entropy` directly.
"""
from __future__ import annotations

import torch

from .cross_entropy import IGNORE_INDEX, fused_available, fused_cross_entropy


def fused_causal_lm_loss(model, input_ids, labels=None, attention_mask=None, reduction="mean"):
    """Forward pass returning ``(loss, logits)`` with the loss computed by the fused kernel.

    Falls back to `F.cross_entropy` via the same entry point when Triton is unavailable, so the
    caller does not branch — but `fused_available()` still reports which path ran, because a
    fallback nobody can detect is worse than no fallback.
    """
    if labels is None:
        out = model(input_ids=input_ids, attention_mask=attention_mask)
        return None, out.logits

    # labels=None so the model does not compute its own loss; that is the whole point.
    out = model(input_ids=input_ids, attention_mask=attention_mask)
    logits = out.logits

    # Standard causal shift: position t predicts token t+1.
    shift_logits = logits[:, :-1, :].reshape(-1, logits.size(-1))
    shift_labels = labels[:, 1:].reshape(-1)

    loss = fused_cross_entropy(shift_logits, shift_labels,
                               ignore_index=IGNORE_INDEX, reduction=reduction)
    return loss, logits


def loss_backend() -> str:
    """Which path `fused_causal_lm_loss` will actually take. For recording in results."""
    return "fused_triton" if fused_available() else "torch_cross_entropy"
