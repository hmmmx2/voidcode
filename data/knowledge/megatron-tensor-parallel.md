---
title: Tensor parallelism splits the matmul, not the batch
concept_id: tensor_parallel
source_name: Shoeybi et al., Megatron-LM
source_url: https://arxiv.org/abs/1909.08053
published_at: 2019-09-17
---

Tensor parallelism shards individual weight matrices across devices, so every device holds a
slice of the same layer and processes the same tokens. Data parallelism does the opposite: every
device holds the whole layer and processes different tokens.

The arrangement matters. Megatron splits the first FFN matrix column-wise and the second row-wise, so
the intermediate activation needs no communication at all and only one all-reduce is required per
block. Splitting both the same way would force a collective in the middle.

The cost is a collective on every forward and every backward pass, per layer. That makes tensor
parallelism sensitive to interconnect in a way data parallelism is not, which is why it is normally
confined to devices inside one node and data parallelism spans nodes.
