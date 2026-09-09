# GRPO on Qwen3-Coder-30B-A3B: what was measured

One page, stated so it can be checked. Full working in [METRICS.md](METRICS.md); raw records in
`grpo-run-30b-uncapped.json`, `greedy-noise-floor.json`, `deepcoder-band-30b-templated.json`.

## The result

**RLVR with GRPO produced a measurable in-domain improvement that did not transfer.**

| | measured | |
|---|---|---|
| **In-domain** (120 held-out DeepCoder problems) | `mean_case_fraction` **0.5680 → 0.6385**, **+0.0705** | ~5× the eval's own noise floor |
| **Transfer** (60 authored ML/DL problems) | **−0.67 SE** | flat in every run ever attempted |
| **Dead groups** | **72% → 12.9%** | cause identified and confirmed |

The transfer result is the headline, and it is **negative**. The 60 authored problems are the
readout this project exists to improve, and 175 steps of GRPO on competitive-programming Python did
not move them — in this run or any earlier one.

The in-domain gain is what makes that negative interpretable. Every prior run could only report
"the eval did not move", which is equally consistent with *learned nothing*. This run separates
them: the policy demonstrably learned (KL 0 → 0.138 peak, in-domain +0.0705) and the learning did
not transfer.

## Why the in-domain number is believable

The eval's noise floor was **measured**, not assumed — twice, by independent routes that agree:

| method | estimate |
|---|---|
| 3 evals with the policy **frozen** | sd **0.0127**, spread 0.0241 |
| 2 step-0 evals, same policy, different runs | difference **0.0143** |

+0.0705 is ~5× that. The per-eval SE used for significance testing (0.0319) is *larger* than the
instrument noise, so the +2.19 SE test was conservative rather than generous.

**The same check invalidated a metric this project had trusted.** `holdout_greedy_solved` ranged
**59–68 across three identical evals on an unchanged policy** (sd 4.5 of 120). METRICS.md had
described greedy as the metric whose "movement cannot be sampling noise"; that is false once the
eval generates in batches, because vLLM's continuous batching makes a request's numerics depend on
what shares its batch. Every greedy-based number in this run is inside that floor and is discarded.
The original claim is corrected in place in METRICS.md rather than edited away.

## The chain that made it possible

Four defects had to be fixed before any run could be interpreted. Each was found by measurement.

| defect | consequence if unfixed |
|---|---|
| Band calibrated against **Qwen2.5-Coder-1.5B**, not the model being trained | ~92 of 511 training problems were solved on *every* sample — dead before a gradient existed |
| Band measured **off the chat template**, untruncated, strict extractor | understated the policy; `always_solved` 147 → **285** once corrected |
| Grading child **re-imported the trainer's `__main__`** | 24.3 s → **1.7 s** per call; a 60-problem eval had been spending ~25 min at 0% GPU |
| A stalled grading batch returned zeros indistinguishable from real scores | inflated `dead_groups` — the run's own primary diagnostic — by 8 points |

`always_solved: 0 → 147 → 285` across the three band measurements is the single clearest number
here: measuring the band correctly is what removed the dead groups, and dead groups were why the
first 30B run produced no gradient at all.

## Limits

Stated because they bound what may be claimed:

1. **Unreplicated.** One run, read at seven evals against a 2 SE bar with no pre-registered
   multiple-comparisons correction. Single evals swung from −0.0128 to +0.0926, so the sustained
   elevation across six of seven evals is the evidence — not any single reading. A seed-1
   replication was launched and stopped early by choice.
2. **Unattributed.** Four variables changed at once entering this run (`--max-cases 0`,
   `--lora-r 32`, `--problems-per-step 2`, `--max-new 1024`). A max-cases ablation ran to step 30
   of 175 before being stopped; its record is `grpo-run-30b-ablate-maxcases.json`. Nothing here says
   which change caused the gain.
3. **Noise floor measured under different conditions** — `--gpu-util 0.85` with no trainer resident,
   versus 0.40 alongside a live trainer during the run. The in-run floor could be higher, so ~5× is
   an upper estimate.
4. **~8% of training signal discarded** to grading stalls (`skipped_groups: 28` of 350 groups), the
   standing cost of grading every test case.
5. **No public benchmark number may be reported** from this policy. DeepCoder contains LiveCodeBench
   problems to July 2024; the 60 authored problems are the only clean readout.

## Cost model, for whoever runs this next

Measured with per-phase timers on one A40:

```
step seconds  ~=  15.4 x (problems_per_step x group)  +  58
```

Backward dominates at **88%** of a step (493 s of 559 s at 32 completions); generation is 10%,
grading **0.4%** after the concurrency work. Completions-per-step and sequence length are the only
wall-clock levers. A 175-step run at B=2, G=16 is ~26 h.
