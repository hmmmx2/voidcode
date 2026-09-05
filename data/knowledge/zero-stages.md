---
title: ZeRO stages and what each costs in communication
concept_id: zero_sharding
source_name: Rajbhandari et al., ZeRO (SC 2020)
source_url: https://arxiv.org/abs/1910.02054
published_at: 2019-10-04
---

ZeRO removes the memory redundancy of data parallelism in three stages: stage 1
shards optimizer state, stage 2 adds gradients, stage 3 adds parameters.

The saving is not free. Stage 3 must all-gather parameters on every forward pass and again on every
backward pass, for every micro-batch — and gradient accumulation does not amortise that, because
the gathers happen per micro-batch regardless. Stage 2 communicates gradients once per optimizer
step, which accumulation does amortise.

On a slow interconnect stage 3's extra collectives can cost more time than the memory buys, so the
right choice is the lowest stage that fits rather than the most aggressive.
