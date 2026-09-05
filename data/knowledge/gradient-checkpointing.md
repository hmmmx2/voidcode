---
title: Gradient checkpointing trades compute for activation memory
concept_id: gradient_checkpointing
source_name: Chen et al., Training Deep Nets with Sublinear Memory Cost (2016)
source_url: https://arxiv.org/abs/1604.06174
published_at: 2016-04-21
---

Activation memory grows linearly with depth because every intermediate needed by the
backward pass is retained. Gradient checkpointing stores a subset and recomputes the rest during
backward.

Storing O(sqrt(L)) checkpoints for an L-layer network reduces activation memory to O(sqrt(L)) at
the cost of roughly one extra forward pass — about 33% more compute, since forward-plus-backward is
approximately three times a forward.

Whether that is a good trade depends on the bottleneck. Memory-bound runs get it nearly free;
compute-bound runs with spare memory pay a third of their throughput for nothing.
