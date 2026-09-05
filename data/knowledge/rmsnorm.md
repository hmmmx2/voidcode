---
title: RMSNorm drops the mean subtraction and keeps the benefit
concept_id: normalization_layers
source_name: Zhang and Sennrich, Root Mean Square Layer Normalization
source_url: https://arxiv.org/abs/1910.07467
published_at: 2019-10-16
---

LayerNorm centres and scales activations using their mean and variance. RMSNorm removes the
centring and rescales by the root mean square alone, on the argument that the re-scaling rather than
the re-centring is what stabilises training.

The saving is small per call and real in aggregate: one fewer reduction over the hidden dimension,
and no mean to store for the backward pass. Both are memory-bandwidth-bound operations, so removing a
pass over the data matters more than the arithmetic suggests.

It has become the default in recent large models, usually in the pre-norm position where the
normalisation sits inside the residual branch and leaves a clean identity path from input to
output.
