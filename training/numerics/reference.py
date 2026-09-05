"""A tiny causal transformer that exists to be a numerical oracle, not to be trained.

WHY THERE IS A MODEL IN HERE AT ALL
-----------------------------------
`packing.py` warns that emitting ``cu_seqlens`` while forgetting to reset ``position_ids`` is the
common half-fix: it "trains without error and degrades quality in a way no loss curve reveals". A
warning in a docstring does not catch that. A test does, and the test needs a model.

The property being checked is exact: **packing k documents into one sequence must produce the same
gradients as running those documents separately.** If the attention mask leaks across a document
boundary, or if positions run 0..N across the whole buffer instead of restarting, the gradients
differ. One assertion, both halves of the fix.

WHAT THIS MODEL MUST HAVE, AND WHY
----------------------------------
**Rotary embeddings, specifically.** A model with no position encoding would make the
``position_ids`` half of the test vacuous -- resetting positions would change nothing and the test
would pass while the bug it exists to catch went uncaught. RoPE is also what Qwen uses, so the
oracle and the real model fail the same way.

Everything else is the smallest thing that is still a transformer: RMSNorm, multi-head attention
with an explicit additive mask, SwiGLU. No dropout, no bias, no tied weights -- every source of
nondeterminism removed, because the assertion is exact equality within float tolerance, not "close
enough".

Deliberately float64-capable and tiny. It runs on CPU in milliseconds, so this check is part of the
normal suite rather than something that waits for a pod.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class TinyConfig:
    vocab_size: int = 64
    d_model: int = 32
    n_heads: int = 4
    n_layers: int = 2
    d_ff: int = 64
    rope_base: float = 10000.0
    #: "rope" (relative, what Qwen uses) or "learned" (absolute, added to the embedding).
    #: Both exist because they answer *different* questions about packing, and measuring on only
    #: one of them produces a confident wrong conclusion -- see `pos_encoding` in the tests.
    pos_encoding: str = "rope"
    max_positions: int = 512

    @property
    def head_dim(self) -> int:
        if self.d_model % self.n_heads:
            raise ValueError(f"d_model {self.d_model} not divisible by n_heads {self.n_heads}")
        return self.d_model // self.n_heads


def rope_cache(positions: torch.Tensor, head_dim: int, base: float) -> tuple[torch.Tensor, torch.Tensor]:
    """cos/sin for arbitrary position ids.

    Takes ``positions`` as a tensor rather than a length, which is the whole point: a packed
    sequence's positions restart per document and are not ``arange(n)``. An implementation that
    accepts only a length cannot express the packed case, which is how the bug survives.
    """
    inv_freq = 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float64) / head_dim))
    angles = positions.to(torch.float64)[..., None] * inv_freq          # (..., head_dim/2)
    emb = torch.cat([angles, angles], dim=-1)                            # (..., head_dim)
    return emb.cos(), emb.sin()


def rotate_half(x: torch.Tensor) -> torch.Tensor:
    half = x.shape[-1] // 2
    return torch.cat([-x[..., half:], x[..., :half]], dim=-1)


def apply_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    # x is (batch, heads, seq, head_dim); cos/sin are (batch, seq, head_dim).
    cos = cos[:, None, :, :].to(x.dtype)
    sin = sin[:, None, :, :].to(x.dtype)
    return x * cos + rotate_half(x) * sin


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        norm = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return norm * self.weight


class Attention(nn.Module):
    def __init__(self, cfg: TinyConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.q = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.k = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.v = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.o = nn.Linear(cfg.d_model, cfg.d_model, bias=False)

    def forward(self, x: torch.Tensor, mask: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
        b, n, _ = x.shape
        h, d = self.cfg.n_heads, self.cfg.head_dim

        q = self.q(x).view(b, n, h, d).transpose(1, 2)
        k = self.k(x).view(b, n, h, d).transpose(1, 2)
        v = self.v(x).view(b, n, h, d).transpose(1, 2)

        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)

        scores = (q @ k.transpose(-2, -1)) / math.sqrt(d)
        # Additive mask: 0 where attention is allowed, -inf where it is not. Written this way
        # rather than as a boolean so a fully-masked row would produce NaN loudly instead of
        # silently averaging over forbidden positions.
        scores = scores + mask
        weights = scores.softmax(dim=-1)
        out = (weights @ v).transpose(1, 2).reshape(b, n, h * d)
        return self.o(out)


class Block(nn.Module):
    def __init__(self, cfg: TinyConfig) -> None:
        super().__init__()
        self.norm1 = RMSNorm(cfg.d_model)
        self.attn = Attention(cfg)
        self.norm2 = RMSNorm(cfg.d_model)
        self.gate = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.up = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.down = nn.Linear(cfg.d_ff, cfg.d_model, bias=False)

    def forward(self, x: torch.Tensor, mask: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x), mask, cos, sin)
        h = self.norm2(x)
        return x + self.down(nn.functional.silu(self.gate(h)) * self.up(h))


class TinyCausalLM(nn.Module):
    """Small enough to be exact, real enough to fail the way Qwen would."""

    def __init__(self, cfg: TinyConfig | None = None) -> None:
        super().__init__()
        self.cfg = cfg or TinyConfig()
        self.embed = nn.Embedding(self.cfg.vocab_size, self.cfg.d_model)
        self.pos_embed = (
            nn.Embedding(self.cfg.max_positions, self.cfg.d_model)
            if self.cfg.pos_encoding == "learned"
            else None
        )
        self.blocks = nn.ModuleList(Block(self.cfg) for _ in range(self.cfg.n_layers))
        self.norm = RMSNorm(self.cfg.d_model)
        self.head = nn.Linear(self.cfg.d_model, self.cfg.vocab_size, bias=False)

    def forward(
        self,
        input_ids: torch.Tensor,       # (batch, seq)
        position_ids: torch.Tensor,    # (batch, seq) -- restarts per document when packed
        mask: torch.Tensor,            # (batch, 1, seq, seq) additive, 0 or -inf
        labels: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.embed(input_ids)
        if self.pos_embed is not None:
            # Absolute: position enters the residual stream directly, so an offset is visible.
            x = x + self.pos_embed(position_ids)
            cos = torch.ones_like(x[..., : self.cfg.head_dim])
            sin = torch.zeros_like(cos)
        else:
            # Relative: position enters only as a rotation of q and k, so the attention score
            # between i and j depends on (i - j) alone.
            cos, sin = rope_cache(position_ids, self.cfg.head_dim, self.cfg.rope_base)
        for block in self.blocks:
            x = block(x, mask, cos, sin)
        logits = self.head(self.norm(x))

        loss = torch.zeros((), dtype=logits.dtype, device=logits.device)
        if labels is not None:
            # Standard causal shift. Reduction is *sum*, not mean, and the caller divides by the
            # token count it intends: a packed sequence and the same documents unpacked have the
            # same tokens but different shapes, so a per-call mean would differ for reasons that
            # have nothing to do with whether packing is correct.
            shift_logits = logits[:, :-1].reshape(-1, self.cfg.vocab_size)
            shift_labels = labels[:, 1:].reshape(-1)
            loss = nn.functional.cross_entropy(
                shift_logits, shift_labels, ignore_index=-100, reduction="sum"
            )
        return logits, loss


def deterministic_model(seed: int = 0, cfg: TinyConfig | None = None, dtype: torch.dtype = torch.float64) -> TinyCausalLM:
    """Same weights every call. float64 by default, because the assertion is exact equality."""
    torch.manual_seed(seed)
    model = TinyCausalLM(cfg)
    return model.to(dtype)
