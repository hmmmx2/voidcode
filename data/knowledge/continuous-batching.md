---
title: Continuous batching schedules at the token, not the request
concept_id: continuous_batching
source_name: Yu et al., Orca (OSDI 2022)
source_url: https://www.usenix.org/conference/osdi22/presentation/yu
published_at: 2022-07-11
---

Static batching groups requests and runs them to completion together, so the whole batch waits
for its longest generation. With generation lengths varying by an order of magnitude, most sequence
slots are padding for most of the run.

Continuous batching schedules per iteration instead. A finished sequence leaves the batch and a
waiting request joins it at the next token step, so the batch stays full. Reported throughput gains
are large precisely because the baseline wastes so much.

It interacts directly with KV cache management: admitting a new request needs cache space for it, so
the scheduler must decide admission against free blocks rather than against a fixed batch size. This
is why continuous batching and paged KV cache appear together in serving stacks.
