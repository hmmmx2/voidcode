---
title: PagedAttention and KV memory fragmentation
concept_id: paged_attention
source_name: Kwon et al., vLLM (SOSP 2023)
source_url: https://arxiv.org/abs/2309.06180
published_at: 2023-09-12
---

Serving systems that allocate a contiguous KV cache sized to the maximum context
waste most of it: a request that turns out to be 200 tokens still holds a reservation for the full
context window. The vLLM paper attributes 60-80% of KV memory to this waste.

PagedAttention borrows virtual-memory paging. The cache is split into fixed-size blocks that need
not be contiguous, with a block table mapping logical positions to physical blocks. Waste becomes
internal fragmentation bounded by block_size - 1 slots per sequence, which at a block size of 16 is
under 2% at realistic lengths.

Non-contiguous blocks also make copy-on-write sharing cheap, which is what lets parallel sampling
and beam search share a prompt's cache instead of duplicating it.
