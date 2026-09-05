---
title: Pipeline parallelism and the bubble that micro-batching shrinks
concept_id: pipeline_parallel
source_name: Huang et al., GPipe
source_url: https://arxiv.org/abs/1811.06965
published_at: 2018-11-16
---

Pipeline parallelism assigns consecutive layers to different devices. A single batch then leaves
most devices idle: device 2 cannot start until device 1 finishes, and device 1 has nothing to do
while the rest of the pipeline drains.

That idle fraction is the pipeline bubble. Splitting the batch into m micro-batches that flow through
the stages back-to-back reduces the bubble to roughly (p-1)/(m+p-1) for p stages, so raising m is the
lever. The limit is activation memory: every in-flight micro-batch holds its activations until its
backward pass runs.

Interleaved and 1F1B schedules reduce peak activation memory by running a backward pass as soon as
one is available rather than after all forwards, which is what makes deep pipelines practical.
