---
title: Coalescing is about the transactions a warp generates
concept_id: memory_coalescing
source_name: NVIDIA CUDA C++ Best Practices Guide
source_url: https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/
published_at: 2024-01-01
---

Global memory is served in aligned transactions. When the 32 lanes of a warp read consecutive,
aligned addresses, their requests coalesce into the minimum number of transactions. When they read
with a stride, each lane can land in a different segment and the same data costs many times the
traffic.

The unit is the warp, not the thread and not the block, so the question is always what one warp's
32 simultaneous addresses look like. A common failure is indexing a 2D array so that consecutive
threads walk down a column, which strides by the row length.

The usual fixes are transposing the access pattern, staging through shared memory so the
uncoalesced access happens once, or padding the leading dimension so successive rows do not align to
the same segments.
