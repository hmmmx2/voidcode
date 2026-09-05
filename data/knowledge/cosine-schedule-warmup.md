---
title: Warmup exists because early adaptive-optimizer estimates are unreliable
concept_id: lr_scheduling
source_name: Loshchilov and Hutter, SGDR
source_url: https://arxiv.org/abs/1608.03983
published_at: 2016-08-13
---

A cosine schedule decays the learning rate smoothly from its peak to near zero over training,
avoiding the discontinuities of step decay. It is now the common default for transformer
pretraining, usually with a linear warmup in front of it.

Warmup addresses a different problem from decay. Adaptive optimizers estimate gradient moments from
very few samples at the start of training, and those estimates have high variance, so a full-size
step taken on them can move the weights somewhere the optimizer then needs many steps to leave.
Ramping the learning rate up limits the damage while the estimates settle.

The schedule interacts with total step count: a cosine curve fitted to a planned length and then
stopped early leaves the learning rate high, which is a common cause of a run that looks worse than
an equivalent shorter one.
