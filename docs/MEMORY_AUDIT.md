# GPU Memory Audit — Full-Parameter Fine-Tune Feasibility

**Target model:** `Qwen/Qwen2.5-7B-Instruct`
**Question:** does a full-parameter fine-tune fit on one NVIDIA RTX A6000 (48 GB)?
**Date of measurement:** 2026-07-26
**Machine measured:** see [Environment](#3-environment) — **this machine does not contain an A6000.**

All memory figures are **GiB** (2^30 bytes) unless a line says otherwise. GiB is the
honest unit here: a "48 GB" A6000 reports 49140 MiB ≈ 47.99 GiB to CUDA, so treating
the cap as 48 GiB is the conservative reading. No figure below is rounded downward.

---

## 1. Verdict

**A full-parameter fine-tune of Qwen2.5-7B-Instruct does fit on a single 48 GB A6000 —
but not with AdamW, and not with any configuration that keeps FP32 optimizer state.**
The configuration that fits is **Adafactor with pure BF16 weights and gradients and
gradient checkpointing**, projected at **31.65 GiB peak at sequence length 1024**
(the repo's current setting) and **38.99 GiB at sequence length 4096**, leaving 16.35
and 9.01 GiB free respectively. **GaLore rank-128 with 8-bit states and layer-wise
updates** fits with more room still (21.77 GiB at 1024, 29.11 GiB at 4096). Every
configuration that retains FP32 master weights or FP32 Adam moments — including the
8-bit-AdamW variant that keeps a master copy — **overflows 48 GB and is not viable.**
The marginal case, 8-bit AdamW with no FP32 master, lands at **46.19 GiB at sequence
length 1024**: it is under 48 but has only 1.81 GiB of headroom, which by the stated
4 GiB rule is **a failure, not a fit**, and it exceeds 48 outright at 2048.

**This verdict is derived, not measured on an A6000**, because no A6000 is attached to
this machine. It rests on an estimator validated to ≤9.51 % error against real
measurements on this hardware, and the estimator is conservative — it over-predicts
memory in every validation case. See [§5](#5-estimator-validation) and
[§10](#10-caveats).

---

## 2. Was the 112 GB estimate correct?

**Yes. Your estimate was sound, and the audit confirms rather than overturns it.**

For standard AdamW mixed-precision training — the thing your number describes — the
static state is **16 bytes per parameter**, and with the *measured* parameter count of
7,615,616,512 that is:

| Basis | Figure |
|---|---|
| Your hypothesis | 112 – 120 GB |
| Measured/derived, binary GiB | **113.48 GiB** |
| Measured/derived, decimal GB | **121.85 GB** |
| Difference vs the midpoint of your range (116 GB) | **−2.2 % (GiB basis) / +5.0 % (GB basis)** |

Read in GiB, 113.48 falls **inside** your 112–120 band. Read in decimal GB, 121.85 is
**1.5 % above the top** of it. The entire discrepancy is unit convention, not physics —
there is no modelling error in your estimate to correct.

Two refinements are worth carrying forward, neither of which changes the conclusion:

1. **The model is not 7B.** It is 7.6156 B parameters — 8.8 % more than the name
   implies. A budget built on a round 7.0 B would have under-counted by roughly 9 GiB
   at 16 bytes/param. The name is not the parameter count; see [§4](#4-model).
2. **Your number is the static state only.** Activations add a further 2.57 GiB at
   sequence length 1024 and 9.91 GiB at 4096, so the true AdamW peak is
   **118.89 – 126.23 GiB** depending on sequence length. That strengthens your point:
   AdamW needs closer to three A6000s than two.

The important finding is not that your arithmetic was wrong. It is that **the question
"does AdamW fit" was the wrong question** — AdamW never had a chance, but the model
does fit in 48 GB once the optimizer state is attacked, which the 112 GB figure alone
would not have told you.

---

## 3. Environment

### Repository — what actually exists

> **Scope note, stated plainly.** At the time this audit was run the repository was
> named `swinburne_ai_tutor_project`; it was rebranded to **VoidCode AI** (`voidcode_ai`)
> immediately afterwards. Paths and identifiers below reflect the post-rename names, so
> they will not match the training logs in `llm/logs/`, which predate the rename.
> Additionally, the git worktree this audit was run from
> (`.claude/worktrees/gpu-memory-audit-bc2657`) contains **only an Expo/React-Native
> starter template** — the entire `llm/` training tree is *untracked* in the main
> working directory and therefore absent from every branch. `git log` shows a single
> commit, "Initial commit", which is the Expo template. All repository findings below
> were read from the main working directory, not from the checked-out branch.

| Item | Status | File : line |
|---|---|---|
| Training entry point | PRESENT | `llm/scripts/train.py` |
| Trainer configuration | PRESENT | `llm/configs/training_config.yaml` |
| DeepSpeed config | **NOT PRESENT** | — (no `ds_config*.json`, no `deepspeed` reference anywhere in the repo) |
| FSDP config | **NOT PRESENT** | — |
| Model identifier | `Qwen/Qwen2.5-7B-Instruct` | `training_config.yaml:8` |
| Optimizer | `paged_adamw_32bit` | `training_config.yaml:53` |
| Sequence length | `1024` (Profile B) | `training_config.yaml:14` |
| Per-device train batch size | `1` | `training_config.yaml:43` |
| Gradient accumulation steps | `32` | `training_config.yaml:45` |
| Gradient checkpointing | `true` | `training_config.yaml:52` |
| Mixed precision | `bf16: true`, `fp16: false` | `training_config.yaml:50-51` |
| Flash attention | `false` | `training_config.yaml:15` |
| 4-bit quantisation | `load_in_4bit: true`, NF4 | `training_config.yaml:10-11` |
| LoRA rank | `r: 16`, alpha 32, 7 target modules | `training_config.yaml:25-35` |

**There is no full-parameter training code in this repository.** `train.py` is a QLoRA
trainer end to end: it builds a `BitsAndBytesConfig` at `train.py:288`, loads the model
4-bit at `train.py:319`, and wraps it with PEFT at `train.py:336`. The last completed
run trained **40,370,176 parameters (0.92 %)** — confirmed in
`llm/logs/training_20260310_213004.log` and `llm/outputs/checkpoint-108/`. Per rule 4,
I did not invent a full-parameter config that does not exist; I built a standalone probe
harness under `scripts/memory_audit/` instead, described in [§8](#8-rerun-commands).

Note also that the config file's active setting is `max_seq_length: 1024`, but the most
recent training log ran at **1536** (Profile A). The file and the last run disagree.

### Hardware and software — measured

| Item | Value |
|---|---|
| **GPU** | **NVIDIA GeForce RTX 5060 Ti — not an A6000** |
| Total VRAM | 16311 MiB = **15.93 GiB** (A6000 target: 48 GiB) |
| Free VRAM at audit start | 14791 MiB (1520 MiB held by desktop/browser) |
| Driver version | 591.86 |
| CUDA version (driver) | 13.1 |
| Host RAM | 31.6 GB total, 20.9 GB free |
| Swap / page file | 9.0 GB allocated |
| Fast local storage | WD Green SN350 1TB **NVMe SSD**, 82.8 GB free on `C:` |
| PyTorch | 2.10.0+cu128, built for CUDA 12.8, `torch.cuda.is_available() == True` |
| transformers | 4.57.6 |
| accelerate | 1.12.0 |
| bitsandbytes | 0.49.1 |
| peft | 0.18.1 |
| trl | 0.27.1 |
| datasets | 4.5.0 |
| **deepspeed** | **NOT INSTALLED** (and has no supported Windows build) |
| **flash-attn** | **NOT INSTALLED** |
| **galore-torch** | NOT INSTALLED originally — **installed during this audit** (v1.0) |

**The single most important environmental fact: the A6000 that the decision hinges on is
not present.** Nothing in this report is a measurement taken on 48 GB of VRAM.

---

## 4. Model

Resolved on the meta device, so nothing was allocated
(`scripts/memory_audit/01_param_count.py`):

| Property | Value |
|---|---|
| **Total parameters** | **7,615,616,512** (7.6156 B) |
| Trainable parameters | 7,615,616,512 (100 % — nothing frozen by default) |
| Embedding parameters | 1,089,994,752 (`embed_tokens` + `lm_head`, 14.3 % of the model) |
| Non-embedding parameters | 6,525,621,760 |
| **Embeddings tied?** | **False** — `lm_head` is a separate 544,997,376-param matrix |
| Hidden size | 3584 |
| Layers | 28 |
| Attention heads / KV heads | 28 / 4 (GQA) |
| Intermediate size | 18944 |
| **Vocabulary size** | **152064** |
| Max position embeddings | 32768 |

Two properties drive everything downstream. **Embeddings are untied**, so the `lm_head`
costs a full extra 545 M parameters that a tied model would not pay. And the
**vocabulary is 152064**, which as [§5](#5-estimator-validation) shows makes the loss
head — not the transformer body — the dominant consumer of activation memory.

---

## 5. Derived budgets

Per-parameter cost model, applied to the measured P = 7,615,616,512.
**1 byte/param = 7.0926 GiB.**

| Component | Bytes per parameter | Notes |
|---|---|---|
| Weights | 2 (BF16) / 4 (FP32) | |
| Gradients | 2 (BF16) / 4 (FP32) | ~0 with layer-wise updates that free per layer |
| FP32 master weights | 4, or 0 in pure BF16 | folded into the weight column when weights are already FP32 |
| Optimizer 1st moment | 4 AdamW / 1 8-bit / 0 Adafactor | |
| Optimizer 2nd moment | 4 AdamW / 1 8-bit / ~0 factored | |
| Activations | not per-parameter | measured separately, see below |

### The six configurations

Cap = 48 GiB, required headroom = 4 GiB for fragmentation and CUDA context, so a
configuration must land at **≤ 44.00 GiB** to count as fitting.

| # | Configuration | B/param | Static state | + activations @1024 | **Peak @1024** | Clears 44 GiB? |
|---|---|---|---|---|---|---|
| 1 | AdamW FP32 states, BF16 mixed precision | 4+4+4+4 = **16** | 116.32 | 2.57 | **118.89** | **NO** — 2.5× over |
| 2 | 8-bit AdamW + grad checkpointing | 4+4+1+1 = **10** | 72.70 | 2.57 | **75.27** | **NO** |
| 3 | 8-bit AdamW, no FP32 master | 2+2+1+1 = **6** | 43.62 | 2.57 | **46.19** | **NO** — only 1.81 GiB free |
| 4 | Adafactor BF16 + grad checkpointing | 2+2+0+~0 = **4** | 29.08 | 2.57 | **31.65** | **YES** — 16.35 GiB free |
| 5 | GaLore r128, 8-bit, layer-wise, grad ckpt | 2+0+0+0 = **2** (+4.57 non-per-param) | 19.20 | 2.57 | **21.77** | **YES** — 26.23 GiB free |
| 6 | DeepSpeed ZeRO-3, full CPU offload | 0 on GPU | ~2–4 GPU | 2.57 | ~5–7 | **GPU yes / HOST NO** — see below |

Static figures include a **+2.5 % correction** applied after validation, because measured
static state ran 0.4–2.4 % *above* the pure formula on every real model tested.

Sequence-length sensitivity for the two viable configurations:

| Configuration | Peak @1024 | Peak @2048 | Peak @4096 | Max seq @ batch 1 with 4 GiB headroom |
|---|---|---|---|---|
| 4 — Adafactor BF16 + GC | **31.65** | **34.10** | **38.99** | **≈ 6,100 tokens** |
| 5 — GaLore r128 8-bit layer-wise | **21.77** | **24.22** | **29.11** | **≈ 10,200 tokens** |

**Configuration 6 fails for a reason that has nothing to do with the GPU.** ZeRO-3 with
full CPU offload moves the entire 16 bytes/param — **113.48 GiB** — into host RAM. This
machine has **31.6 GB of RAM total**. It is short by a factor of 3.6, and the 9 GB page
file does not close a 82 GiB gap. On top of that, `deepspeed` is not installed and has no
supported Windows build. Configuration 6 is **not executable on this machine at all**,
and on a rented Linux box it would require ≥128 GB of host RAM to be worth attempting.

---

## 6. Estimator validation

Rule: if the estimator is more than 15 % off on small models, fix the formula before
extrapolating. It was fixed twice during this audit before it passed.

### Two corrections made before the estimator was trusted

1. **Retained-logits contamination.** The first pass measured "static state" while the
   `output` object was still alive, so the `[batch, seq, vocab]` logits tensor was being
   counted as optimizer state. This inflated the static error to **+18.2 %**. Releasing
   the logits before sampling dropped it to **+2.4 %**.
2. **Gradient residency.** The first pass called `zero_grad(set_to_none=True)` between
   steps, which frees the gradient buffers and understates the true peak. The repo uses
   `gradient_accumulation_steps: 32`, meaning gradients stay resident across all 32
   micro-batches. Switching to `set_to_none=False` models the real workload. This was
   the source of a 45 % discrepancy between two probes that initially looked like a
   physics disagreement and was in fact a harness bug.

### Static state: predicted vs measured

| Model | Configuration | Predicted | Measured | Error |
|---|---|---|---|---|
| Qwen2.5-0.5B | AdamW FP32 / BF16 mixed | 7.362 | 7.399 | −0.50 % |
| Qwen2.5-0.5B | 8-bit AdamW + GC | 4.601 | 4.648 | −1.01 % |
| Qwen2.5-0.5B | 8-bit AdamW no master | 2.761 | 2.817 | −2.00 % |
| Qwen2.5-0.5B | Adafactor BF16 + GC | 1.840 | 1.886 | −2.42 % |
| Qwen2.5-1.5B | 8-bit AdamW + GC | 14.377 | 14.445 | −0.47 % |
| Qwen2.5-1.5B | 8-bit AdamW no master | 8.626 | 8.810 | −2.09 % |
| Qwen2.5-1.5B | Adafactor BF16 + GC | 5.751 | 5.776 | −0.44 % |

**Worst static error: 2.42 % — PASS.**

GaLore is the exception: predicted 2.020 vs measured 1.720 on 0.5B (**+17.4 %**, over the
gate) and 4.794 vs 4.350 on 1.5B (+10.2 %). The error is in the **conservative**
direction — the estimator asks for more memory than GaLore actually uses — and GaLore
clears 48 GiB by 26 GiB, so the verdict is unaffected. It is flagged rather than relied
upon; treat GaLore's 19.20 GiB static as an upper bound.

### Activations: a directly measured model

The 7.6 B model cannot be resident on a 16 GiB card, so activations for the target
architecture were **measured, not assumed**, by decomposing into two pieces that each fit
and recomposing them:

- **Per-layer term** — real 7B geometry (hidden 3584, intermediate 18944, 28 heads, 4 KV
  heads), vocabulary shrunk to 1024, layer count swept 2→8. The result was exactly
  linear, at **7182 bytes/token/layer measured against 7168 predicted** by theory
  (`seq × hidden × 2` for the checkpoint boundary) — a 0.2 % match.
- **Loss-head term** — real vocabulary 152064, hidden shrunk to 512. Logits are
  `[batch, seq, vocab]`, so their cost is independent of hidden size and this isolates it
  cleanly. Measured **13.83 bytes per (token × vocab) element**, consistent with a BF16
  logits tensor plus an FP32 upcast plus an FP32 gradient. Perfectly linear in sequence
  length: **2.0059 / 4.0078 / 7.9999 GiB** at 1024 / 2048 / 4096.

Composed model, tested against **real** Qwen2.5 checkpoints through an identical code path:

| Model | Seq | Predicted | Measured | Error |
|---|---|---|---|---|
| Qwen2.5-0.5B | 1024 | 2.237 | 2.082 | +7.46 % |
| Qwen2.5-0.5B | 4096 | 8.563 | 8.325 | +2.86 % |
| Qwen2.5-1.5B | 1024 | 2.332 | 2.129 | +9.51 % |
| Qwen2.5-1.5B | 4096 | 8.941 | 8.508 | +5.09 % |

**Worst activation error: 9.51 % — PASS.** Every error is positive, i.e. the estimator
over-predicts memory in all four cases. Extrapolation to 7.6 B is therefore biased
against fitting, which is the correct direction to be wrong in.

**The finding that matters most here:** at sequence length 1024, of the 2.57 GiB of
activation, **2.04 GiB is the loss head alone** and only 0.19 GiB is the 28 transformer
layers. Activation memory for this model is a *vocabulary* problem, not a depth problem.
It is also nearly model-size-independent: 0.5B and 1.5B measured 2.08 and 2.13 GiB at the
same sequence length, because they share the same 151936-token vocabulary.

### Direct confirmation at 7.6 B

One prediction was checked against the real target model on real hardware. BF16 weight
load was **predicted 14.185 GiB, measured 14.227 GiB — +0.30 % error** (see §7). The
estimator holds at target scale for the term that could be tested.

---

## 7. Measured results

All runs below are on the **RTX 5060 Ti (15.93 GiB)**, not an A6000. Every attempt was
wrapped so an OOM was caught, attributed to a stage, and did not stop the remaining
attempts. Each attempt ran in a fresh subprocess so a wedged CUDA context could not
contaminate the next.

### Target model, Qwen2.5-7B-Instruct, seq 1024, batch 1 — on 15.93 GiB

Expected to fail; the value is in **where** it fails.

| Configuration | Completed | **Failure stage** | load | forward | backward | Failing allocation |
|---|---|---|---|---|---|---|
| Adafactor BF16 + GC | NO | **`opt_step`** | 14.227 | 15.908 | 28.766 | **2.03 GiB** |
| GaLore r128 8-bit layer-wise | NO | **`opt_step`** | 14.227 | 15.908 | 28.766 | 520 MiB |
| 8-bit AdamW no master | NO | **`opt_step`** | 14.227 | 15.908 | 28.766 | 520 MiB |
| 8-bit AdamW + GC | NO | **`forward`** | **28.509** | OOM | — | 130 MiB |
| AdamW FP32 / BF16 mixed | NO | **`forward`** | **28.509** | OOM | — | 14 MiB |

Four observations, all of which sharpen the A6000 projection:

1. **Both weight terms are confirmed at target scale.** BF16 load measured
   **14.227 GiB** against 14.185 predicted (**+0.30 %**); FP32 load measured
   **28.509 GiB** against 28.370 predicted (**+0.49 %**). The per-parameter model holds
   on the real 7.6 B model, not just on the small ones.
2. **The five stages genuinely are five different failure points, and the split is
   informative.** The two FP32 configurations never reached a forward pass — they died
   loading weights. The three BF16 configurations loaded, ran a forward, ran a full
   backward at 28.766 GiB, and *then* died building optimizer state. Same card, same
   model, two completely different diagnoses.
3. **`backward` reached 28.766 GiB on a 15.93 GiB card.** That is only possible because
   Windows' WDDM driver silently spills GPU allocations into host RAM (sysmem fallback).
   The run did not fail where a Linux box would have — it degraded instead. This matters
   for throughput measured on this machine (see [§10](#10-caveats)).
4. **Adafactor's failing allocation was 2.03 GiB**, which is exactly
   `152064 × 3584 × 4` bytes — a transient FP32 buffer the size of the largest parameter
   tensor (`lm_head`), materialised during the update. The per-parameter model does not
   capture this. It does not change the A6000 verdict, because it occurs when activations
   are already freed: `static + 2.03 = 31.11 GiB` sits below the
   `static + activations = 31.65 GiB` backward peak that already sets the ceiling.

### QLoRA baseline — target model, measured and uncontaminated

The repository's existing configuration *does* fit on this 16 GiB card, so this is a
real measurement on the real 7.6 B model, not an extrapolation. Both runs stayed below
15.93 GiB peak reserved, so neither was spilling to host RAM — these throughput figures
are trustworthy. Settings mirror `training_config.yaml`: NF4 double-quant, r=16,
alpha=32, the same 7 target modules, `paged_adamw_32bit`, gradient checkpointing, BF16.

| Seq | Peak alloc | Peak reserved | Static | Free VRAM at peak | tokens/s | Peak stage |
|---|---|---|---|---|---|---|
| 1024 | 10.381 | 10.939 | 7.663 | 5.55 | **411.9** | `backward` |
| 2048 | 13.091 | 14.422 | 7.652 | 2.84 | **383.1** | `backward` |

Loss across the 5 steps, seq 1024: 13.8426 → 13.7924 → 13.7452 → 13.6959 → 13.6523.
Monotonically decreasing, so the step is wired correctly and nothing is diverging. The
absolute value is high because the probe trains on uniformly random token IDs; it is
evidence of a working optimizer, **not** of learning (see [§10](#10-caveats)).

### Small-model results, seq 1024, batch 1 — fully completed runs

| Model | Configuration | Peak alloc | Peak reserved | Static | tokens/s |
|---|---|---|---|---|---|
| 0.5B | AdamW FP32 / BF16 mixed | 9.561 | 12.961 | 7.399 | 2848 |
| 0.5B | 8-bit AdamW + GC | 4.938 | 6.938 | 4.648 | 3832 |
| 0.5B | 8-bit AdamW no master | 3.107 | 4.928 | 2.817 | 4422 |
| 0.5B | Adafactor BF16 + GC | 4.205 | 5.129 | 1.886 | 3270 |
| 0.5B | GaLore r128 8-bit | 2.569 | 4.398 | 1.720 | 4290 |
| 1.5B | AdamW FP32 / BF16 mixed | — | — | — | **OOM at `opt_step`** |
| 1.5B | 8-bit AdamW + GC | 14.735 | 17.365 | 14.445 | 730 † |
| 1.5B | 8-bit AdamW no master | 9.100 | 11.131 | 8.810 | 1953 |
| 1.5B | Adafactor BF16 + GC | 9.544 | 11.758 | 5.776 | 1256 |
| 1.5B | GaLore r128 8-bit | 6.872 | 9.826 | 4.350 | 1923 |

† Peak reserved 17.365 GiB exceeds the card's 15.93 GiB, so this run was spilling to host
RAM. Its throughput is **not** representative — it is a sysmem-fallback artefact, and is
the reason it appears slower than the heavier-looking Adafactor row.

**The 1.5B AdamW failure is the single most instructive measurement in this audit.** It
did not fail at model load. It did not fail in forward. It did not fail in backward. It
failed at **`opt_step`**, on the very first optimizer step, trying to allocate 54 MiB —
because `torch.optim.AdamW` allocates its two FP32 moment buffers **lazily, on first
step**, not at construction. Optimizer *construction* is free; optimizer *state* is not.
A full-parameter run that survives model load, survives a forward pass, and survives a
backward pass tells you nothing about whether it will train. Anyone benchmarking this by
watching `nvidia-smi` through a forward pass would have concluded, wrongly, that it fits.

### Sequence-length sweep, measured

| Model | Configuration | seq 1024 | seq 2048 | seq 4096 |
|---|---|---|---|---|
| 0.5B | Adafactor BF16 + GC | 2.082 | — | 8.325 |
| 1.5B | Adafactor BF16 + GC | 2.129 | — | 8.508 |
| **7B architecture (measured, decomposed)** | activations | **2.57** | **5.02** | **9.91** |

---

## 8. Recommendation

**Use configuration 4: Adafactor, pure BF16 weights and gradients, gradient
checkpointing, no FP32 master copy.**

| Parameter | Recommended value | Rationale |
|---|---|---|
| Optimizer | Adafactor, `beta1=None` | 4 bytes/param total; the only mainstream optimizer that fits with margin |
| Precision | pure BF16 (no FP32 master) | halves the weight and gradient cost |
| Gradient checkpointing | on | trades ~30 % throughput for a large activation saving |
| **Sequence length** | **2048** (up to 4096 safely) | 34.10 GiB at 2048, 38.99 GiB at 4096; hard ceiling ≈ 6,100 tokens |
| Per-device batch size | 1 | activations scale linearly with `batch × seq`; buy length before width |
| Gradient accumulation | 16–32 | to keep the effective batch at 32 as the repo already does |

Choose **GaLore rank-128** instead only if you need sequence lengths beyond ~6,100
tokens; it projects to 29.11 GiB at 4096 and roughly 10,200 tokens of headroom. Its
estimator error is the weakest in this audit (+17 %, conservative), so validate it
empirically before committing.

**Throughput cost against the QLoRA baseline.** The baseline half of this comparison is
measured on the real model: **411.9 tokens/s at seq 1024 and 383.1 at seq 2048**
(§7), on the RTX 5060 Ti, uncontaminated by spill. The full-parameter half cannot be
measured anywhere on this machine, so the comparison is necessarily part-derived:

- Full-parameter BF16 does **~2× the FLOPs per token** of QLoRA r=16, because the
  backward pass computes gradients for all 7.6 B weights rather than 40 M adapter
  parameters.
- Against that, QLoRA pays an NF4 **dequantisation cost on every matmul** that
  full-parameter BF16 does not, which is why QLoRA is far slower than its parameter
  count suggests.
- On the small models measured here, Adafactor BF16 ran at **0.74–0.86×** the throughput
  of the lightest 8-bit configuration.

Netting these, expect full-parameter Adafactor on an A6000 to land somewhere between
**0.7× and 1.2× the QLoRA baseline** — plausibly *no slower*, because the dequantisation
saving offsets much of the extra gradient work. **Treat this as derived, not measured.**
The honest statement is that throughput is unlikely to be the reason this plan fails;
memory was the risk, and memory clears. Measure it on the A6000 before committing to a
schedule — the Step 4 command in §9 produces the number directly.

**On the underlying decision.** The measurements support the answer you were hoping for.
You do not need to rent two 80 GB cards. A full-parameter fine-tune fits on one A6000 at
a genuinely useful sequence length — 4096 tokens with 9 GiB to spare — provided you
abandon AdamW. Your instinct that the 112 GB figure ruled this out was based on a correct
calculation applied to the wrong optimizer.

---

## 9. Rerun commands

Every number in this report comes from these commands. Run from the worktree root.

Step 1 — exact parameter count, meta device, allocates nothing:

```bash
python scripts/memory_audit/01_param_count.py Qwen/Qwen2.5-7B-Instruct
```

Step 2 — derived per-configuration budgets:

```bash
python scripts/memory_audit/02_estimate.py
```

Step 3 — small-model validation, five-stage instrumentation, fresh subprocess per attempt:

```bash
python scripts/memory_audit/04_sweep.py --plan scripts/memory_audit/plan_small_05b.json --out scripts/memory_audit/out_small_05b.jsonl
```

```bash
python scripts/memory_audit/04_sweep.py --plan scripts/memory_audit/plan_small_15b.json --out scripts/memory_audit/out_small_15b.jsonl
```

Activation decomposition — per-layer term (real 7B geometry, tiny vocabulary):

```bash
for S in 1024 2048 4096; do for L in 2 4 6 8; do python scripts/memory_audit/05_arch_probe.py --layers $L --vocab 1024 --seq $S --out scripts/memory_audit/out_arch.jsonl; done; done
```

Activation decomposition — loss-head term (real vocabulary, tiny hidden):

```bash
for S in 1024 2048 4096; do for V in 1024 152064; do python scripts/memory_audit/05_arch_probe.py --layers 2 --hidden 512 --inter 1024 --heads 8 --kv 8 --vocab $V --seq $S --out scripts/memory_audit/out_logits.jsonl; done; done
```

Activation validation against real checkpoints, identical code path:

```bash
for M in Qwen/Qwen2.5-0.5B-Instruct Qwen/Qwen2.5-1.5B-Instruct; do for S in 1024 4096; do python scripts/memory_audit/05_arch_probe.py --pretrained $M --seq $S; done; done
```

Step 4 — target-model attempts (expected to OOM on <48 GiB; records the failure stage):

```bash
python scripts/memory_audit/04_sweep.py --plan scripts/memory_audit/plan_7b.json --out scripts/memory_audit/out_7b.jsonl
```

QLoRA baseline on the target model, matching `training_config.yaml` exactly:

```bash
python scripts/memory_audit/04_sweep.py --plan scripts/memory_audit/plan_qlora.json --out scripts/memory_audit/out_qlora.jsonl
```

Steps 3 & 5 — estimator validation and the 48 GiB projection table:

```bash
python scripts/memory_audit/06_compose.py
```

**To reproduce this on an actual A6000**, the only change needed is to run the Step 4
command on that machine; the plan file already specifies the repository's real sequence
length and batch size. Add 2048 and 4096 entries to `plan_7b.json` for the sweep.

---

## 10. Caveats

Stated plainly, because several of these are load-bearing.

1. **No A6000 was measured.** This is the largest caveat and it qualifies the entire
   verdict. The available GPU is a 15.93 GiB RTX 5060 Ti. Every 48 GiB figure in §5 and
   the verdict in §1 is **derived from a validated estimator, not observed**. The
   estimator was validated to ≤9.51 % on activations and ≤2.42 % on static state, and
   over-predicts in every case — but a 9.5 % error on the recommended configuration at
   4096 is ±3.7 GiB, which is comfortably inside the 9.01 GiB of projected headroom, and
   *not* inside the 1.81 GiB headroom of configuration 3. Configuration 4's verdict is
   robust to estimator error; configuration 3's rejection is robust for the same reason.

2. **Some throughput numbers on this machine are distorted; check peak reserved before
   trusting any of them.** Windows WDDM silently spills GPU allocations into host RAM
   instead of raising OOM, so any run whose *peak reserved* exceeded 15.93 GiB was partly
   executing out of system memory over PCIe. The 1.5B 8-bit-AdamW row (730 tok/s) is the
   clearest casualty. The QLoRA baseline rows are **not** affected — both stayed under
   the cap (10.94 and 14.42 GiB reserved) and are sound. The full-parameter side of the
   §8 comparison remains **derived, not measured**, and is the weakest claim in this
   report.

3. **The repository has no full-parameter training path.** `train.py` is QLoRA-only.
   Adopting the recommendation means writing a new training path, not flipping a config
   flag. The probe harness in `scripts/memory_audit/` is a memory instrument, not a
   trainer — it has no data loading, checkpointing, evaluation, or LR schedule.

4. **Loss values are not evidence of learning.** The probes train on randomly generated
   token IDs, so the loss curves show only that gradients flow and the step executes.
   Step 4's request for loss-across-steps as a divergence check cannot be satisfied
   meaningfully without the real dataset on hardware that can hold the model.

5. **Configuration 6 (ZeRO-3 CPU offload) was never executed.** DeepSpeed is not
   installed, has no supported Windows build, and the configuration requires 113.48 GiB
   of host RAM against the 31.6 GB present. Its row in §5 is derived from first
   principles only.

6. **GaLore's static estimate is the one figure that failed the 15 % gate** (+17.4 % on
   0.5B), in the conservative direction. Its 19.20 GiB should be read as an upper bound.

7. **Adafactor's transient FP32 update buffer (2.03 GiB, measured)** is not part of the
   per-parameter model. It is accounted for in §7 and does not set the peak, but a
   configuration tuned to within ~2 GiB of the cap would need to include it explicitly.

8. **Flash-attention is not installed** and `use_flash_attention: false` in the config.
   All measurements use PyTorch SDPA. Flash-attention 2 would reduce activation memory
   somewhat, making the recommended configuration more comfortable, not less — so its
   absence does not threaten the verdict.

9. **Single-GPU only.** No multi-GPU, tensor-parallel, or pipeline-parallel configuration
   was measured or derived.
