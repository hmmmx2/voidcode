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
| Base pass@1 on held-out | NOT MEASURED | | `make rl-eval` |
| Post-RL pass@1 on held-out | NOT MEASURED | | `make rl-eval` |
| Prompts surviving the 10–90% base-pass filter | NOT MEASURED | | `make rl-eval` |
| Dead-group rate, start and end | NOT MEASURED | | `make rl-eval` |
| KL divergence at convergence | NOT MEASURED | | `make rl-eval` |
| Weight-sync overhead, % of step | NOT MEASURED | | `make rl-eval` |
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
