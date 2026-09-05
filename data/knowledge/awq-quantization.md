---
title: AWQ protects salient channels by scaling, not by mixed precision
concept_id: quantization_schemes
source_name: Lin et al., AWQ (MLSys 2024)
source_url: https://arxiv.org/abs/2306.00978
published_at: 2023-06-01
---

Uniform quantization error depends on the range within a group, so one outlier
magnifies error for every other weight sharing that scale.

AWQ observes that a small fraction of weight channels matter disproportionately, and identifies
them by activation magnitude rather than weight magnitude — the channels seeing large activations
are the ones whose error propagates. It scales those channels before quantizing so their effective
range shrinks, folding the inverse scale into the preceding operation.

All weights stay at low precision, so no mixed-precision kernel is needed. Like GPTQ, it is an
attack on the range rather than on the rounding.
