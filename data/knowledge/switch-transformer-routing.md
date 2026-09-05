---
title: Mixture-of-experts routes tokens, and load balance is the problem
concept_id: moe_routing
source_name: Fedus et al., Switch Transformer
source_url: https://arxiv.org/abs/2101.03961
published_at: 2021-01-11
---

A mixture-of-experts layer replaces one FFN with many, and a router sends each token to a small
number of them. Parameter count grows with the expert count while the FLOPs per token stay roughly
fixed, which is the entire appeal.

The failure mode is load imbalance. Routing is learned, so experts can collapse onto a popular subset
while others receive almost nothing, wasting their parameters and stalling the devices holding them.
An auxiliary load-balancing loss penalises uneven assignment, and a capacity factor caps how many
tokens any expert accepts, dropping the overflow.

Dropped tokens are a real cost that aggregate quality metrics hide, so the token drop rate belongs
beside the loss curve. Expert parallelism also makes the all-to-all exchange the characteristic
bottleneck, rather than the all-reduce that dominates dense training.
