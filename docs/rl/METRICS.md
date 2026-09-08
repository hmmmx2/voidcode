# Metrics ledger

**`NOT MEASURED` means not measured. It is never an estimate standing in for one**, and a number
that cannot be regenerated on demand does not belong here.

Every row records **which pod produced it**. Community and Secure Cloud report the same device name to
`nvidia-smi`, and the rented A40 (Ampere) and the local 5060 Ti (Blackwell) differ in architecture, so
a figure without its configuration is not comparable to anything.

## The reporting rule

- **Quality metrics may come from either card** — pass@1, dead-group rate, reward curves are
  properties of the model, not the silicon.
- **Every throughput or memory number in a comparison table comes from the rented A40**, one
  architecture per table — with the single exception of the FP8-vs-BF16 table, which is entirely
  local and labelled as such. A mixed table measures the hardware rather than the strategy.

---

## P-local — the card on the desk ✅

Measured, and included because it decides what needs renting. **No figure here may enter a
comparison table**: Blackwell is a third architecture beside Ampere and Ada, and WDDM makes local
memory and throughput numbers suspect by construction — see D-002 and D-008.

| Metric | `rtx5060ti_x1_local` | Command |
|---|---|---|
| Device | RTX 5060 Ti, 15.93 GiB, sm_120, 36 SMs | `make probe` |
| Compute capability (FP8 needs ≥8.9) | **12.0 — FP8 capable** | `make probe` |
| BF16 matmul, TFLOP/s | **48.5** | `make probe` |
| FP8 e4m3 `_scaled_mm`, TFLOP/s | **97.4** (2.01× BF16) | ad hoc |
| FP8 relative error vs fp32 | **0.0377** | ad hoc |
| `torch.profiler` returns CUDA events | **yes** | `make probe` |
| `ncu` / `nsys` present | ncu yes, nsys no | `make probe` |
| NCCL | n/a — one GPU | `make probe` |
| `MemoryGuard` real-CUDA path | **6/6 tests pass** — first run against a device | `make test` |

Record: `docs/probe-rtx5060ti_x1_local.json`.

## P0 — platform truth

Run `make probe` on both tiers. The point is the diff.

| Metric | `a40_x2_community` | `a40_x2_secure` | Command |
|---|---|---|---|
| NCCL all-reduce busbw >=256 MiB, GB/s | NOT MEASURED | **22.11** | `SPEC=... make probe` |
| NCCL transport selected | NOT MEASURED | **P2P** | `SPEC=... make probe` |
| Peer-to-peer available | NOT MEASURED | **yes, both directions** | `SPEC=... make probe` |
| GPU topology | NOT MEASURED | **PIX (PCIe switch), NVLink inactive** | `SPEC=... make probe` |
| `torch.profiler` returns CUDA events | NOT MEASURED | **yes** | `SPEC=... make probe` |
| `ncu` / `nsys` present and working | NOT MEASURED | **neither present** | `SPEC=... make probe` |
| BF16 matmul, TFLOP/s | NOT MEASURED | **107.18** | `SPEC=... make probe` |
| Compute capability (FP8 requires >=8.9) | NOT MEASURED | **8.6 - no FP8, as expected** | `SPEC=... make probe` |
| `/workspace` backing | NOT MEASURED | **network (MooseFS, ca-mtl-1)** | `SPEC=... make probe` |
| **Route selected** | NOT MEASURED | **ZeRO-2 and ZeRO-3 both viable** | derived from busbw |

Record: `docs/probe-a40_x2_secure.json`.

**22.11 GB/s clears the >20 GB/s band, and it does so without NVLink.** `nvidia-smi nvlink -s` reports
all links inactive and `topo -m` shows `PIX` - a PCIe switch - so this is PCIe peer-to-peer. The
expectation that the top band needed an NVLink bridge was wrong, which is the useful part: no need to
hunt for bridge-equipped pods.

> ### ⚠ Second Secure run, 2026-09-06 — the interconnect is NOT stable across pods
>
> A repeat of this probe on a different `a40_x2_secure` pod (`pispwg70ci8nz2`, CA-MTL-1) did **not**
> reproduce the interconnect result. Record: `docs/rl/probe-a40_x2_secure.json`.
>
> | Metric | First run (above) | 2026-09-06 run |
> |---|---|---|
> | GPU topology | **PIX** (PCIe switch) | **PXB** (multiple PCIe bridges) |
> | NCCL transport | **P2P** | **SHM** |
> | busbw >=256 MiB | **22.11 GB/s** | **7.72 GB/s** |
> | Default-transport all-reduce | completed | **DEADLOCKS** (exit 124) |
> | Route | ZeRO-2 and ZeRO-3 both viable | **ZeRO-2 / FSDP2 `SHARD_GRAD_OP` only** |
> | BF16 matmul | 107.18 TFLOP/s | 106.05 TFLOP/s |
> | `ncu` present | no | **yes** (`nsys` still absent) |
>
> **The BF16 figures agree to ~1%, so both are genuine A40 Secure pods.** What differs is the fabric.
> On the 2026-09-06 pod the default transport does not merely run slowly — it **hangs**, and only
> completes with `NCCL_P2P_DISABLE=1`, at which point NCCL stages through shared memory. This was
> reproduced on **two** independent pods that day (one of which RunPod separately flagged as faulty
> and which measured a further-degraded 2.90 GB/s — quarantined in `p0-evidence/`).
>
> **Consequence: the "no need to hunt for bridge-equipped pods" conclusion above is too strong.** The
> tier does not determine the fabric; the individual pod does. `make rl-probe` must be treated as a
> per-pod gate, not a once-per-tier measurement, and P2b's achievable table depends on which pod it
> lands on. A pod that fails the gate cannot produce the ZeRO-3 / `FULL_SHARD` rows at all.
>
> Diagnostic that separates the two cases: run `all_reduce_perf` under `timeout`. Exit **124** means a
> deadlocked collective, not a slow one — NCCL busy-waits, so a hung collective shows **100% GPU
> utilisation** and is indistinguishable from healthy work on `nvidia-smi`.

**No Nsight tooling.** `ncu` and `nsys` are both absent, so kernel work cannot report occupancy or a
roofline from this pod - only wall clock, memory and numerics. `torch.profiler` does return CUDA
events. The local box is the control here: it has `ncu` and a working `torch.profiler`.

Decision this gates: which tier the reported legs run on. Community is third-party multitenant where
availability varies by provider, so a same-named GPU is not a guarantee of the same interconnect.

## P1 — reward harness ✅

| Metric | Value | Command |
|---|---|---|
| Problems in the catalogue | **60** (16 curriculum, 44 interview) | `make test` |
| Cases, hidden / visible | **320** — 182 hidden, 138 visible | `make test` |
| References that solve their own problem | **60 / 60** | `make test` |
| Cases agreeing with the frozen Judge0 oracle | **202** compared, 2 excluded by name | `make test` |
| Spec fixtures: correct variants accepted | **13 / 13** | `make test` |
| Named mutants rejected by their named case | **13 / 13** | `make test` |
| Grader mutants killed | **10 / 10** | `make mutate` |
| Catalogue sha256 (pinned) | `baa73a0cfb17bad4…` | `make test` |

Hardware: none. CPU only, by design.

## P2 — SFT, parallelism, fault tolerance

| Metric | Value | Spec key | Command |
|---|---|---|---|
| Single-GPU 7.6B Adafactor, peak reserved GiB | NOT MEASURED | | `make bench-parallel` |
| DDP — tokens/s, peak reserved/device | NOT MEASURED | | `make bench-parallel` |
| DeepSpeed ZeRO-2 — tokens/s, peak reserved/device | NOT MEASURED | | `make bench-parallel` |
| DeepSpeed ZeRO-3 — tokens/s, peak reserved/device | NOT MEASURED | | `make bench-parallel` |
| FSDP2 `SHARD_GRAD_OP` — tokens/s, peak reserved/device | NOT MEASURED | | `make bench-parallel` |
| FSDP2 `FULL_SHARD` — tokens/s, peak reserved/device | NOT MEASURED | | `make bench-parallel` |
| `no_sync` gradient buffer, GiB (predicted 14.19, not 7.09) | NOT MEASURED | | `make bench-parallel` |
| Checkpoint recovery after rank kill, **seconds** | NOT MEASURED | | `make faulttest` |
| Gradient check vs single-GPU reference | **PASS**, worst rel 9.41e-07 | gloo/CPU | `training.numerics.gradcheck` |
| Scaling efficiency at 1 / 2 / 4 GPUs | NOT MEASURED | | `make bench-scaling` |

