---
title: GPTQ quantizes layer by layer against a calibration set
concept_id: quantization_basics
source_name: Frantar et al., GPTQ
source_url: https://arxiv.org/abs/2210.17323
published_at: 2022-10-31
---

Round-to-nearest quantization treats each weight independently and ignores what the layer
actually computes. GPTQ instead minimises the error in the layer's OUTPUT on a small calibration
set, quantizing one column at a time and updating the remaining full-precision weights to compensate
for the error just introduced.

That compensation is the whole idea, and it is why a few hundred calibration sequences are enough:
the objective is reconstructing a layer's behaviour on representative activations, not matching its
weights.

It is weight-only. Activations stay in higher precision, so the arithmetic is still half precision
and the saving is memory footprint and bandwidth. That makes it a decode-phase optimisation, where
weight traffic dominates, rather than a prefill one.
