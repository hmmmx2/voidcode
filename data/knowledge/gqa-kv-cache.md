---
title: Grouped-query attention and KV cache size
concept_id: attention_variants
source_name: Ainslie et al., GQA (EMNLP 2023)
source_url: https://arxiv.org/abs/2305.13245
published_at: 2023-05-22
---

Grouped-query attention shares each key/value projection across a group of query
heads, sitting between multi-head attention (one KV head per query head) and multi-query attention
(a single KV head for all heads).

The KV cache scales with the number of KV heads, not query heads. A model with 28 query heads and
4 KV heads therefore holds a cache roughly seven times smaller than multi-head attention would at
the same context length.

GQA was introduced as an uptraining recipe rather than a pretraining architecture: an existing
multi-head checkpoint is converted by mean-pooling the key and value projections within each group,
then trained briefly. The paper reports quality close to MHA at speed close to MQA.