### P2b measured on 2x A40 Secure ✅ — corrected table

Qwen2 architecture, **2.094B params** (8 layers, vocab 32000), seq 1024, AdamW, `mixed_fp32`
(fp32 master weights, bf16 compute, fp32 moments), gradient checkpointing, 8 steps with the first 2
discarded. Records in `docs/p2b/fp32-*.json`.

| Strategy | step ms | tokens/s | vs DDP | peak GiB/dev | vs DDP | moments |
|---|---|---|---|---|---|---|
| DDP (baseline) | 897 | 2284 | 1.00x | 40.63 | — | fp32 |
| **FSDP2 `SHARD_GRAD_OP`** | **618** | **3313** | **1.45x** | 25.60 | **-37%** | fp32 |
| FSDP2 `FULL_SHARD` | 912 | 2246 | 0.98x | **22.59** | **-44%** | fp32 |
| DeepSpeed ZeRO-2 | 762 | 2687 | 1.18x | 34.07 | -16% | fp32 |
| DeepSpeed ZeRO-3 | 679 | 3017 | 1.32x | 36.36 | -11% | fp32 |

Every row records its own moment dtype, so the comparison can be checked rather than believed.

**FSDP2 `SHARD_GRAD_OP` is the pick for this configuration**: fastest by a clear margin and second
lowest on memory. `FULL_SHARD` buys another 3 GiB for 30% of the throughput. DeepSpeed ZeRO-3 is a
close third on speed.

### Fixing the confound changed the ranking, not just the numbers

The first table had FSDP2 on bf16 moments and DeepSpeed on fp32, because torch's AdamW allocates
optimizer state in the *parameter* dtype and the model was built in bf16. The correction was to run
every strategy on the standard mixed-precision recipe — fp32 master weights, bf16 compute — which
DeepSpeed was already doing and the others were not.

| | Confounded | Corrected |
|---|---|---|
| DeepSpeed ZeRO-2 | 0.48x, **+49% memory** | **1.18x, -16% memory** |
| DeepSpeed ZeRO-3 | 0.72x, +47% memory | **1.32x, -11% memory** |
| FSDP2 `SHARD_GRAD_OP` | 1.10x, -17% | 1.45x, -37% |

**DeepSpeed went from last on both axes to competitive on both.** The first table was not merely
imprecise, it was wrong about the conclusion: it made DeepSpeed look bad for doing more numerically
careful work. Anyone reading only the first version would have picked a framework on an artefact.

The general lesson, and the reason `optimizer_state_dtypes` is now in every record: **a framework
comparison must pin numerical precision explicitly, because the frameworks do not default to the
same thing.** Two libraries given the same `bf16: true` flag disagreed on what that meant for
optimizer state.

---

### GaLore reproduced ✅ — 90.62% optimizer-state saving against a published 65.5%

T1's "reproduce one published result". `docs/galore-repro.json`, local RTX 5060 Ti, 8 x
Linear(2048,2048), rank 128, fp32. **The claim is a ratio, so a consumer card tests it as well as a
datacenter one** — attempting it at 7B would have measured the card, not the method.

| | optimizer state | bytes/param |
|---|---|---|
| AdamW | 256.0 MiB (`exp_avg` 128 + `exp_avg_sq` 128) | 8.00 |
| **GaLore r128** | **24.0 MiB** (moments 16 + projection 8) | **0.75** |
| **Measured saving** | **90.62%** | |
| Shape prediction | 90.62% | |
| Paper claim | 65.50% | **reproduced and exceeded** |

Measured and predicted agree exactly, which is the point: the saving is fully explained by the
shapes, so nothing here is a mystery or a fluke.

**The first run said 93.75%, and beating your own arithmetic is how undercounting announces itself.**
GaLore's projection matrix is not a tensor in `opt.state` — it lives inside a `GaLoreProjector`
object under the key `projector`, so a walker that only counts direct tensors misses it. That
omission flattered GaLore by 3 points. It is real memory the method requires, and it now counts.

Optimizer state only, deliberately: peak allocator memory folds in activations and gradients, and a
favourable batch size would flatter either side. Everything is measured **after** `.step()`, because
Adam allocates its moments lazily on the first step — the failure the memory audit originally found.

---

### Gradient equivalence: the parallel strategies compute what one device computes ✅

T1's numerical-correctness criterion. Proved on gloo/CPU at no cost, because correctness is not a
property of the interconnect.

The comparison is the one that is actually correct: the reference processes the **concatenation** of
what the ranks saw, with the same reduction. Give both sides the same total batch or the test
measures batch size rather than parallelism.

| Strategy | tensors | worst relative error | verdict |
|---|---|---|---|
| DDP | 27 | 9.41e-07 | PASS |
| FSDP2 `SHARD_GRAD_OP` | 27 | 9.41e-07 | PASS |
| FSDP2 `FULL_SHARD` | 27 | 9.41e-07 | PASS |

**Near-bitwise, not bitwise.** All-reduce sums in a different order than one device does and float
addition is not associative, so exact equality would fail for a *correct* implementation. 1e-4
relative is the honest claim.

**The identical figure across three strategies was suspicious enough to check.** A gradient check
that cannot fail is decoration, so three plausible bugs were injected and all three are caught:

| Injected fault | worst relative error |
|---|---|
| none (correct) | **9.41e-07** |
| `half-grad` — missing 1/world scaling | 5.00e-01 |
| `no-reduce` — collective never ran | 1.00e+00 |
| `same-row` — every rank trains the same micro-batch | 1.35e+00 |

Six orders of magnitude between correct and broken, so the tolerance is not splitting hairs. The
identical 9.41e-07 is real: it is the same embedding all-reduce reassociation in each case.

---

### P2c scaling curve ✅ — and it does not scale

FSDP2 `SHARD_GRAD_OP`, 2.094B, `mixed_fp32`, seq 1024, A40 Secure. `docs/p2b/curve-*.json`.

| GPUs | step ms | tokens/s | speedup | efficiency | peak GiB/dev | NCCL busbw |
|---|---|---|---|---|---|---|
| 1 | 591 | 1732 | 1.00x | 100% | 41.40 | n/a |
| 2 | 612 | 3344 | **1.93x** | **97%** | 25.60 | 22.11 GB/s |
| 4 | 1499 | 2732 | 1.58x | **39%** | 17.55 | **7.65 GB/s*** |

**Four GPUs are slower than two in absolute terms — 2732 against 3344 tokens/s.** Doubling the
hardware from 2 to 4 lost 18% of the throughput. This is the result the curve existed to find, and
no amount of extrapolating from the 97% two-rank point would have produced it.

**\* The 4-rank number required `NCCL_P2P_DISABLE=1`. With peer-to-peer enabled, the collective
hangs.** `nccl-tests` did not finish in 900 s, and a torch run sat at 100% GPU utilisation on all
four devices with 3.9 GiB allocated and zero completed steps — a busy-wait, not progress.
`NCCL_P2P_LEVEL=NODE` also hung; only fully disabling P2P completed.

The topology explains it. The 2x pod was `PIX` throughout — one PCIe switch. The 4x pod is not:

| | GPU0 | GPU1 | GPU2 | GPU3 |
|---|---|---|---|---|
| GPU0 | X | SYS | SYS | SYS |
| GPU1 | SYS | X | NODE | NODE |
| GPU2 | SYS | NODE | X | PXB |

**GPU0 is on a different NUMA node** and reaches every other device across the socket
interconnect. Cross-socket P2P is a classic 4-rank deadlock, usually PCIe ACS. Disabling P2P stages
every collective through host memory, and busbw falls from **22.11 to 7.65 GB/s** — a 2.9x loss that
drops this pod out of the routing table's top band into `ZeRO-2 / FSDP2 SHARD_GRAD_OP only`.

At 2 ranks the collective hid behind compute (step time 591 -> 612 ms). At 4 it does not: step time
goes to 1499 ms for the same per-rank work.

