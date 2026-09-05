---
title: AdamW decouples weight decay from the gradient
concept_id: optimizers_adaptive
source_name: Loshchilov & Hutter (ICLR 2019)
source_url: https://arxiv.org/abs/1711.05101
published_at: 2017-11-14
---

L2 regularisation added to the loss and weight decay applied to the update are
equivalent for plain SGD, and are not equivalent for adaptive methods.

In Adam, an L2 term enters the gradient and is therefore divided by the per-parameter second-moment
estimate. Parameters with large historical gradients receive proportionally less decay, which is
the opposite of the intended uniform shrinkage.

AdamW applies decay directly to the weights, outside the adaptive scaling. The practical
consequence is that the decay coefficient means the same thing across parameters, and tuned values
do not transfer between the two formulations.
