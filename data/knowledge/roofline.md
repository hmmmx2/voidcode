---
title: The roofline model bounds a kernel by arithmetic intensity
concept_id: roofline_analysis
source_name: Williams et al., Roofline (CACM 2009)
source_url: https://dl.acm.org/doi/10.1145/1498765.1498785
published_at: 2009-04-01
---

Arithmetic intensity is FLOPs performed per byte moved. Plotting attainable performance against
it gives two regimes: a bandwidth-bound slope where the memory system is the limit, and a compute
roof where peak arithmetic throughput is.

Placing a kernel on that plot tells you which optimisation can possibly help. A memory-bound kernel
gains nothing from faster arithmetic, and a compute-bound one gains nothing from better access
patterns. Most machine-learning elementwise and normalisation kernels sit firmly on the bandwidth
slope.

The model deliberately ignores latency, occupancy and launch overhead, so a kernel can sit far below
both roofs for reasons roofline cannot express. It bounds what is achievable rather than predicting
what is achieved.