**What this changes.** The 4x A40 configuration is not usable for scaling on this pod as delivered.
The sharding still works — peak memory keeps falling, 41.40 -> 25.60 -> 17.55 GiB — so 4 GPUs remain
useful for *fitting* a model that does not fit on two. They are not useful for *speed*. Any future
4x booking must run `make probe` first and check the topology for a `SYS` hop before committing
hours to it.

> ### ⚠ The host of the 4-GPU point was later flagged faulty by RunPod
>
> After these measurements, RunPod's console reported on pod `idh7wv10e4vqk2` — the 4x A40 machine
> used for the 4-GPU row: *"We have detected a critical error on this machine which may affect some
> pods... We would recommend backing up your data and creating a new pod."*
>
> **This makes the 4-GPU row unsafe to cite.** The NCCL hang with P2P enabled and the 39% scaling
> efficiency were attributed to the cross-socket `SYS` topology, which was a plausible reading of
> `nvidia-smi topo -m`. It is no longer separable from a hardware fault the vendor has since
> confirmed. Both explanations predict exactly what was observed, and nothing in the data
> distinguishes them.
>
> **What stands:** the 1 and 2 GPU rows, which came from a *different* machine (the 2x A40 pod), as
> did P0, the P2b table and the kernel benchmark. Only the 4-GPU row is affected.
>
> **What to do:** re-measure the 4-GPU point on a healthy host before the scaling curve is used for
> anything. Until then this row is recorded, not relied on, and the honest headline is
> **"97% at two ranks; four unverified"** rather than "four GPUs are slower than two".
>
> The booking rule survives this intact and arguably gets stronger: run `make probe` before
> committing hours, because it caught the hang in 900 seconds instead of during a training run.

**Not concluded:** that A40 x4 is always like this. This is one pod. A different host with all four
devices under one switch would very likely behave like the 2x pod did. What is concluded is that the
GPU count in the order form does not tell you what you got.

---

### The ceilings, which are the more useful numbers

| Attempt | Result |
|---|---|
| DDP, 7.62B, Adafactor + GC | **OOM** — 42.86 GiB allocated, needed 2.03 GiB more |
| DDP, 7.62B, + `expandable_segments` | **OOM** — fragmentation fell 1.01 GiB -> 233 MiB, still short |
| DDP, 5.75B, Adafactor | **41.01 GiB/dev**, 1049.6 tok/s |
| DeepSpeed ZeRO-2/3, 5.75B, Adafactor | **OOM** — needed 10.71 / 3.80 GiB more |
| FSDP2 both modes, 5.75B, AdamW | ran fine |

**The A40 reports 44.43 GiB usable, not 48.** PLAN.md argued Adafactor would make every row fit
because 8-bit AdamW needs 46.19 GiB "on a 48 GB card". Both halves were wrong for this hardware: the
card is smaller than assumed, and DDP allocates gradient communication buckets on top of the
gradients. Sharding is not optional at 7.6B here.

### Two framework constraints found by running them

