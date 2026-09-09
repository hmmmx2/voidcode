# Raw run logs

Primary evidence for every number in [../RESULT.md](../RESULT.md) and [../METRICS.md](../METRICS.md).
Pulled off the rented pod because its volume is **not persistent** — it is destroyed when the pod
stops, and these cannot be regenerated without re-renting the GPU and re-running for days.

Committed as text rather than kept in `artifacts/` (which is gitignored for model weights), because
a claim whose evidence lives only on a machine that no longer exists is not checkable.

| log | what it records |
|---|---|
| `train_uncapped.log` | **The main result.** 175 steps, all seven evals, per-step timings, GRPO_EXIT=0 |
| `greedy_noise.log` | **The noise floor.** Three identical evals on a frozen policy — the measurement that validated the in-domain gain and invalidated the greedy metrics |
| `pipeline.log` | On-template re-filter + band gate + the first scaled run |
| `refilter_templated.log` | Band measured on-template (`always_solved` 285) |
| `refilter30b.log` | Band measured off-template (`always_solved` 147) |
| `ablate_maxcases.log` | max-cases ablation, stopped at step 30 of 175 by choice |
| `replicate_seed1.log` | seed-1 replication, stopped during startup by choice |
| `grpo30b_g16.log` | The G=16 run on the off-template band (dead groups 36%) |
| `grpo30b_vllm.log` | The first 30B run (dead groups 72%) |
| `train_uncapped.{prev,v2,v3}.log` | Earlier starts of the main run, restarted for throughput fixes; kept because the per-step timings in them are what diagnosed the bottlenecks |

The remaining logs are earlier probes, smokes and setup runs from the same pod.
