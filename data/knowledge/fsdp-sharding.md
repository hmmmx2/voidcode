---
title: FSDP shards parameters and re-gathers them per layer
concept_id: data_parallel
source_name: Zhao et al., PyTorch FSDP
source_url: https://arxiv.org/abs/2304.11277
published_at: 2023-04-21
---

Distributed data parallel replicates the whole model on every device and all-reduces gradients
once per step. Memory is therefore bounded by what one device can hold, which caps model size well
before the cluster runs out of aggregate memory.

FSDP sharding splits parameters, gradients and optimizer state across ranks. Each layer's parameters
are all-gathered immediately before use and freed immediately after, so peak memory holds one layer's
full parameters rather than the whole model.

The trade is communication volume: an all-gather per layer per forward pass and again in the
backward, against DDP's single gradient all-reduce per step. On a slow interconnect this can cost
more than the memory saves, which is why sharding strategy is chosen against measured interconnect
bandwidth rather than by default.