- **transformers' Adafactor cannot drive FSDP2 on torch 2.4** — `aten.add_.Tensor: got mixed
  torch.Tensor and DTensor`. Its factored state is built with plain `torch.zeros` and is not
  DTensor-aware; torch's own optimizers are. This is why the comparable table is on AdamW.
- **DeepSpeed refuses unvalidated optimizers** without `zero_allow_untested_optimizer: true`.

---

### Settled on CPU, before the pod ✅

Correctness properties, not throughput. They hold identically at 30k parameters on a laptop and at
7.6B on two A40s, so measuring them here costs nothing and leaves the metered hours for the numbers
that genuinely need the hardware. Listed separately because **they are not substitutes for the rows
above** — the wall-clock and memory figures remain unmeasured.

| Property | Result | Command |
|---|---|---|
| Packed vs unpacked gradients agree | **exact**, float64, every parameter | `make test` |
| Loss identical under position offsets (RoPE) | **75.4184506421** for per-document, 0..N and +1000 | `make test` |
| Position reset required for absolute encodings | **yes** — control model diverges | `make test` |
| Killed process resumes to the same curve | **identical**, 12 s.f., all steps | `make faulttest` |
| Optimizer state is load-bearing on resume | **yes** — clearing it diverges | `make test` |
| Half-written checkpoint is refused | **yes**, and `latest()` falls back | `make test` |

Baseline for context, **not a valid comparison**: QLoRA 411.9 tok/s at seq 1024 — measured on an
RTX 5060 Ti during the memory audit, on different silicon and a different method.

## P3 — GRPO

### Base pass rate: the corpus is marginal, and binary reward would waste most of it

`docs/base-pass-rate.json`. Qwen2.5-Coder-1.5B-Instruct, 8 completions per problem, temperature 0.8,
all 60 problems, graded through `reward/limits.run_isolated`.

| Reward shape | Problems carrying signal |
|---|---|
| **Binary** (solved / not solved) | **7 / 60** — dead-group fraction **88.3%** |
| **Partial credit** (fraction of cases passed) | **27 / 60** |

Mean pass rate **0.037**. Nothing was always-solved; **53 were never solved**. Only 4 timeouts in
480 gradings, so the sandbox is doing its job without distorting the result.

**Partial credit is not a refinement here, it is the difference between a usable corpus and a dead
one.** Of the 53 problems no completion ever solved, 20 still passed *some* cases — `min-max-scale`
at 0.38, `broadcast-shapes` at 0.35, `sigmoid` at 0.25. Those groups have within-group variance and
therefore a gradient, and a binary reward throws all of it away. The plan already specified partial
credit by cases passed; this is the number that justifies it: **7 -> 27, a 4x larger usable set**.

The remaining **33 score exactly zero** — nothing runs at all. Those are genuinely dead and should
be filtered out before training rather than burning rollouts.

### 7B vs 1.5B: better at the task, no better as a training signal

`docs/base-pass-rate-7b.json`. Qwen2.5-Coder-1.5B-Instruct against Qwen2.5-7B-Instruct, identical
settings — 8 completions, temperature 0.8, all 60 problems. **Both run locally on the 5060 Ti at no
cost**, the 7B from a copy already in the HF cache.

| | Coder-1.5B | Instruct-7B |
|---|---|---|
| Usable, binary (10-90%) | 7 | **6** |
| Always solved | 0 | **2** |
| Never solved | 53 | 52 |
| Mean pass rate | 0.0375 | **0.0729** |
| Mean case fraction | 0.087 | **0.166** |
| Dead-group fraction | 88.3% | **90.0%** |
| **Total with signal** (binary + partial) | **27** | **32** |

**The 7B is twice as good at the task and slightly worse as a GRPO curriculum.** Pass rate and case
fraction both double. Binary-usable problems go *down*, 7 to 6, because two problems became
always-solved — dead from the opposite end. Exactly one problem crossed from never-solved into the
band (`thread-index-mapping`, 0/8 to 2/8). Nothing regressed.

**Both of my earlier explanations were half right, and they cancel.** I first argued a bigger model
would solve too many problems and starve the signal; then the 1.5B data made me reverse and say the
policy was simply too weak. The 7B shows both effects are real and roughly offset: it does solve
more (0 to 2 always-solved, mean pass rate doubled) *and* it leaves 52 problems untouched. A 4.8x
increase in parameters bought **five** more problems with any signal at all.

### The constraint is the corpus, not the policy

That is the finding, and it is worth more than either pass rate. 52 of 60 problems are unsolved by a
7B model at temperature 0.8 with eight attempts each. These are ML/DL interview questions, not
warm-ups, and no model in the size range this project can afford will make most of them learnable.

**So do not book an A40 to run GRPO on this corpus.** It would spend $9.68 training against ~32
problems at a 90% dead-group rate, and the measurement to justify it has now been taken twice, for
free, on hardware already owned.

**The plan's documented fallback becomes the route rather than the contingency:** train on a public
verifiable corpus and hold all 60 of these out for evaluation. That preserves what the 60 are
actually good for — an ungameable, hidden-case, three-way-validated *evaluation* set, which is the
scarcer artefact anyway.

### This reverses my stated reason for choosing a 1.5B model

I argued that a bigger model would solve too many problems and starve GRPO of signal, so 1.5B sat in
the sweet spot. **The measurement says the opposite.** Nothing is always-solved; 53 of 60 are never
solved. The policy is far too *weak* for this corpus, not too strong — these are ML/DL interview
problems, not warm-ups.

The dead-group argument was sound in general and wrong about the direction here, which is exactly
the sort of thing that only measurement settles. A stronger policy — Qwen2.5-Coder-7B is the obvious
candidate and fits an A40's 44.43 GiB comfortably — would move problems *into* the 10-90% band
rather than out of it.

**Open, and it decides P3a's model:** whether 7B with LoRA and a colocated vLLM fits the local 16 GiB
card. The fused cross-entropy kernel bought 1.71 GiB of headroom at 1.5B and would buy more at 7B,
where the loss head is the same 152k vocabulary. Worth measuring before defaulting back to the A40.

### Does the colocated setup fit the local 16 GiB card? ✅ Yes, but thinly

`docs/grpo-fit-local.json`. Qwen2.5-Coder-1.5B-Instruct, LoRA r=32 (36.93M trainable), seq 1024,
generating 1024 more, group size 8.

| | GiB | how |
|---|---|---|
| Weights, bf16 | 2.88 | measured |
| **Training peak** (LoRA + grad checkpointing + AdamW) | **10.00** | **measured** |
| Second weight copy for the inference engine | 2.88 | derived |
| KV cache, 8 seqs x 2048 tokens | **0.44** | derived |
| **Floor** | **13.31** of 15.93 | |
| **Headroom** | **2.61** | |

**Measured and derived are kept apart on purpose.** The training peak is real. The KV cache is exact
arithmetic from the model config, but **vLLM adds its own allocator overhead and CUDA graph buffers
on top**, so 13.31 is a floor rather than a total, and 2.61 GiB of headroom is thin for it.

**The KV cache is almost free — 0.44 GiB — because Qwen2.5 uses grouped-query attention**: 2 KV
heads against 12 attention heads. Without GQA the same cache would be six times larger and the
question would not be close.

**The surprise is the 10.00 GiB training peak, 3.5x the weights**, for a LoRA fine-tune with
gradient checkpointing. Most of that is the loss head: a 151936-token vocabulary at seq 1024 is
~0.3 GiB of logits, and `F.cross_entropy` materialises it about three times. **This is exactly what
the fused kernel from P4a addresses** — it saved 148.5 MiB at 512x152064, so roughly 0.3 GiB here,
which is over 10% of the remaining headroom.

### Wiring the P4a kernel into the GRPO path ✅

`docs/grpo-fit-local-fused.json`. Loss routed through the Triton kernel instead of HF's internal
`F.cross_entropy`, via `training/kernels/hf_loss.py`.

| | baseline | fused | change |
|---|---|---|---|
| Training peak | 10.00 GiB | **8.29 GiB** | **-1.71 GiB, -17%** |
| Colocate floor | 13.31 | **11.61** | |
| **Headroom** | 2.61 | **4.32 GiB** | **+66%** |

Correctness checked before the saving was believed. Against HF's own loss on the same inputs:
unmasked agrees to 1.91e-06, and with prompt tokens masked to `-100` — the case GRPO actually runs —
it is **exact, 0.00e+00**.

**I under-predicted this by 5x.** The estimate was ~0.3 GiB, scaled from the 148.5 MiB the kernel
saved at 512x152064. The real figure is 1.71 GiB, because HF **upcasts logits to fp32** before
computing the loss: at 1023 x 151936 x 4 bytes that is ~0.58 GiB per tensor, and there are about
three of them. The kernel accumulates in fp32 internally but never materialises an fp32 `[N, V]`, so
it avoids all three. The estimate was wrong for a reason worth knowing rather than by luck.

**This changes the verdict from tight to comfortable.** 4.32 GiB of headroom leaves real room for
vLLM's allocator overhead and CUDA graph buffers, so P3a runs locally and its 22 hours leave the
meter — **$9.68 saved**, against a kernel that was built for a different phase entirely.

**Verdict: run P3a locally.** If vLLM will not co-exist, the levers in order
of cheapness are the fused cross-entropy kernel, group size 8 -> 4, and shorter generations. If none
of that is enough, P3a returns to the A40 at $9.68 — which is the number this measurement was worth
finding out about.



| Metric | Value | Spec key | Command |
|---|---|---|---|
| Base **greedy** pass@1 on held-out | **4/60 = 0.0667** [0.026, 0.159] | | `grpo-runs/grpo-run-lr5e-6.json`, step 0 — **re-measured 2026-09-06 by `make rl-eval`, reproduced exactly** |
| Base **sampled** pass@1 (unbiased) | **0.0396** [0.0083, 0.075] | | `make rl-eval`, `docs/rl/rl-eval-base-only.json` |
| Base pass@k (n=8) | **@1 0.0396 · @2 0.0625 · @4 0.0805 · @8 0.0833** | | same record |
| Post-RL **greedy** pass@1 on held-out | **3/60 = 0.0500** [0.017, 0.137] | | same record, step 200 |
| Prompts surviving the 10–90% base-pass filter | **184 (9.2%)** in-band; **1060** with any signal — the run trained on the 1060 | | `filter_corpus.py` summary |
| Dead-group rate, start and end | **51/200 = 25.5%** aggregate; start/end **not logged separately** | | `grpo-run-lr5e-6.json` |
| KL divergence at convergence | **0.0033** at step 200 (0.0010–0.0040 across the five evals) | | P3 step table above |
| Weight-sync overhead, % of step | NOT MEASURED — needs the P3b trainer/`vllm-serve` split, never run | | `make rl-eval` |

> **These five were derived from the run records already on disk, not from a new `make rl-eval`.**
> They sat at `NOT MEASURED` while the numbers existed in `grpo-runs/` — a bookkeeping gap, not a
> measurement gap.
>
> **Read "greedy" literally.** `greedy_solved / problems` is pass@1 under *greedy* decoding: one
> deterministic sample per problem. It is **not** the sampled unbiased pass@1 estimator, and the two
> are not interchangeable. The sampled variant is not recoverable from these records, because only
> the aggregate `solved_any` was stored, never per-problem success counts.
>
> **Neither interval excludes the other, and the change is one problem.** At n=60 a single problem
> moves pass@1 by 0.0167, so the instrument cannot resolve anything finer. The `-0.0167` delta is
> exactly that one problem and must not be read as a regression.
>
> ### Re-measured 2026-09-06 with the standalone harness (`scripts/rl_eval.py`)
>
> The sampled estimator is **no longer derived** — it is measured. The harness stores per-problem
> `c` and `n`, so pass@k for any k is now recomputable offline, which is exactly what the original
> run could not do.
>
> **It reproduces the loop's step 0 exactly:** greedy **4/60**, Wilson **[0.0262, 0.1593]**, against
> the `[0.026, 0.159]` published above. Getting there required matching the trainer on four points,
> and each mismatch changed the answer:
>
> | | trainer | first harness attempt |
> |---|---|---|
> | `max_new` | 640 | 512 |
> | `grade_timeout` | 8.0 | 10.0 |
> | dtype | **bfloat16** | float16 |
> | eval group | 4 | 8 |
>
> fp16-vs-bf16 alone moved greedy from 4/60 to 3/60. The eval set was **not** a factor: the
> catalogue sha256 is still `baa73a0cfb17bad4…`, byte-identical to the pinned value.
>
> **Open caveat — greedy determinism is conditional on batch shape.** The `--group 4` run scored
> greedy **3/60** and the `--group 8` run **4/60**, from an identical greedy call
> (`do_sample=False`, `num_return_sequences=1`, same prompt, same weights); only the sampling batch
> run alongside it differed. So `greedy_solved` is reproducible *within* a fixed configuration but
> not *across* configurations. This matters more than it looks: **one flipped problem is 0.0167**,
> which is the entire size of the "no measurable transfer" delta the headline run reported. The
> greedy metric's claim that "any change in it is a real change in the policy" holds only when
> batch shape is held fixed too.
>
> Only the **lr=5e-6** run supports these rows. The 1e-6, 2e-6 and 2e-5 runs predate the
> `greedy_solved` metric and record only `solved_any` / `solve_rate` / `mean_case_fraction`, so
> greedy pass@1 is genuinely unavailable for them rather than merely unreported.
| Own GRPO loop vs TRL, agreement | NOT MEASURED | | `make rl-eval` |
| Reward-hacking attempts found | NOT MEASURED | | `docs/RL_FINDINGS.md` |

The prompt count after filtering is the number to watch. 60 problems is the constraint on this phase,
not model size.

## P4 — kernels and precision

### Kernel benchmark on the A40 - both settled ✅

`docs/bench-kernels-a40.json`, A40 Secure, torch 2.4.1+cu124, Triton 3.0.0. Baselines are the real
PyTorch ops, not the eager oracles - beating a naive reference proves nothing.

| Kernel | Baseline | Fused | Speed | Memory |
|---|---|---|---|---|
| **Cross-entropy** 512x152064 | 3.883 ms / 594.0 MiB | **3.198 ms / 445.5 MiB** | **1.21x faster** | **-25.0%** |
| **RMSNorm** 2048x3584 | 1.287 ms / 168.0 MiB | 1.901 ms / 98.1 MiB | **0.68x - 47% slower** | -41.6% |

**Cross-entropy: keep.** Wins on both axes. Cross-checked against WSL2, which measured the same
**148.5 MiB** saving on different silicon with a different harness.

**RMSNorm: do not use in the training path.** It trades throughput for memory, and it is the wrong
trade - it saves 41.6% of the part of the model that is not the bottleneck (all 28 transformer
layers are 0.19 GiB against the loss head's 2.04 GiB) while costing 47% of the speed. Kept in the
repo as a tested negative result, because knowing it was tried and why it lost is worth more than
the code.

### Fused cross-entropy — correctness settled, memory measured ✅

Local, WSL2, RTX 5060 Ti (Blackwell sm_120), Triton 3.7.1, torch 2.13.0+cu129. **Memory is a ratio
on one card, not a datacenter figure** — D-008 and D-010.

| Property | Result |
|---|---|
| Peak on the loss head, 512 × 152064 vocab, bf16 | `F.cross_entropy` **445.5 MiB** vs fused **297.0 MiB** |
| Saved | **148.5 MiB, 33%** — about one full `[N, V]` tensor |
| Loss vs reference, `mean` / `sum` | agree within 2e-3 |
| Unreduced loss vs **fp32 truth** | fused off by **0.000001**; the bf16 reference off by **0.031237** |
| Gradient vs reference | agrees within 2e-3 |
| `ignore_index` gradient | **exactly** zero |
| Fully-masked batch | 0.0, not NaN |
| Tests | **10 / 10** (`pytest tests/test_kernels.py` under WSL2) |

Throughput is **NOT MEASURED**: correctness and memory came first, and a wall-clock number from a
consumer card under WDDM is not a figure this plan is allowed to quote.

| Metric | Value | Spec key | Command |
|---|---|---|---|
| Fused cross-entropy — peak memory | **445.5 -> 297.0 MiB (-33%)** | local WSL2 | `pytest tests/test_kernels.py` |
| Fused cross-entropy vs eager — time | NOT MEASURED | | `make kernel-bench` |
| Fused RMSNorm — peak memory vs `F.rms_norm` | **parity, +0.2%** (70.0 -> 70.1 MiB) | local WSL2 | `pytest tests/test_rmsnorm.py` |
| Fused RMSNorm vs eager — time | NOT MEASURED — **needs the A40** | | `make kernel-bench` |
| Kernel numerics, forward and backward | NOT MEASURED | | `make kernel-bench` |
| FP8 vs BF16 — throughput, memory, loss divergence | NOT MEASURED | | `make fp8-bench` |

### The RMSNorm kernel does not pay for itself on memory

Recorded as a result rather than quietly dropped. At 2048x3584 bf16, peak is **70.0 MiB for
`torch.nn.functional.rms_norm` against 70.1 MiB fused** — parity, never better.

An earlier version of this row claimed a 68% saving. That figure came from comparing against
`eager_add_rmsnorm`, which is the *correctness oracle* — written the obvious way with fp32 upcasts —
and beating it proves nothing. PyTorch already ships a fused `rms_norm`, so the only thing left to
fuse was the residual add, and that is not where the memory is.

The memory audit predicted this before the kernel was written: the loss head is 2.04 GiB of
2.57 GiB, and all 28 transformer layers together are 0.19 GiB. RMSNorm optimises inside the 7%. The
strip width also turned out to be load-bearing — at 4 rows per program the dweight partial buffer
was 7 MiB and made the kernel 10% *worse* than the baseline; 256 rows brings it to 0.1 MiB.

**What is left unproven is throughput** — fewer kernel launches, one pass over `[N, D]` instead of
several. That is a wall-clock claim, and no wall-clock figure may be quoted from this WDDM box, so
it stays NOT MEASURED until the A40. The kernel is kept because it is correct, tested and cheap to
keep, not because it has earned its place yet.

Justification for the cross-entropy kernel, inherited from the memory audit: at seq 1024, **2.04 GiB
of 2.57 GiB** activation is the loss head and 0.19 GiB is all 28 transformer layers.

---

## P2a — single-GPU 7.6B Adafactor ✅, and the estimator is optimistic

`a40 x1`, `--strategy single`, 28 layers, seq 1024, Adafactor, bf16 native, gradient checkpointing.

| | predicted | **measured** | error |
|---|---|---|---|
| peak @1024 | 31.65 GiB | **37.17 GiB reserved** (36.81 allocated) | **+17.4%** |
| fits one card? | yes | **yes** — 44.42 GiB usable, 7.25 GiB free | verdict holds |
| throughput | — | **500.1 tokens/s**, 2047 ms/step | — |
| params | 7.6B | **7.616B** | — |

**The verdict survives; the margin does not.** A full-parameter 7.6B fine-tune does fit one A40,
which is what `PLAN.md` routed on. But the audit's estimator claims worst error **2.42% static /
9.51% activation**, and this is **17.4% low** — outside its own error bars even measured on
allocated rather than reserved (+16.3%). Headroom is 7.25 GiB, not the 12.77 predicted, so the
projected max sequence of ~6,100 should be treated as unverified: at +17% the real ceiling is
nearer 4,000.

`optimizer_state_dtypes: {"exp_avg_sq": "torch.float32"}` — **Adafactor keeps fp32 state under a
bf16 model.** Worth stating, because the sister failure is already recorded here for AdamW, which
does the opposite and silently inherits bf16. Any estimate assuming bf16 optimizer state for
Adafactor is wrong in this direction.

**A methodology note, because the first attempt got it wrong.** Running `--strategy ddp` at
`--nproc_per_node=1` is *not* a single-GPU measurement: DDP allocates gradient buckets for the
all-reduce even with one rank, a full extra copy of the gradients (~15 GiB at this size). That run
OOM'd at 43.84 GiB and would have been reported as the estimator being 40% wrong, when most of the
gap was a wrapper the experiment had introduced. Hence `--strategy single`, which wraps nothing.

## P3b — rollout generation, HF `generate` vs vLLM ✅

`a40 x1` of a x2 pod, Qwen2.5-Coder-1.5B, 12 timed prompts x G=16, `max_new` 640, temp 0.8.
vLLM 0.26.0. Generation only — no training, no grading.

| backend | tokens | sec | tok/s | speedup |
|---|---|---|---|---|
| `hf_generate` | 28,809 | 80.77 | 356.7 | 1.00x |
| **`vllm_per_prompt`** | 23,820 | 21.09 | **1,129.3** | **3.17x** |
| **`vllm_batched`** | 26,092 | 5.55 | **4,699.8** | **13.18x** |

`vllm_per_prompt` is how the GRPO loop actually calls a sampler — one prompt, G completions — and
**3.17x is the number that applies to P3a as written**. `vllm_batched` submits all prompts at once
and shows what continuous batching is worth if the loop is restructured to sample several prompts
per step: another 4x on top.

**Token counts are within 1.21x of each other**, which is the check that makes the ratio meaningful
rather than an artefact of one backend doing less work.

**That check caught a real error.** The first version of `bench_rollout.py` applied
`apply_chat_template` in the HF path but passed the raw prompt to vLLM. Without the template the
model does not reliably emit `<|im_end|>` and runs on toward `max_tokens`, so vLLM produced
**66,587 tokens against HF's 28,809** — it was being handed a harder task and doing more work, not
the same work faster. The giveaway was that the two ratios disagreed: 3.32x on tokens/s against
1.44x on wall clock. After templating both paths they agree (3.17x and 3.83x), and the remaining
gap is vLLM emitting slightly fewer tokens.

**What this does not change.** P3a measured no transfer, and P3b makes that loop faster, not
better. The value is engineering: a 3.17x sampler turns a 2.5-hour 200-step run into roughly
50 minutes, which is what makes a longer run affordable — not what makes it work.

## P3 — corpus filter and GRPO ✅

### The filter pass, 2x A40 Secure, 2000 DeepCoder problems, G=8, max_cases=20

| | |
|---|---|
| in-band (10-90% pass rate) | **184** (9.2%) |
| **always solved** | **0** |
| never solved | 1816, of which **876 score partial credit** |
| **with ANY signal** | **1060** |
| mean pass rate | 0.024 |
| harness errors | **0** |

**`always_solved: 0` inverts the prediction in `P3-CORPUS-SCOPE.md` §5.** The corpus is *harder*
than the policy, not easier, so dead groups are all-fail rather than the all-pass that document
anticipated. `dead_group_rate` counts both, so the diagnostic holds either way.

`P3-CORPUS-SCOPE.md` §3 hypothesised ~20% in-band; the measured 9.2% is under half. But the gap
between **184 and 1060** is the partial-credit argument reproducing at scale — the same effect that
took the 60 local problems from 7 usable to 27. Training on the strict band would have discarded
876 problems whose completions genuinely vary in case fraction.

### Eval baseline on the 60 held-out problems

`solved_any 5/60`, `solve_rate 0.0833`, `mean_case_fraction ~0.111` — reproduced across three
independent runs, and consistent with the separately measured 7/60 base rate.

### The lr sweep — and why it is not yet conclusive

| lr | KL | `mean_case_fraction` | dead groups |
|---|---|---|---|
| 1e-6 | 0.0001, flat | 0.1119 -> flat | — |
| 2e-6 | 2-5e-4, no drift over 100 steps | 0.1110 -> 0.0649 | 26% @100 |
| 2e-5 | 0.0442 -> peak **0.2822** @140 -> 0.1018 @200 | 0.1119 -> 0.0825 -> 0.0722 | 63/200 (31.5%) |

**These rows cannot be compared.** At 2e-6 the policy provably did not move — KL flat at ~3e-4
across 100 steps — and the eval still fell 42%. A metric that swings that far with the policy
frozen cannot resolve the differences between these rows, so the natural reading ("2e-5 degrades
the policy") is not supported by its own evidence. See **D-014**.

### The instrument, after D-014 ✅

`scripts/eval_noise_floor.py`, two evals of an **unchanged** policy:

| metric | run A | run B | \|diff\| |
|---|---|---|---|
| `solve_rate` | 0.1000 | 0.1000 | **0.0000** |
| `mean_case_fraction` | 0.0944 | 0.0944 | **0.0000** |
| `greedy_case_fraction` | 0.1231 | 0.1231 | **0.0000** |

`greedy_deterministic: true`, `common_random_numbers_working: true`. Repeat evals now agree
exactly, so any subsequent movement is movement in the policy. Detection threshold **0.0214**
(2 SE), and note `case_fraction_se` understates — it treats 480 completions as independent when
they are clustered by problem, so the effective n is nearer 60.

### 30B-A3B via vLLM, lr=1e-5, 50 steps, LoRA r=16 attention-only — 2026-09-06

Record: `docs/rl/grpo-run-30b-vllm.json`. Policy **Qwen3-Coder-30B-A3B-Instruct**, 4-bit NF4 QLoRA,
rollouts served by vLLM 0.11 from the AWQ build with the adapter hot-reloaded each step.

| step | solved_any | solve_rate | `mean_case_fraction` | se | **`greedy_solved`** | `greedy_cf` |
|---|---|---|---|---|---|---|
| 0 | 19 | 0.3167 | 0.4604 | 0.0558 | **18** | 0.4386 |
| 50 | 21 | 0.3500 | 0.4719 | 0.0574 | **18** | 0.4219 |

`dead_groups: 36/50` (**72%**). KL 0.0090 / 0.0054 / 0.0056 / 0.0771 at steps 10/20/30/40.

> ⚠️ **Correction, 2026-09-09.** The phrase "the metric that cannot be sampling noise" below is
> WRONG, and it is left in place with this note rather than quietly edited. Measured directly on a
> frozen policy (§ *The noise floor*, above): `holdout_greedy_solved` ranged **59–68 across three
> identical evals**, sd 4.5 of 120. Greedy decoding is deterministic in principle but not in this
> harness, because batched generation makes a request's numerics depend on what shares its batch.
> The conclusion *here* is unaffected — this run's greedy was flat, and flat is flat either way —
> but the stated reason for trusting it does not hold.

**No measurable change.** `mean_case_fraction` moved **+0.0115 against SE 0.0574 — 0.2 SE**. `greedy_solved`,
the metric that cannot be sampling noise, is **flat at 18/60**. `solved_any` +2 is inside binomial noise at
n=60. KL reaching 0.0771 shows the policy demonstrably moved: **policy moved, eval did not** — the same
finding as the 1.5B run, now reproduced at a **20× larger model**, which makes the null stronger than
either run alone.

**The model upgrade, by contrast, is a large real gain.** Same eval, same harness, step 0:

| policy | greedy pass@1 | `mean_case_fraction` |
|---|---|---|
| Qwen2.5-Coder-1.5B | 4/60 (0.067) | 0.0944 |
| Qwen2.5-Coder-7B | 6/60 (0.100) | 0.2033 |
| **Qwen3-Coder-30B-A3B** | **18/60 (0.300)** | **0.4604** |

**4.5× the 1.5B on greedy pass@1.** The gain came from the policy, not from RL.

> #### Root cause of the 72%: the band was calibrated against the wrong model
>
> `data/deepcoder-band.json` records its own provenance — `model: Qwen/Qwen2.5-Coder-1.5B-Instruct`,
> `always_solved: 0`, `never_solved: 1816/2000`, `mean_pass_rate: 0.024`, `with_any_signal: 1060`. That
> 1060 is exactly the set this 30B trained on.
>
> For the **1.5B**, nothing was always-solved. For the **30B** — 4.5× stronger, mean case fraction 0.4604
> against 0.0944 — a large share of those problems are now solved on **every** sample. Identical scores
> across a group means zero advantage and zero gradient: dead **from the top**, which is precisely the
> failure mode this ledger already documented when comparing the 7B against the 1.5B (binary-usable fell
> 7 → 6 as two problems became always-solved).
>
> This ledger states the band is "a property of the model/corpus pair, not of the corpus". The run
> violated that. **The fix is to re-run `filter_corpus.py --model <the 30B>` and train on its own band**,
> not to train longer or scale further.

### 30B-A3B on its OWN band, G=16, in-domain holdout — 2026-09-07 ✅ mechanism, ❌ eval

Record: `docs/rl/grpo-run-30b-g16.json`, completions `docs/rl/completions-30b-g16.jsonl`, band
`data/deepcoder-band-30b.json`. 511 training problems, 40 held out in-domain, 60-problem catalogue
eval unchanged. `GRPO_EXIT=0`, 50/50 steps.

**The band was the problem, and re-measuring it against the right model proved it.**

| | 1.5B band (previous run trained on this) | **30B band (this run)** |
|---|---|---|
| `usable` (strict 10–90%) | 184 | **551** |
| `always_solved` | **0** | **147** |
| `never_solved` | 1816 | 1302 |
| `mean_pass_rate` | 0.024 | **0.2151** |
| `in_band_fraction` | 0.092 | **0.2755** |

`always_solved: 0 → 147` is the whole argument. Those 147 problems were selectable under the 1.5B
band; for the 30B every one is a group where all G completions score identically — zero advantage,
**dead from the top**.

**The prediction held.** `dead_groups` **72% → 36%**, exactly halved, and the windowed rate shows the
cumulative figure is dragged up by early steps:

| steps | 1–10 | 11–20 | 21–30 | 31–40 | 41–50 | cumulative |
|---|---|---|---|---|---|---|
| **this run** | 70% | 40% | 30% | **20%** | **20%** | **18/50 = 36%** |
| previous run | 60% | 65% | 67% | 70% | 72% | 36/50 = 72% |

The G=16 prediction was ~27%. Steady state landed at **20%**, below it. The previous run's rate rose
monotonically; this one falls. The early-step excess is dead-from-the-**top** (step 10's logged group
was 16/16 at reward 1.000) — the residual off-template banding, recorded below.

**`skipped_steps: 4` is the grading-stall fix earning its place.** Those four steps had every source
returned as `timeout`/`died`. Under the previous code they would have been read as G identical zeros,
i.e. **counted as dead groups** — the run would have reported 22/50 = 44% instead of 36%. The primary
diagnostic was being inflated by 8 points by grading stalls alone.

**The eval, however, is another null.**

| metric | step 0 | step 25 | step 50 | Δ vs SE |
|---|---|---|---|---|
| `greedy_solved` (60) | 17 | 17 | **19** | +2, inside binomial noise |
| `mean_case_fraction` | 0.4549 | 0.4517 | 0.4710 | **+0.30 SE** |
| `holdout_greedy_solved` (40) | 24 | 22 | **22** | −2 |
| `holdout_mean_case_fraction` | 0.5448 | 0.4967 | 0.5568 | **+0.20 SE** |

Nothing clears 2 SE. The step-25 in-domain dip (−0.80 SE) reverted by step 50, so it was noise. KL
0.0057–0.0084: the policy moved, slightly, and neither eval followed.

**What the holdout bought.** The in-domain baseline is **greedy 24/40 (60%)** against the catalogue's
**17/60 (28%)** — a distribution gap of more than 2×. Previous runs could only report "the eval did
not move" and could not distinguish that from "learned something that does not transfer". This run
can: in-domain did not move either. The null is now a null *in the training distribution*, which is a
strictly stronger result than any previous run could support.

**Two things to fix before the next attempt:**

1. **Truncation at ~31% of training rollouts** (`truncated: 473`), stable across every eval-free
   window (51/160, 49/160, 46/160). A completion cut at `--max-new 640` reaches the grader as
   incomplete source and lands at the bottom of its group, so GRPO pushes away from whatever produced
   it. If that is an artefact of the token budget rather than genuine badness, a third of the
   gradient signal is teaching "write shorter", which is not the target. Raise `--max-new` **and**
   re-measure the band at the same value, or the two go out of sync again.
2. **The band is still off-template** (below). The fix is in `filter_corpus.py`; the band this run
   used predates it.

`oom_skipped: 0` across all 50 steps — the broadened OOM guard was never needed, and no step was
abandoned. Eval `stalled` was 0/1/0.

### The uncapped run: an in-domain gain that does not transfer ✅ — 2026-09-08/09

Records: `docs/rl/grpo-run-30b-uncapped.json`, `docs/rl/greedy-noise-floor.json`,
`docs/rl/completions-30b-uncapped.jsonl`. Policy at `artifacts/policy-30b-uncapped/`.
On-template band, `--problems-per-step 2 --group 16 --max-new 1024 --max-cases 0 --lora-r 32
--holdout 120`, 175 steps, `GRPO_EXIT=0`.

#### 1. Dead groups: solved

| run | band | config | dead groups |
|---|---|---|---|
| 30B | 1.5B-calibrated | G=4, B=1 | **72%** |
| 30B | 30B off-template | G=16, B=1 | **36%** |
| **30B** | **30B on-template** | **G=16, B=2** | **45/350 = 12.9%** |

The cause was identified and then confirmed by measurement rather than assumed: the on-template band
excludes the 285 problems the policy solves on *every* sample, which off-template measurement had
mislabelled as 10-90%. Of the previous run's 511 training problems, ~92 (18%) were dead-from-the-top
before a gradient was ever computed.

#### 2. The eval, all seven points

| metric | 0 | 25 | 50 | 75 | 100 | 125 | 150 | 175 |
|---|---|---|---|---|---|---|---|---|
| holdout `mean_case_fraction` (n=120) | 0.5680 | 0.5552 | 0.6280 | 0.6196 | 0.5982 | 0.6343 | 0.6606 | **0.6385** |
| *vs baseline* | -- | -0.44 | +1.94 | +1.74 | +0.93 | +2.14 | +2.90 | **+2.19 SE** |
| catalogue `mean_case_fraction` (n=60) | 0.4479 | 0.4534 | 0.4277 | 0.4341 | 0.4220 | 0.4438 | 0.4181 | **0.4138** |
| *vs baseline* | -- | +0.10 | -0.39 | -0.26 | -0.50 | -0.08 | -0.60 | **-0.67 SE** |

**In-domain: +0.0705, six of seven evals above baseline. Transfer: none, in this or any run.**

#### 3. The noise floor — the measurement that decided the interpretation

Three identical evals with the policy **frozen**. Whatever moves here is the instrument, not learning.

| metric | repeat 1 | 2 | 3 | spread | sd |
|---|---|---|---|---|---|
| `holdout_mean_case_fraction` | 0.6575 | 0.6334 | 0.6386 | 0.0241 | **0.0127** |
| `holdout_greedy_solved` | 68 | 59 | 63 | **9** | **4.51** |
| `holdout_greedy_case_fraction` | 0.6981 | 0.6314 | 0.6599 | 0.0667 | 0.0335 |

**`greedy_solved` IS NOT DETERMINISTIC HERE, and this ledger previously claimed it was.** On an
unchanged policy it ranged 59-68. Its documented justification -- "movement here cannot be sampling
noise" -- is false once the eval generates in batches: vLLM's continuous batching changes a
request's numerics with batch composition, and the eval issues 4 sampled completions alongside the
greedy one. Every greedy-based number in this run is inside the floor: the +11 at step 100, and the
final +5, are 2.4 and 1.1 sd respectively. **They are discarded.**

**The mean-based result survives and the SE test was conservative.** Instrument sd 0.0127; propagated
over a baseline-vs-final difference ~0.018 against an observed +0.0705, i.e. **~3.9x the instrument
noise**. The per-eval SE used for the 2 SE test (0.0319) is *larger* than the instrument noise, so
that test already absorbed it.

*Confound, stated against the result:* the floor was measured at `--gpu-util 0.85` with no trainer
resident, while the run used 0.40 alongside a live trainer. Different scheduling and contention could
make the in-run floor higher, so treat 3.9x as an upper estimate.

#### 4. Run health

`oom_skipped: 0` across 175 steps. `short_groups: 0`. `steps_without_update: 7/175`.
`skipped_groups: 28` -- grading stalls, ~8% of training signal discarded, the standing cost of
`--max-cases 0`. `truncated: 2475` completions hit the 1024-token wall.

#### 5. What this does and does not establish

**Does:** GRPO on a correctly calibrated band produces a measurable in-domain improvement --
+0.0705 case fraction on 120 held-out DeepCoder problems, ~3.9x the eval's own noise, sustained
across six of seven evals while KL rose from 0 to a 0.138 peak.

**Does not:** any transfer. The 60 authored problems moved -0.67 SE here and have never moved in any
run. **This is the project's headline finding and it is negative.** The in-domain gain is the
control that makes it interpretable: earlier runs could not distinguish "learned nothing" from
"learned something that does not transfer". This one can, and it is the latter.

**Cannot attribute.** Four variables changed at once entering this run (all cases, r=32, B=2,
max-new 1024). A confirmed gain says nothing about which caused it; that needs an ablation.

**Seven looks at one 2 SE test**, with no pre-registered multiple-comparisons correction. The
per-eval fluctuation is ~1 SE, so no single reading is meaningful on its own -- the sustained
elevation is the evidence, not the maximum.

### Where a GRPO step actually spends its time ✅ — 2026-09-07

Measured on the A40 with the per-phase timers, `--problems-per-step 2 --group 16 --max-new 1024
--max-cases 0` (32 completions per step), Qwen3-Coder-30B-A3B 4-bit QLoRA r=32:

| phase | seconds | share |
|---|---|---|
| generation (vLLM, batched) | 58 | 10% |
| **grading** | **2** | **0.4%** |
| **backward** | **493** | **88%** |
| **total** | **559 s/step** | |

**Backward is the wall, and nothing about the reward harness changes that.** 493 s over 32
completions is **15.4 s each**: a policy forward, a reference forward with the adapter disabled, and
a gradient-checkpointed backward that recomputes the forward — three to four forward-equivalents on
a 4-bit 30B at ~2,500 tokens. bitsandbytes 4-bit is slow for training and no flag makes it fast.

Cost model that follows: **step seconds ≈ 15.4 × (problems_per_step × group) + 58.** Everything else
is rounding. So the only levers on wall-clock are the completion count per step and sequence length.

#### How grading got to 0.4%, and what it cost to learn

Grading was the bottleneck twice, for two different reasons, and both were found by measurement
rather than reading:

| configuration | grading behaviour |
|---|---|
| `--max-cases 20`, one child per group | cheap enough to hide the serialisation |
| `--max-cases 0`, one child per group | ~1,600 executions serialised in ONE child; 8 children on a **96-core** box, GPU at 23–28%, **>3 min/step** |
| `--max-cases 0`, chunks of 4, concurrent | **2 s/step** |

Two process lessons, recorded because they cost real GPU hours:

1. **Removing a cap changes what else scales.** `--max-cases 0` did not merely make grading 5×
   heavier; it collided with a serialisation that 20 cases had made invisible.
2. **Print the per-step cost from step 1, not step 10.** Waiting for step 10 to learn a
   configuration was infeasible meant a ~5-hour wait to discover it. The phase split is worthless
   if it arrives after the budget is spent.

Note the I/O red herring: total bytes through the grader barely moved between 20 cases and all cases
(0.10 GB → 0.11 GB across the band). The cost was execution *count*, not data volume.

### Band provenance: which band files were measured off-template ⚠️

`scripts/filter_corpus.py` originally passed raw strings to `LLM.generate(list[str])`, which tokenizes
them verbatim. Every other stage of the pipeline — `train_grpo.VLLMRollouts.generate` and
`scripts/base_pass_rate.py`, which produced the 0.4604 / 18-of-60 numbers the band is reasoned
against — wraps the prompt in `apply_chat_template`. So the one measurement that *defines the
training set* was the only one taken off an -Instruct model's own template. Its `extract_code` also
required a **closing** ``` fence where the trainer's tolerates a missing one; at `--max-new 640` a
truncated completion therefore scored 0 in the filter and partial credit in training.

