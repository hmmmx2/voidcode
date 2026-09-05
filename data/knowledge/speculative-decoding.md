---
title: Speculative decoding preserves the target distribution exactly
concept_id: speculative_decoding
source_name: Leviathan et al. (ICML 2023)
source_url: https://arxiv.org/abs/2211.17192
published_at: 2022-11-30
---

A small draft model proposes several tokens; the target verifies them in one forward
pass and accepts a prefix using a modified rejection-sampling rule.

That rule is chosen so accepted output is distributed exactly as if the target had generated it
alone. Speculative decoding is a throughput optimisation with no quality cost — not an
approximation.

Speedup depends on acceptance rate and the draft's relative cost. Accepted tokens grow sublinearly
in the number of drafts, since each additional token requires all previous ones to be accepted,
while draft cost grows linearly. Past a point additional speculation is paid for and discarded, so
the optimal draft length is usually small.
