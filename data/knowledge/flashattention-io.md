---
title: FlashAttention is an IO optimisation, not a FLOP reduction
concept_id: flash_attention
source_name: Dao et al., FlashAttention (NeurIPS 2022)
source_url: https://arxiv.org/abs/2205.14135
published_at: 2022-05-27
---

FlashAttention computes exact attention without ever materialising the full N x N
score matrix in high-bandwidth memory. It tiles the computation, keeps blocks in on-chip SRAM, and
uses an online softmax to combine partial results.

The FLOP count is unchanged. What changes is memory traffic: the quadratic intermediate is never
written to or read back from HBM. Attention at moderate sequence lengths is memory-bandwidth-bound
rather than compute-bound, which is where the speedup comes from.

It is exact rather than approximate, so it is not a quality trade — outputs match standard attention
to floating-point tolerance.