Both divergences push the same way: the filter **understates** the policy's pass rate, so problems it
records as in-band may be always-solved under the templated policy — dead from the top, which is the
failure this whole re-band exists to remove.

| band file | model | prompting | status |
|---|---|---|---|
| `data/deepcoder-band.json` | Qwen2.5-Coder-1.5B-Instruct | off-template, strict extractor | superseded |
| `data/deepcoder-band-30b.json` | Qwen3-Coder-30B-A3B-Instruct-AWQ | **off-template, strict extractor** | in use, caveat stands |
| future runs | — | templated, fence-tolerant | after this fix |

The fix is in `filter_corpus.py` now, but `deepcoder-band-30b.json` was produced by the run already in
flight when it was found, so **it carries the caveat**. The two band files stay comparable to each
other (both off-template); what neither is, is a measurement of the policy as the trainer prompts it.
`dead_group_rate` in the G=16 run is the readout that settles how much this cost.

### The grader was spending 24s per call re-importing the trainer ✅ — 2026-09-06

Found while costing the re-filter the section above calls for. Measured on the pod, same grading work,
only the parent's `__main__` changed:

| parent `__main__` | grading wall-clock, 2 calls | implied 2000-problem re-filter |
|---|---|---|
| heavy (imports torch, as `train_grpo.py` does) | 27.5s / 21.8s | **12.1 h** |
| light (no torch) | 1.6s / 1.7s | ~1 h |

