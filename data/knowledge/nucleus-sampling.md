---
title: Nucleus sampling truncates the tail by mass, not by rank
concept_id: sampling_decoding
source_name: Holtzman et al., The Curious Case of Neural Text Degeneration
source_url: https://arxiv.org/abs/1904.09751
published_at: 2019-04-22
---

Greedy and beam search maximise likelihood and produce degenerate, repetitive text. The paper's
argument is that human text is not maximum-likelihood text: it sits in a band of moderate surprise,
and always choosing the most probable token leaves that band.

Top-k truncates to a fixed number of candidates, which is wrong in both directions: at a confident
step it admits improbable tokens, and at an uncertain step it excludes plausible ones. Nucleus
sampling instead keeps the smallest set of tokens whose cumulative probability exceeds p, so the
candidate set grows and shrinks with the model's own confidence.

Temperature is a separate control that reshapes the distribution before truncation. Stacking a low
temperature with a low p compounds the narrowing, which is a common cause of unexpectedly repetitive
output.
