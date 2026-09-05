---
title: Prefill and decode are different workloads with different metrics
concept_id: serving_latency
source_name: vLLM project documentation
source_url: https://docs.vllm.ai/en/latest/
published_at: 2024-06-01
---

An LLM request has two phases with opposite bottlenecks. Prefill processes the whole prompt at
once and is compute-bound: it is a large matmul over many tokens. Decode generates one token at a
time and is memory-bandwidth-bound: it reads all the weights to produce a single token.

The metrics follow. Time to first token measures prefill and scales with prompt length. Inter-token
latency measures decode and is roughly constant per token. A single "latency" number averages two
quantities that respond to different fixes, and optimising one can worsen the other.

Batching helps decode enormously, because the weight read is amortised across the batch, and helps
prefill much less, because prefill was already saturating compute. This asymmetry is why schedulers
treat the phases separately and why chunked prefill exists.