`multiprocessing` rebuilds the parent's `__main__` inside every child — `spawn.get_preparation_data`
records `init_main_from_path` and the child runs it through `runpy` before unpickling the target. With
`train_grpo.py` as the parent that is a full torch import **per grading call**. A 60-problem eval spent
~25 minutes on it with the GPU at 0%.

**The first fix was wrong and measured as such.** Switching to `forkserver` with
`set_forkserver_preload([])` looked correct — the default preload really is `['__main__']` — and came
back at **24.3s / 30.1s, i.e. no change**. The preload list governs only the forkserver *server*
process; each `Process.start()` still ships its own preparation data. Confirmed directly on the pod:
start method `forkserver`, preload `[]`, child still reporting **1081 modules with torch among them**.

| variant | grading wall-clock | re-filter |
|---|---|---|
| `spawn`, heavy `__main__` (before) | 24.3s / 30.1s | 16.7 h |
| `forkserver` + empty preload (failed fix) | 24.3s / 30.1s | 16.7 h |
| **empty `__main__` during `start()`** (`_light_main`) | **1.7s / 1.5s** | **0.8 h** |

Three tests pin it, because it fails silently and a green suite said nothing the first time: one against
`get_preparation_data` (what the child actually obeys), one holding the stub module empty, and one
end-to-end that counts how many times a heavy `__main__` executes — it reports `xx` instead of `x` the
moment the fix is removed.

