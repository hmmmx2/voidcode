---
title: Why mixed precision needs loss scaling, and why bf16 does not
concept_id: mixed_precision
source_name: Micikevicius et al., Mixed Precision Training
source_url: https://arxiv.org/abs/1710.03740
published_at: 2017-10-10
---

Mixed precision keeps a full-precision master copy of the weights while running the forward and
backward passes in half precision. The saving is memory bandwidth and tensor-core throughput, not
parameter count: the master weights still exist.

fp16 has 5 exponent bits, so its smallest normal value is about 6e-5. Gradients routinely fall below
that during training and flush to zero, and a zero gradient is indistinguishable from a converged
one. Loss scaling multiplies the loss by a large constant before the backward pass, shifting the
whole gradient distribution up into representable range, then divides it out before the optimizer
step.

bf16 has the same 8 exponent bits as fp32 and only 7 mantissa bits. It trades precision for range,
which is the right trade here: underflow disappears and loss scaling becomes unnecessary, at the cost
of coarser rounding. This is why bf16 is the default on hardware that supports it.
