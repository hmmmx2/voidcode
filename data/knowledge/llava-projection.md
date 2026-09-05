---
title: LLaVA connects a frozen vision encoder to an LLM with a projection
concept_id: vlm_architecture
source_name: Liu et al., Visual Instruction Tuning (LLaVA)
source_url: https://arxiv.org/abs/2304.08485
published_at: 2023-04-17
---

LLaVA takes a pretrained vision encoder and a pretrained language model and trains a projection
between them, mapping visual features into the language model's embedding space so they can be
prepended as tokens.

Training runs in stages. The projection is trained first with both encoders frozen, because it is the
only randomly initialised component and its gradients early in training are noise that would damage
two sets of pretrained weights. The language model is unfrozen afterwards at a lower learning rate.

The design is deliberately minimal: no new attention layers inside the language model, so any base
model can be used and the visual tokens are ordinary tokens. The cost is that they occupy the context
window and extend the self-attention sequence, which is quadratic.