This also retires the `--grade-timeout 60` workaround the 30B run needed. That 60 was never about slow
*answers*; it was a slow *start* being scored as a wrong answer.

### The result: lr=5e-6, 200 steps, deterministic eval ✅

| step | solved_any | solve_rate | `mean_case_fraction` | **`greedy_solved`** | **`greedy_cf`** | kl |
|---|---|---|---|---|---|---|
| 0 | 6/60 | 0.1000 | 0.0944 | **4** | 0.1231 | — |
| 50 | 5/60 | 0.0833 | 0.0906 | **3** | 0.1358 | 0.0010 |
| 100 | 7/60 | 0.1167 | 0.0938 | **3** | 0.1231 | 0.0040 |
| 150 | 6/60 | 0.1000 | 0.0922 | **4** | 0.1342 | 0.0022 |
| 200 | 7/60 | 0.1167 | 0.0882 | **3** | 0.1236 | 0.0033 |

`dead_groups: 51/200` (25.5%), accumulating steadily — no climb toward 1, so the gradient was not
narrowing onto a shrinking handful of prompts. No traceback, no OOM. All five evals fired,
including step 100, which is the direct check on the dead-group `continue` bug that silently
dropped it at 2e-5.

**No measurable transfer.** Total `mean_case_fraction` range across the run is **0.0062** against a
0.0214 threshold. `greedy_solved` runs 4 → 3 → 3 → 4 → 3, ending one *below* baseline;
`greedy_case_fraction` finishes at 0.1236 against 0.1231, a change of +0.0005.

