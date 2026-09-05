---
title: Triton exposes blocks, not threads
concept_id: triton_basics
source_name: Tillet et al., Triton (MAPL 2019)
source_url: https://dl.acm.org/doi/10.1145/3315508.3329973
published_at: 2019-06-22
---

CUDA asks you to reason about individual threads, their indices, and explicit shared-memory
staging. Triton raises the unit to a block: a program instance operates on tensors of a chosen block
size, and the compiler handles the intra-block assignment, vectorisation and shared-memory placement.

That removes an entire class of bugs, including most bank-conflict and coalescing mistakes, at the
cost of less control when the generated schedule is wrong. Masking replaces bounds checking:
operations carry a mask so partial blocks at tensor edges are handled without a separate epilogue.

It is a practical fit for fusion work in machine learning, where the win usually comes from avoiding
a round trip to HBM rather than from hand-tuned instruction scheduling.
