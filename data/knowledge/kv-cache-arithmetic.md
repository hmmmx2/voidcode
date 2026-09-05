---
title: KV cache size is linear in tokens and independent of batch efficiency
concept_id: kv_cache
source_name: Pope et al., Efficiently Scaling Transformer Inference
source_url: https://arxiv.org/abs/2211.05102
published_at: 2022-11-09
---

Autoregressive decoding recomputes nothing if the keys and values of previous tokens are cached.
The cache holds two tensors per layer, each of shape (batch, kv_heads, seq_len, head_dim), so its
size is linear in sequence length and in batch size.

Concretely: 2 (K and V) x layers x kv_heads x head_dim x bytes_per_element x tokens. For a 7B-class
model in fp16 this is on the order of half a megabyte per token, so a few thousand tokens across a
handful of concurrent requests rivals the model weights.

This is why grouped-query attention matters for serving: cutting KV heads cuts the cache
proportionally. It is also why the cache, rather than the weights, is usually what limits how many
requests can be served concurrently.