**Why this is a result and not an absence of one.** Two things were established independently
before the curve was read: the eval is deterministic (table above), and the policy genuinely moved
(KL held at 0.001–0.008 for the whole run, against the frozen ~1e-4 of lr=1e-6 and 2e-6). Policy
moved, eval did not. `P3-CORPUS-SCOPE.md` §7 named exactly this as the headline risk and said a
flat curve would be publishable — it is, now that the instrument has been shown able to detect a
change.

**What this does not show.** That GRPO cannot work here. 200 steps on a 1.5B is short, a quarter of
steps contributed no gradient, and the training corpus is general competitive-programming Python
while the eval is ML/DL implementation. The negative result is about *this* recipe at *this* scale.

Interesting secondary observation, only visible because the eval is deterministic: `greedy_solved`
oscillates 4→3→3→4→3 while netting nothing. The policy churns *which* problems it solves without
improving *how many* — a distinction a noisy metric would have hidden entirely.

## Standing constraints

- **FP8 requires cc >= 8.9.** The rented A40 is Ampere (8.6) and cannot do it, so FP8 runs on the
  local Blackwell card (12.0) and the comparison is scoped to that one card. An `l40s x1` Secure
  session at $0.99/hr is the bolt-on if a datacenter FP8 figure is ever wanted.
- **Community Cloud multi-GPU availability varies by provider.** A same-named GPU is not a promise of
  the same interconnect, which is what P0 exists to check.
- **No network volume.** It would pin the datacenter that the phase plan deliberately moves across;
  see `docs/PLAN.md`. Cache models to `/workspace` on a ~100 GB volume disk instead.
