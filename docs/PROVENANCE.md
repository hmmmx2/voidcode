# VoidCode — verified fact brief

**This document is self-contained.** Every figure below is stated in full, with the raw per-run data
where the arithmetic matters, and every term is defined. You do not need to open any file to use it.
Repo paths are given as attribution and traceability only.

**Compiled** 2026-09-13, by reading the stored artifacts directly rather than the summary documents
that describe them. That distinction matters: one of the stored summary blocks disagreed with its
own underlying records, and reading the summary produced a confident wrong conclusion.

**Why it exists.** A figure was repeated with a run count that belonged to one metric and a
confidence interval that belonged to another. Both halves were real numbers from the same document,
and the resulting sentence was false. Every table here therefore keeps a value, its denominator and
its interval in the same row.

**The rule.** A number is repeatable only with the qualifier in its row. A value separated from its
artifact, its run count, or its interval scale is not a weaker claim — it is a different one.

---

## Contents

1. [What VoidCode is](#1-what-voidcode-is)
2. [Glossary — read this before the numbers](#2-glossary--read-this-before-the-numbers)
3. [Models — four of them, and which numbers belong to which](#3-models--four-of-them-and-which-numbers-belong-to-which)
4. [Hardware](#4-hardware)
5. [Serving](#5-serving)
6. [Fine-tuning](#6-fine-tuning)
7. [Evaluation numbers](#7-evaluation-numbers)
8. [Data pipeline and recommender](#8-data-pipeline-and-recommender)
9. [Infrastructure](#9-infrastructure)
10. [Safe to quote — the short list](#10-safe-to-quote--the-short-list)
11. [Welded numbers — pairs that must never be combined](#11-welded-numbers--pairs-that-must-never-be-combined)
12. [Retracted or superseded, with corrected values](#12-retracted-or-superseded-with-corrected-values)
13. [Permanently unverifiable](#13-permanently-unverifiable)
14. [Unresolved internal conflicts](#14-unresolved-internal-conflicts)
15. [How 0.813 reproduces, worked in full](#15-how-0813-reproduces-worked-in-full)

---

## 1. What VoidCode is

An ML/AI interview-preparation platform. Four largely independent pieces of engineering, each with
its own measurements — which is the root cause of most of the number confusion, because the pieces
use different models on different hardware and their figures are not comparable:

1. **An AI tutor** that helps a learner debug their own code *without* handing over the solution.
   FastAPI backend, streaming responses, a deterministic mode pre-classifier (debug / teaching /
   explain / empathy / followup), and an output guard that strips a solution from the response if
   the model produces one anyway.
2. **A recommender** — a two-stage system (candidate generation, then a LightGBM LambdaMART
   re-ranker) that orders practice problems for a learner, trained on Codeforces public submission
   data processed through Spark.
3. **A code-execution sandbox** — Judge0 CE, self-hosted, for running learner submissions against
   hidden test cases.
4. **RL training work** — GRPO (a reinforcement-learning method) applied to a 30B code model, with
   verifiable rewards from test-case execution.

There is also a supervised fine-tune of a 7B model for the tutor's behaviour, and a desktop
application. **The platform has zero real learner submissions**; all recommender data is Codeforces
public data.

---

## 2. Glossary — read this before the numbers

Without these, several figures look contradictory when they are not.

**Scoring surfaces.** The tutor emits two things: *reasoning / diagnosis* (withheld from the
learner) and an *answer* (shown to the learner). A check can be scored against either text, and
which one it reads changes the result enormously.

- **Diagnostic surface** — scored against the text where the tutor states its diagnosis.
- **Answer surface** (also called the *hint surface* for this check) — scored against the
  learner-visible text. The debug prompt **deliberately withholds line numbers from the answer**, so
  scoring bug-localisation here penalises the model for obeying the disclosure policy.

This is why localisation reads **0.813 on the diagnostic surface** and **0.150 on the hint surface**.
Both are correct; the low one is the withholding policy working, and it is explicitly *not* a gate.

**Disclosure ladder.** A 0–4 scale for how much of the solution a response reveals, 4 being a
complete usable answer. Two gates use it: the *opening* message should sit at level 0, and the
reasoning should *never* reach level 4. Reported as pass rates, so "never reaches level 4 = 0.782"
and "reaches level 4 = 0.218" are complements of one measurement, not two findings.

**`mean_case_fraction`** — the fraction of hidden test cases a generated solution passes, averaged
across problems. This is the RL reward signal and the RL evaluation metric.

**GRPO (Group Relative Policy Optimization)** — an RL method that samples G completions per problem
and normalises reward *within the group*, instead of training a separate value network.

**Dead group** — a GRPO group where every completion receives an identical reward. The advantage is
zero, so the group contributes no gradient. A high dead-group fraction means most compute is wasted.

**Band filtering** — selecting training problems whose base pass rate falls inside a band (here
10–90%). Problems the model always solves or never solves produce dead groups, so filtering to the
band is what makes the training signal exist at all.

**NDCG@10 / Recall@100** — standard ranking metrics. NDCG@10 rewards putting relevant items high in
the top ten; Recall@100 is the share of relevant items appearing anywhere in the top hundred.

**Rasch 1PL** — a one-parameter item-response model estimating problem difficulty and learner
ability from pass/fail outcomes.

**QLoRA** — fine-tuning a low-rank adapter on top of a base model held in 4-bit quantisation, so a
large model trains on a small card. **NF4** is the 4-bit format used.

**Two interval scales, and they are not interchangeable.** Where a figure is a mean over repeated
runs of a *fixed* scenario set, two different intervals answer two different questions:

- **Run-to-run** — a t interval on the per-run means. Bounds the mean *on these fixed scenarios*.
  This is rerun stability: "if I run it again, what do I get?"
- **Per-scenario** — a Wilson interval at the scenario count. Bounds *generalisation to new
  scenarios*: "if I tested different problems, what would I get?" This is the wider, more honest
  one.

A Wilson interval computed over runs × scenarios *pooled together* is **neither**, and is the
mistake to avoid. Nine runs of one 51-scenario set are not 459 independent trials, so pooling
reports a confidence the data has not earned. For the localisation figure it computes to
`[0.774, 0.846]` — close enough to the correct run-to-run interval to look like agreement, while
being a different claim.

---

## 3. Models — four of them, and which numbers belong to which

| Role | Model | Size / notes |
|---|---|---|
| **What every tutor evaluation number measures** | **`Qwen/Qwen3.5-9B`, stock, no adapter** | Snapshot `c202236235762e1c871ad0ccb60c8ee5ba337b9a`. Off-the-shelf. **No fine-tuning of any kind applied.** |
| Supervised fine-tune base (the 7B tutor) | `Qwen/Qwen2.5-7B-Instruct` | QLoRA adapter trained on it; merged and quantised for serving |
| GRPO / RL policy base (the 30B) | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | Mixture-of-Experts: ~30B total parameters, ~3B active per token |
| 30B serving and rollout generation | `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` | A **third-party** AWQ quantisation. Not produced in this project |
| First (smaller) GRPO policy | `Qwen/Qwen2.5-Coder-1.5B-Instruct` | Used to establish the method before the 30B run |

*Attribution: `docs/READINESS.md:240`; `llm/configs/training_config.yaml:8`; `artifacts/*/adapter_config.json`; `scripts/pod_serve_rl.sh:30`; `scripts/train_grpo.py:772`.*

> ### The single largest hazard in this brief
>
> The tutor evaluation's own provenance record states: **stock `Qwen/Qwen3.5-9B`, no adapter**,
> served by SGLang in fp8, on a **local RTX 5060 Ti with 16 GB**.
>
> So the tutor gates — including the 0.813 headline — measure the **prompt, routing, and withholding
> layer** wrapped around an off-the-shelf model. They are a measurement of the scaffold. **Nothing
> in the tutor evaluation measures the 30B, the GRPO policy, or the QLoRA fine-tune.**
>
> The tutor figures and the RL figures must never appear in one series or one sentence. Any claim
> that 0.813 reflects a trained model is false.

---

## 4. Hardware

Everything in this project was measured on exactly two GPUs.

| Fact | Value |
|---|---|
| Cloud GPU used | **NVIDIA A40**, 46,068 MiB reported total, driver 570.195.03 |
| A40 **usable** VRAM, measured | **44.43 GiB, not the nominal 48** |
| Local GPU | **NVIDIA RTX 5060 Ti**, 16,311 MiB = **15.93 GiB**, Blackwell architecture, Windows WDDM driver model, driver 591.86 |
| Cloud provider | **RunPod, and only RunPod.** Pods used: `z6h0zfdo3wd7nc` (2×A40), `idh7wv10e4vqk2` (4×A40 — later flagged faulty by RunPod itself) |
| A40 compute, measured | bf16 matmul at 8192², sustained: **106.05 and 107.33 TFLOP/s** across two pods |
| Local card FP8, measured | **97.4 TFLOP/s** e4m3 via `torch._scaled_mm`, versus **48.5 TFLOP/s** BF16 — a **2.01×** speedup. FP8 relative error vs fp32: 0.0377 |
| Multi-GPU interconnect | **7.72 GB/s** all-reduce bus bandwidth over shared memory |
| Host | Windows 11 Pro, 31.6 GB RAM, PCIe running at 8 lanes of a possible 16, single card so no NVLink |

*Attribution: `docs/rl/probe-a40_x2_secure.json`, `probe-a40_x4_secure.json`, `probe-rtx5060ti_x1_local.json`; `docs/rl/METRICS.md:316`; `docs/rl/DECISIONS.md:475-479`, `:311-323`; `docs/DECISIONS.md:15-45`.*

**A standing project policy that constrains how these may be used.** The local RTX 5060 Ti is
designated for correctness, kernel work and iteration, and is **"never a reported number."** Only
L40S-class hardware was designated for comparison tables. This matters because the most impressive
throughput figure in the project was measured on the local card.

**Never measured — do not claim any of these:** RTX A6000, A100, H100, L40, L40S, RTX 6000 Ada.
They appear only in a RunPod price-comparison table. The memory-audit document states it outright:
*"No A6000 was measured"* — every 48 GiB figure there is derived from a validated estimator, not
observed. **Not present in the project at all:** Lambda Labs, Vast.ai, CoreWeave, Paperspace.

**Two memory figures that must not be quoted:**

- **45,498 MiB** — appears in about sixteen run logs as the unlabelled second field of a header line
  that no tracked script produces. It is printed *before* the model loads, and the file carries no
  column label, so it cannot be attributed to consumed VRAM. The card's true total is 46,068 MiB.
- **41,049 MiB** — **does not exist in the project.** The only matches for that digit string are
  tokenizer vocabulary IDs.

**The 30B RL pod is gone.** RunPod Secure Cloud releases the physical GPU when a pod is stopped, and
restart is best-effort. A stop was followed by *"There are not enough free GPUs on the host machine
to start this pod"*, and then the pod ceased to exist. One trained adapter, `policy-30b-seed1`, was
lost with its volume. Its configuration, completions and logs survive, and four other trained
adapters remain. No further GPU work is planned.

---

## 5. Serving

### The `/v1/models` endpoint cannot verify which model is loaded

The API's own `/v1/models` returns a **hardcoded literal**:

```
id:           "voidcode-ai-v5.2"
object:       "model"
owned_by:     "voidcode-ai"
architecture: "hybrid"
```

It names no model and reads no state; it returns that string regardless of what is loaded. Checking
`owned_by` on this endpoint proves nothing.

The real served-model identity comes from the **upstream inference backend's** own `/models`
response, which the project records via a `backend_registry.served_model()` lookup and surfaces on
`/health`. That mechanism was added after `/health` was caught reporting a 7B model while a 30B was
actually serving.

**Critical provenance gap:** all 30 scored evaluation files record the served model as the literal
placeholder string **`"whatever /v1/chat/completions serves"`**. The artifact identity is *not* in
the evaluation evidence. The only statement of which model produced those numbers is prose in the
readiness document.

*Attribution: `apps/api/src/main.py:2162-2174`; evidence file `summary.provenance.served_model`.*

### Serving stacks

| Stack | Serves | Configuration |
|---|---|---|
| **SGLang v0.5.9-cu130** | `Qwen/Qwen3.5-9B` — the tutor evaluation path | fp8 weights, `kv-cache-dtype fp8_e5m2`, context length 16,384, `mem-fraction-static 0.80` |
| **vLLM + AWQ** | 30B base + the `rl` adapter | `--enable-lora --max-lora-rank 32 --max-loras 1`, `--max-model-len 5120`, `--gpu-memory-utilization 0.85` |
| **vLLM compressed-tensors** | the 7B W4A16 artifact | `quantization="compressed-tensors"` |

### Quantisation, split strictly by purpose

- **Training only:** NF4 4-bit via bitsandbytes, with bf16 compute and double quantisation.
- **Serving only:** W4A16 for the 7B, AWQ for the 30B, fp8 for the 9B.

No NF4 path is used for serving and no AWQ/W4A16 path is used for training. The two never mix.

**A naming defect worth knowing about:** the directory `llm/outputs/awq_model/` **is not AWQ.** It
was produced by a `GPTQModifier` recipe at scheme `W4A16`, in `compressed-tensors` /
`pack-quantized` format, with `num_bits: 4`, `group_size: 128`, symmetric, `lm_head` ignored. Only
the *30B* artifact is genuinely AWQ, and a third party produced it.

### Measured serving throughput of the 30B

Single A40, AWQ, `max_tokens 768`, zero failed requests:

| Concurrency | Aggregate tok/s | Per-slot tok/s |
|---|---|---|
| 1 | 90.4 | 90.4 |
| 2 | 161.2 | 82.7 |
| 4 | 254.0 | 70.5 |
| 8 | 405.2 | 56.5 |
| 16 | **619.9** | 45.1 |

Achievable concurrency: **16**. Available KV cache at `--gpu-memory-utilization 0.85`: **20.55 GiB**.

---

## 6. Fine-tuning

### 6a. Supervised fine-tune (QLoRA) of the 7B tutor

| Parameter | Value |
|---|---|
| Base model | `Qwen/Qwen2.5-7B-Instruct` |
| Method | QLoRA — 4-bit NF4 base with bf16 compute, double quantisation, trainable LoRA adapter |
| LoRA rank / alpha | **r = 16, α = 32** |
| Target modules | 7 — `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj` |
| **Trainable parameters** | **40,370,176 — 0.92% of the model** |
| Optimiser | `paged_adamw_32bit`, lr 1e-4, cosine schedule, warmup ratio 0.03, weight decay 0.01 |
| Batch | per-device 1 × 32 gradient accumulation = **effective batch 32** |
| Gradient checkpointing | enabled |
| **Training examples** | **1,860**, split **1,674 train / 93 validation / 93 test** |
| Mode distribution | debug 760, teaching 900, followup 200 |
| Difficulty distribution | easy 754, hard 651, medium 455 |
| Not fine-tuned | the EXPLAIN mode — it is prompt-engineered only |
| Framework | TRL 0.27.1, Transformers 4.57.6, PEFT 0.18.1 |

**Three internal disagreements — do not present any of these as settled:**

1. The **saved adapter** records `lora_dropout: 0.1`; the **config file** says `0.05`.
2. The **last training run** used `max_seq_length: 1536`; the **config file** says `1024`. The
   project's own memory-audit document records this: *"The file and the last run disagree."*
3. A checkpoint directory holds a **different run entirely** — 2 epochs, batch 2, 108 steps, best
   eval metric 0.0926 — against the config's 1 epoch, batch 1.

Separately, a validation report in the project validates a **2,000**-example corpus with a different
mode split (debug 600, explain 300) from the **1,860** actually trained (debug 760, no explain). The
report does not name which file it validated, so 2,000 and 1,860 are not interchangeable.

### 6b. GRPO / RLVR on the 30B — the strongest result in the project

| Parameter | Value |
|---|---|
| Policy base | `Qwen/Qwen3-Coder-30B-A3B-Instruct`, loaded in 4-bit NF4 |
| LoRA rank / alpha | **r = 32, α = 64** |
| Target modules | **attention only** — `q_proj, k_proj, v_proj, o_proj` (MoE models make MLP adapters expensive) |
| Trainable parameters | **13.4M of 15.59B — 0.086%** at r=16; r=32 for the final run |
| Steps | **175** |
| Group size G | **16** completions per problem |
| Problems per step | 2, so **32 completions per step** |
| Max new tokens | 1,024 |
| Learning rate / KL β | 1e-6 / 0.04 |
| Temperature | 0.8 |
| Training problems | **339** |
| Held-out problems | **120** in-domain |
| Reward | verifiable — fraction of hidden test cases passed, executed per completion |
| Architecture note | the trainer holds the NF4 base plus trainable adapter, while a **separate resident vLLM engine** serves the AWQ base with a hot-reloaded adapter for rollout generation |

#### Results

| Metric | Value | n | Interpretation |
|---|---|---|---|
| **Held-out `mean_case_fraction`, in-domain** | **0.5680 → 0.6385, an improvement of +0.0705** | **120** held-out problems | The headline RL result |
| **Noise floor** | **standard deviation 0.0127** across 3 evaluations of a *frozen, unchanged* policy; spread 0.0241 | 3 runs | **The +0.0705 effect is ~5.5× this floor** |
| Step-0 noise floor | 0.0143 | 2 runs | Corroborates the above |
| **Dead groups** | **72% → 12.9%** | — | Most of the compute was originally producing no gradient |
| **Transfer to out-of-domain problems** | **−0.67 standard errors** | **60** authored ML/DL problems | **No transfer.** A negative result, reported as measured |
| Training signal lost to grading stalls | 28 of 350 groups, ~8% | — | Honest accounting of waste |
| Truncated completions | 2,475 | — | |

#### A metric that was discarded, and why it matters

`holdout_greedy_solved` — a count of held-out problems solved under greedy decoding — returned
**a spread of 59 to 68 (standard deviation 4.5 out of 120) across three evaluations of a policy that
had not changed.** (The source records the range and the standard deviation; the three individual
run values are not recorded, so do not state them.) The metric's own noise exceeded the effect it was meant to detect, so it was
discarded rather than reported. This is arguably a stronger methodological point than the headline
number.

#### Band filtering — why the training set is only 339 problems

Three filtering passes over **2,000** problems from the `agentica-org/DeepCoder-Preview-Dataset`,
each sampling G=8 completions with up to 20 test cases per problem:

| Filter model | Usable (in the 10–90% band) | In-band fraction | Always solved | Never solved | Mean pass rate |
|---|---|---|---|---|---|
| `Qwen2.5-Coder-1.5B-Instruct` | **184** | 0.092 | **0** | 1,816 | 0.024 |
| 30B AWQ | **551** | 0.2755 | 147 | 1,302 | 0.2151 |
| 30B AWQ, with chat template | **459** | 0.2295 | **285** | 1,256 | 0.2556 |

The progression `always_solved: 0 → 147 → 285` is the story: the 1.5B could not solve a single one
of the 2,000 problems reliably, which is why the work moved to the 30B.

#### Cost model, measured on one A40

At 32 completions per step: generation **58 s (10%)**, grading **2 s (0.4%)**, backward pass
**493 s (88%)**, total **559 s per step**. That is **15.4 s per completion**, giving
`step_seconds ≈ 15.4 × (problems_per_step × group) + 58`. A 175-step run at G=16 is therefore
**about 26 hours** on a single A40. VRAM left for the trainer after the vLLM engine became resident:
**24.3 GiB**.

### 6c. PPO and DPO — what does not exist

- **PPO** is implemented in the codebase and **was never run.** The project's own open-questions
  document records: *"Not built. GRPO only."* There is no PPO run artifact and no PPO
  hyperparameters anywhere.
- **DPO** is **not in the project** as anything run — no code, no config, no dataset, no run. It
  appears only as forward-looking roadmap text.

Do not claim a GRPO-versus-PPO comparison. It was specified and not built.

---

## 7. Evaluation numbers

### 7a. Tutor gates

**Artifact for every row in this table:** stock `Qwen/Qwen3.5-9B`, **no adapter**, SGLang fp8, local
RTX 5060 Ti. Streaming path — the same code path the web client uses. 75 scenarios total (debug 51,
empathy 9, teaching 6, explain 5, followup 4). Measured 2026-08-16.

| Metric | Value | Runs / n | Intervals and spread | Gate | Status | Repeatable? |
|---|---|---|---|---|---|---|
| **Bug localisation, diagnostic surface** | **0.813** | 51 scenarios × **9 runs** | range 37–45 of 51; **run-to-run [0.778, 0.847]**; **per-scenario [0.675, 0.890]** | ≥ 0.75 | **PASS** | **Yes** — with the artifact stated |
| Bug localisation, smaller pool of the same metric | **0.817** | 51 × **6 runs** | **[0.695, 0.898] per-scenario** | ≥ 0.75 | PASS | Yes, as a six-run figure |
| Bug localisation, hint surface | 0.150 | 51 | 7–9 of 51 | none | **not a gate** | Only with the explanation that the opening withholds line numbers by design |
| **Joint outcome** — routed correctly *and* localised | **0.761** | 51 × 6 runs | **[0.632, 0.860] per-scenario**; **run-to-run [0.712, 0.811]** | ≥ 0.80 | **FAIL** | Yes, as a failure |
| **Routing accuracy, end to end** | **0.933** | 75 | **zero variance** — deterministic pre-classifier | ≥ 0.90 | **PASS** | **Yes** |
| Routing, debug recall | **0.902** | 51 | 46, 46, 46 | ≥ 0.90 | PASS, marginal | Yes |
| Reasoning never reaches disclosure level 4 | 0.782 | 51 × 9 runs | 8–14 at level 4 | ≥ 0.98 | **FAIL, blocking** | Yes — and note it is the complement of the row below |
| Reasoning **reaches** level 4 | **0.218** | 9 runs | per-run: 10, 8, 14, 14, 12, 8, 8, 12, 14 | — | — | **No** — retracted figure, see §12 |
| Opening disclosure level ≤ 1 | 0.810 | 48 × 9 runs | 35–44 | ≥ 0.95 | FAIL, blocking | Yes, as a failure |
| Opening disclosure level = 0 | 0.285 | 48 × 9 runs | 11–18 | ≥ 0.95 | FAIL, blocking | Yes, as a failure |
| Multi-bug localisation recall | 0.540 | 15 | 0.467–0.567 | ≥ 0.55 | FAIL, marginal | Yes, with n=15 stated |
| No invented code, visible answer | 0.957 | 51 | 47–51 | ≥ 0.98 | FAIL, inside noise | Yes, with the noise caveat |
| No invented code, displayed reasoning | 0.706 | 47 | 29–38 | ≥ 0.98 | FAIL | Yes |
| Bug count accuracy | 0.521 | 48 | 24–26 | ≥ 0.80 | FAIL | Yes |
| Asks a question | 0.975 | 57 | 55–57 | ≥ 0.95 | PASS | Yes |
| Empathy, all checks | 1.000 | **9** | 9–9 | ≥ 0.95 | PASS | Only with n=9 stated |
| Responses echoing >50% of source | 0.431 | 3 runs | 22, 23, 21 | — | improved from 0.752 | Yes |
| Teaching, all checks | 0.833 | **6** | 4–6 | ≥ 0.85 | FAIL, underpowered | **No** — n=6 |
| Explain, all checks | 0.840 | **5** | 4–5 | ≥ 0.85 | FAIL, underpowered | **No** — n=5 |
| Answer leak rate (binary) | — | — | — | ≤ 0.02 | **RETIRED** | **No** |

**Context for the failures.** Most of these gates fail, and that is the documented state of the
project rather than something hidden. The disclosure gates fail *blocking*. The honest summary is:
the tutor localises bugs well and routes near-perfectly, and it does not yet reliably withhold as
much as the specification demands.

**A note on the output guard.** Separately from these gates, a structural leak detector was built
and proven live: across an 18-case adversarial suite, the model attempted to hand over a solution
8 times and the learner received it **0 times**. The guard strips a completed solution from the
response inside the streaming generator.

### 7b. Throughput — training and generation are not comparable

**Training** tokens/sec measures tokens through a forward+backward pass. **Generation** tokens/sec
measures tokens produced. Mixing them produces nonsense.

| Value | What it measures | Repeatable? |
|---|---|---|
| **411.9 tok/s** | QLoRA **training**, 7B, seq 1024, batch 1 — on the **local RTX 5060 Ti (15.93 GiB)** | Only with the card named. The project states it is **"not a valid baseline for A6000 throughput comparisons"** |
| 383.1 tok/s | same, seq 2048 | Same caveat |
| 1,049.6 tok/s | DDP **training**, 5.75B, Adafactor, on A40 at 41.01 GiB/device | Yes |
| 500.1 tok/s | 7.6B single-GPU **training** on A40, fits at 37.17 GiB | Yes |
| 90.4 → 619.9 tok/s | 30B AWQ **generation**, concurrency 1 → 16 (see §5) | Yes — same server, different concurrency |
| 356.7 tok/s | HuggingFace `generate` rollout baseline, 1.5B, A40 | Yes |
| 1,129.3 tok/s | same model, vLLM **per-prompt** submission — 3.17× the above | Yes |
| 4,699.8 tok/s | same model, vLLM **batched** submission — 13.18× | Yes — same model, different submission pattern |
| 18.6 tok/s | measured on the local card | Yes |
| 157.1 tok/s | 7B W4A16 under vLLM 0.11 | Only as *"a small-batch latency-shaped figure, not a sustained throughput benchmark"* |
| **2.4 tok/s** | 7B W4A16 through transformers eager | **No** — the project says explicitly: *"Do not quote 2.4 tok/s anywhere."* |
| **730 tok/s** | 1.5B 8-bit AdamW training | **No** — **discarded**, contaminated by Windows WDDM silently spilling to host RAM |
| **15.1 and 1,295.7 tok/s, "85.8× faster"** | 30B eager vs vLLM | **No** — source-code comments only; no artifact backs them |
| ~80–120 / ~10–20 tok/s, "5–8×" | spec-document figures | **No** — projections, never measured |

### 7c. Memory measurements

| Value | What it measures |
|---|---|
| 10.381 GiB allocated / 10.939 reserved | QLoRA r16 7B, seq 1024, batch 1 — peak, during backward |
| 13.091 GiB allocated / 14.422 reserved | same at seq 2048 |
| 5.19 GiB | the 7B W4A16 artifact resident on GPU after load (41.3 s load time) |
| 5.16 GiB on disk, 2 shards, 196 int4-packed tensors | the same artifact — **15.2 GB fp16 → 5.16 GiB, a 2.9× reduction** |
| 41.01 GiB/device | DDP 5.75B Adafactor peak |
| 42.86 GiB allocated, needed 2.03 GiB more | DDP 7.62B Adafactor + gradient checkpointing — **out of memory** |
| 41.40 → 25.60 → 17.55 GiB | peak per device as GPU count rises 1 → 2 → 4 |
| **28.77 GiB on a 16 GiB card** | Windows WDDM silently spilling a backward pass into host RAM — the contamination that invalidated the 730 tok/s figure |

---

## 8. Data pipeline and recommender

### 8a. Pipeline scale

| Fact | Value |
|---|---|
| Source | **Codeforces public API** (`contest.status`), two passes: 301 contests for breadth + 1,000 learner histories for depth |
| Rows **fetched** | **2,341,061** |
| Rows **surviving to silver** | **2,296,409** — duplicate submission IDs and `TESTING`/`SKIPPED` verdicts dropped |
| Landing zone | 614 MB newline-delimited JSON |
| Warehouse | 170 MB Parquet, snappy compression |
| **Spark throughput** | **9,241 rows/s** — 2,296,409 rows in **248.5 s** on **10 cores**, WSL2 Ubuntu |
| Stack | **PySpark 3.5.3** pinned, Hive-enabled session over an embedded Derby metastore |
| Learners with mastery vectors | **117,453** |
| Problem catalogue coverage | **11,284 of 11,311 — 99.8%** |
| Concept coverage | **67 of 80** |
| Feature columns | all nine specified features populated, **25 columns total** |
| Acceptance gate | rows processed > 1,000,000 required — **PASS at 2,296,409** |

**A scale caveat the project states about itself:** the embedded Derby metastore *"is not a shared
catalog in any operational sense"* — it demonstrates the programming model, single-writer. And the
platform has **zero real learner submissions**; every figure above is Codeforces public data.

### 8b. The recommender

Two stages: candidate generation, then a **LightGBM LambdaMART** re-ranker (`objective=lambdarank`,
truncation level 30). **Not XGBoost** — XGBoost is not in the project at all.

**Eleven features** per (learner × candidate problem) row: `mastery`, `mastery_known`,
`attempts_on_concept`, `first_attempt_rate`, `difficulty`, `n_concepts`, `from_weak_concept`,
`from_prerequisite`, `from_coverage_gap`, `catalog_popularity`, `concept_recency_days`.

Graded relevance labels: 3 = struggled then passed, 2 = passed first try, 1 = abandoned, 0 = unseen.

| Fact | Value |
|---|---|
| Evaluation cohort | **20,537 learners** — those with ≥3 problems before *and* ≥3 after the temporal cutoff. **This is a count of learners, not rows.** |
| Temporal cutoff | 2026-07-15, the 80th percentile of first-attempt time |
| Train / evaluation split | **1,056,303 / 264,079** pairs |
| Median post-cutoff problems per cohort learner | 6 |

#### Results — 60 evaluation learners against the full 11,267-problem catalogue

| Ranker | NDCG@5 | NDCG@10 | 95% CI | Recall@100 |
|---|---|---|---|---|
| **LambdaMART (11 features)** | **0.1467** | **0.2143** | **[0.1590, 0.2697]** | **0.616** |
| Popularity baseline | 0.0497 | **0.0511** | [0.0261, 0.0816] | 0.190 |
| Difficulty-sorted | 0.0000 | 0.0000 | — | 0.009 |

The NDCG@10 confidence interval's lower bound (0.1590) clears the best baseline (0.0511) by roughly
3×, which is the claim worth making — not the point estimate alone.

> ### Mandatory qualifier: "eleven-feature"
>
> The project contains a **second measured table** in which LambdaMART scores NDCG@10 **0.0059** and
> **loses to the popularity baseline (0.1757) by about 30×**, with the explicit verdict that the
> requirement was not met. That table is the **nine**-feature model — `catalog_popularity` and
> `concept_recency_days` were absent from it.
>
> The ablation confirms the mechanism: removing `catalog_popularity` alone drops NDCG@10 from
> **0.2584 to 0.0367**. Popularity carries most of the signal.
>
> So 0.2143 is repeatable **only** as the eleven-feature model. Quoted bare, it is contradicted by
> another measured table in the same project.

#### Feature ablation — 40 to 120 evaluation learners, seed 20260812

| Features used | NDCG@10 |
|---|---|
| All 11 | **0.2584** |
| minus `concept_recency_days` | 0.2496 |
| minus `n_concepts` | 0.1924 |
| minus `n_concepts` + `concept_recency_days` | 0.1146 |
| **minus `catalog_popularity`** | **0.0367** |
| minus `catalog_popularity` + `concept_recency_days` | 0.0041 |
| **only** `catalog_popularity` | 0.0611 |

**Note the cohort differs** — 40–120 learners here versus 60 for the 0.2143 table. The 0.2584 and
0.2143 figures are both "NDCG@10 with all eleven features" and are **not the same measurement**.
Never merge them.

#### Fairness / subgroup analysis — 700 learners

| Group | NDCG@10 | 95% CI |
|---|---|---|
| Overall | 0.1888 | — |
| **Sparse-history learners (1–5 problems)** | **0.1272** | **[0.1045, 0.1523]** |
| 6–20 problems | 0.1965 | — |
| 21–60 problems | 0.2636 | — |
| 61+ problems | 0.2664 | — |

Sparse-history learners score **32.6% below** the overall mean, and the confidence interval
**excludes** that mean. Monotone in history depth. Controlling for positive count, the gap persists
and widens: −27% at 2–3 positives, −28% at 4–8, −36% at 9+.

Two honest details: at n=200 the sparse bucket read −13.8% and **did not trip** the 15% flag — a
false negative that a larger sample corrected. And in the sparse bucket the model still beats
popularity 0.1272 vs 0.0276, a 4.6× margin.

#### A methodology defect found and fixed

With only 12 distinct model scores spread across 11,272 candidates, a **stable sort** left tied
candidates in catalogue order. That produced **NDCG@10 of 0.3142 in row order versus 0.0200
shuffled** — the stable sort inflated the result by **94%**. Fixed with an explicit random
tie-break. **0.3142 must never be quoted as a result**; the *finding* is the valuable part.

#### Personalisation

Mean top-10 overlap between any two learners: **4.52 of 10**. **Zero** of 780 pairwise comparisons
produced identical lists. 48 distinct problems across 40 learners' top-10s. The honest reading, in
the project's own framing: *"Recommended for you" is defensible; "personalised learning path" is
not.*

### 8c. Difficulty model

**Rasch 1PL** item-response model, 10% held out, seed 7:

| Metric | Value |
|---|---|
| **Held-out log loss** | **0.22661** |
| vs global-mean baseline | model **22.5% better** |
| vs per-problem-mean baseline | model **25.28% better** |
| **Difficulty vs Codeforces rating, Spearman** | **0.4864 overall**; **0.6627** at ≥50 observations; **0.8730** at ≥1000 observations |
| Median observations per problem | 7 |
| Calibration | 5-fold isotonic; ECE **0.0348**, MCE **0.1708** over **1,320,382** outcomes |
| Cold start ruled out | only **1,996 of 1,320,382 rows (0.15%)** had a problem no training fold saw |

The 0.4864 / 0.6627 / 0.8730 progression is the interesting part: the model agrees strongly with
external ratings where it has data, and the overall figure is dragged down by sparsely-observed
problems. **Two quantities were never re-measured** after the corpus rebuild and must not be quoted
in any form: total IRT observations (was 744,643) and ability spread θ.

### 8d. Content catalogue

**200 problem definitions**, 699 test cases (421 hidden / 258 visible), 145 concepts resolving in an
acyclic prerequisite graph. Per-area: ML+DL 98, LLM 58, CUDA 44, Systems 35, VLM 24. Auto-graded
share: 125 executable / 32 rubric.

Two disjoint concept worlds: the recommender is trained on **classic DSA** concepts from Codeforces,
while the platform's own content is **ML concepts** — 64 vs 67, described in the project as
*"perfectly disjoint"*, with only 7 of 203 prerequisite edges crossing. **So no model fitted on the
research corpus transfers to the product's content**, and the project says so.

*A constraint on one file: a 60-problem catalogue is the answer key for the RL reward function. Its
reference solutions and oracle outputs must never be published.*

---

## 9. Infrastructure

| Component | Detail |
|---|---|
| Databases | **PostgreSQL 16-alpine** and **Redis 7-alpine**, both version-pinned. Async SQLAlchemy 2.0 with asyncpg |
| Migrations | **20 Alembic revisions**, applied in CI with `alembic upgrade head` against a real Postgres 16 service container |
| Code sandbox | **Judge0 CE 1.13.1**, pinned, self-hosted as 2 services (server + workers), `privileged: true` for isolate sandboxing, bound to loopback only, with **its own separate Postgres and Redis** |
| Sandbox hardening | network disabled (`ALLOW_ENABLE_NETWORK: false`), per-process **and** per-thread time limits, per-process and per-thread memory limits, auth and admin tokens via headers |
| Sandbox latency | p95 **897 ms** at 100 concurrent requests; p95 **19 ms** at 10 |
| CI | **4 GitHub Actions workflows** — main CI (3 jobs: api with live Postgres, ML tree with ruff lint and coverage gate, web typecheck+build), container release, desktop (3-OS matrix with a dependency-licence gate and CycloneDX SBOM generation), and tagged release |
| Tests | **88 test files, approximately 1,109 test functions** across two test roots |
| Coverage | **41.27%**, against a CI-enforced floor of 40% |
| Containers | **6 compose files, 4 Dockerfiles**. Nginx `least_conn` load balancer over 3 GPU replicas |
| Concurrency | `asyncio.Semaphore` gate; streaming holds its permit until the stream ends |
| Kubernetes | manifests **exist** — Namespace, 2 Deployments, 2 Services, HorizontalPodAutoscaler (2–4 replicas), Ingress, 2 NetworkPolicies, Kustomization |

> **Say "authored", never "deployed".** The project states it outright: `deploy/base` *"has never
> been applied to a cluster — kubectl is available in CI but no cluster was reachable"*, so even a
> client-side dry run validated nothing. The CI deploy job is permanently gated off with
> `if: false`.

**Not present in the project:** Terraform, Helm, Skaffold, CloudFormation, Pulumi, CDK, Bicep, any
second CI system (no GitLab CI, CircleCI, Travis, Azure Pipelines, Jenkins), any vector database
(no pgvector, Qdrant, Chroma, Weaviate, Pinecone), SQLite, MongoDB, ClickHouse, Elasticsearch,
Delta Lake, and any JavaScript test runner for the web application.

---

## 10. Safe to quote — the short list

Everything here reproduces from a stored artifact. The qualifier in each line is part of the claim.

**Reinforcement learning (the strongest material):**

- GRPO on a 30B MoE code model improved held-out `mean_case_fraction` from **0.5680 to 0.6385
  (+0.0705) on 120 held-out problems**, against a noise floor of **sd 0.0127** established by
  re-running a frozen policy three times — an effect roughly **5.5× the floor**.
- Reduced dead groups (groups yielding no gradient) from **72% to 12.9%**.
- Measured **no transfer** to 60 out-of-domain problems: **−0.67 standard errors**.
- **Discarded** a metric — `holdout_greedy_solved` — after it returned 59–68 (sd 4.5 of 120) across
  three evaluations of an *unchanged* policy.
- Established the cost model: **559 s/step** at 32 completions, backward pass **88%** of it,
  ~**26 hours** for 175 steps on one A40.

**Recommender:**

- Eleven-feature LambdaMART achieves **NDCG@10 0.2143 [0.1590, 0.2697]** against a popularity
  baseline of **0.0511 [0.0261, 0.0816]** — the interval's lower bound clears the baseline ~3×.
- **Recall@100 0.616** vs 0.190 popularity, 0.009 difficulty-sorted.
- Ablation shows **`catalog_popularity` carries most of the signal**: removing it drops NDCG@10 from
  0.2584 to 0.0367.
- **Fairness gap**, self-reported: sparse-history learners score **0.1272 [0.1045, 0.1523]** against
  an overall **0.1888** — **32.6% below, with the interval excluding the mean**.
- Caught a **stable-sort tie-break inflating a result by 94%** (0.3142 row-order vs 0.0200 shuffled)
  and fixed it with a random tie-break.

**Tutor (state the artifact — stock 9B, no adapter):**

- Bug localisation on the diagnostic surface: **0.813** over **51 scenarios × 9 runs**, range 37–45,
  run-to-run **[0.778, 0.847]**, per-scenario **[0.675, 0.890]**.
- Routing accuracy **0.933** on 75 scenarios with **zero variance** (deterministic pre-classifier).
- Built a structural output guard: across an 18-case adversarial suite the model attempted to hand
  over a solution **8 times** and the learner received it **0 times**.
- Corrected a scorer that was crediting the model for **echoing the learner's own code and reciting
  its own prompt**, which moved a published figure from 0.745 to 0.218.

**Data engineering:**

- Spark pipeline processing **2,296,409 rows at 9,241 rows/s** on 10 cores (248.5 s), surviving from
  2,341,061 fetched.
- **117,453** learners with mastery vectors; **99.8%** catalogue coverage (11,284 of 11,311).
- Rasch 1PL difficulty model, **held-out log loss 0.22661**, Spearman vs external ratings **0.4864**
  overall rising to **0.8730** at ≥1000 observations.

**Systems:**

- Self-hosted **Judge0 CE 1.13.1** sandbox with network disabled and per-process/per-thread limits;
  p95 **897 ms** at 100 concurrent, **19 ms** at 10.
- **20 Alembic migrations** applied in CI against a live Postgres 16.
- **4 CI workflows**, ~**1,109 tests** across 88 files, coverage **41.27%** against a 40% gate.
- FP8 measured at **97.4 TFLOP/s**, **2.01×** BF16, on a Blackwell card.

---

## 11. Welded numbers — pairs that must never be combined

The failure mode this brief exists to prevent: two real numbers, one false sentence.

1. **0.813 + "95% confidence interval."** The source gives 0.813 a run count and a *range*, and **no
   CI**. The interval `[0.695, 0.898]` belongs to **0.817** — a six-run pool — and is a per-scenario
   interval. 0.813's own intervals are **[0.778, 0.847]** run-to-run and **[0.675, 0.890]**
   per-scenario, and both had to be computed; neither was published.
2. **0.813 + any trained model.** It measures stock Qwen3.5-9B with no adapter.
3. **0.782 and 0.218 as two metrics.** They are complements of one measurement, both over 9 runs.
4. **"NDCG@10" bare.** Three different values exist: 0.2143 (60 learners, 11 features), 0.2584
   (40–120 learners, 11 features), 0.0059 (9 features, loses to baseline).
5. **411.9 tok/s + a server-class GPU.** It is a local RTX 5060 Ti *training* figure, and the
   project explicitly forbids using it as an A6000 baseline.
6. **Training tok/s beside generation tok/s.** Different quantities entirely.
7. **2,296,409 and 2,341,061.** Surviving-to-silver versus fetched.
8. **20,537 as a row count.** It counts *learners*.
9. **Kubernetes manifests + "deployed."** Never applied to a cluster.
10. **9 runs + the 0.817 value, or 6 runs + the 0.813 value.** The pools are 9 → 0.813 and
    6 → 0.817.

---

## 12. Retracted or superseded, with corrected values

| Retracted value | What it claimed | Corrected value |
|---|---|---|
| **0.745** | Reasoning reaches disclosure level 4 | **0.218.** 125 of 225 apparent hits were scorer artefacts — echoed learner code, the model reciting its own mandated prompt opening, and quoted punctuation. It was a figure from an earlier arm carried forward across four later arms without re-measurement; its true value on the same scorer was 0.490 |
| **0.9170** | Difficulty vs Codeforces rating, Spearman | **0.4864** — the project describes this as *"a headline correlation nearly twice the real value"*, sitting in *"the first document a reader opens"* |
| **0.875** | Opening disclosure level ≤ 1 | **0.810** on the corrected scorer (0.789 on the old one) |
| **0.255** | Reasoning never reaches level 4 | **0.782** |
| **0.647** and **0.608** | Diagnostic localisation | **0.813** over the nine stored runs. The 0.647 sat in a gates table while the *same document's* headline said 0.817 |
| **0.3142** | NDCG@10 | **0.0200** with random tie-breaking — a stable sort over 12 distinct scores inflated it by 94% |
| **0.078** | Per-mode debug score | **0.588.** Bug-localisation was being scored on the answer surface, penalising the mode for the disclosure policy a second time |
| **1,234,270** rows · **94,850** learners · **103** problems · **894,535** mastery rows | Pipeline scale, before the corpus rebuild | **2,296,409** rows · **117,453** learners · **11,284** problems |
| **1,806,262** rows | Pipeline scale — a **second, different** superseded row count. Both it and 1,234,270 appear in the project, so there are three candidate figures in circulation | **2,296,409** |
| **22.11 GB/s** | Multi-GPU all-reduce bus bandwidth over P2P | **7.72 GB/s over shared memory** |
| **27,684 rows/s** | Spark throughput on the old corpus | **9,241 rows/s** on the current one |
| **730 tok/s** | 1.5B 8-bit AdamW training | **Discarded with no replacement** — Windows WDDM spilled 28.77 GiB onto a 16 GiB card, silently, invalidating the measurement |
| `holdout_greedy_solved` | In-domain solve count | **Metric discarded** — 59–68, sd 4.5 of 120, across three evaluations of an unchanged policy |
| Answer leak rate (binary), gate ≤ 0.02 | Solution leakage | **Retired**, superseded by the 0–4 disclosure ladder |

---

## 13. Permanently unverifiable

RunPod work has ended and the pod is gone. These will not be resolved later.

| Claim | Why it cannot be checked |
|---|---|
| Which model `/v1/models` reports | The API's response is a hardcoded constant reading no state. The upstream backend that would answer truthfully was lost with the pod |
| Which artifact served 6 of the 9 localisation runs | The evidence files record only the placeholder `"whatever /v1/chat/completions serves"`. The provenance record naming the 9B scopes itself to the first 3 runs |
| The `policy-30b-seed1` adapter | Lost with the pod volume. Its config, completions and logs survive; four other trained adapters remain |
| Any A6000, A100, H100 or L40S measurement | Never taken. Those GPUs appear only in a price table |
| Full fine-tune throughput, NCCL bus bandwidth on >2 GPUs, multi-GPU speedup, dataset rejection rate | Recorded in the project as **"NOT MEASURED — hardware absent"** |

---

## 14. Unresolved internal conflicts

Recorded rather than silently decided. None is repaired; if a figure below matters, say which source
you are using.

| Conflict | The two values |
|---|---|
| Test-case count | **495 across 87 problems** in one document vs **699 (421 hidden / 258 visible) across 200 items** in another — the second declares itself the authoritative computed source |
| SFT LoRA dropout | **0.1** in the saved adapter vs **0.05** in the config file |
| SFT sequence length | **1536** in the last training run vs **1024** in the config file |
| SFT corpus size | a **2,000**-example validation report vs the **1,860** examples actually trained, with different mode splits |
| Pipeline row count | three figures in circulation: 1,234,270 · 1,806,262 · 2,296,409 (current) |
| A stale absence claim | one document states Spark, PySpark, Parquet and Hive are *"absent from the whole repository"* — false for the current tree; a later line clarifies the claim was only ever about the desktop subtree |
| A second stale absence claim | another document states there are *"zero hits for PPO / GRPO / RLHF / reward_model"* — false; GRPO is implemented and was run, and PPO is implemented |
| `45,498 MiB` | an unlabelled log column appearing in ~16 files, attributable to nothing |
| Ranking results | the nine-feature table (NDCG@10 0.0059, "requirement not met") vs the eleven-feature table (0.2143). The first is now marked superseded in place |

---

## 15. How 0.813 reproduces, worked in full

Included because reading the wrong field produced a confident, wrong conclusion — that the headline
figure was unreproducible. The raw data is here so the arithmetic can be checked without any file.

### The trap

A rescore had recomputed every per-record score in three of the nine run files and **left the
summary block behind.** In those files:

- `summary.by_check.bug_localisation` read **9, 8, 8** out of 51.
- The per-record scores in the *same files* read **43, 42, 37** out of 51.

Pooling the stale summary field across all nine runs gives **0.6013** with a range of **8–45**, which
matches nothing in the published documents. That is what led to the wrong conclusion. The summary
was stale; the records were correct.

The stale check also dragged five per-mode bucket rows with it, because the per-mode figure derives
from an all-checks-passed flag that includes bug-localisation: the debug bucket read **3, 4, 5** of
51 where the records said **30, 32, 28**.

### The reproduction

Per-run passes out of 51 scenarios, diagnostic surface:

| Arm | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| v6 | 43 | 42 | 37 |
| v7 | 45 | 43 | 40 |
| v8 | 42 | 40 | 41 |

**Nine-run pool (v6 + v7 + v8):**

```
per-run:  43, 42, 37, 45, 43, 40, 42, 40, 41
sum:      373 passes out of 459 attempts
rate:     373 / 459 = 0.81264  ->  0.813     matches the published 0.813 exactly
range:    37 - 45                            matches the published range exactly
```

**Six-run pool (v6 + v7):**

```
per-run:  43, 42, 37, 45, 43, 40
sum:      250 passes out of 306 attempts
rate:     250 / 306 = 0.81699  ->  0.817     matches the published 0.817 exactly
```

The published six-run figure lists its per-run values as `43, 42, 37, 45, 43, 40` — the v6 and v7
runs, **in that exact order**. That is what identifies the pools conclusively.

### The intervals

```
between-run standard deviation:  0.045
standard error (n = 9 runs):     0.015
t(0.975, df = 8):                2.306

run-to-run 95% interval:   0.8126 +/- 2.306 x 0.015  =  [0.778, 0.847]
   -> bounds the mean ON THESE 51 FIXED SCENARIOS (rerun stability)

per-scenario Wilson at n = 51, p = 0.813:  [0.675, 0.890]
   -> bounds GENERALISATION TO NEW SCENARIOS (the honest width)

Wilson at n = 459 (pooled):  [0.774, 0.846]
   -> DO NOT USE. Nine runs of one 51-scenario set are not 459 independent
      trials. It happens to sit near the run-to-run interval, which makes it
      look like corroboration rather than a different claim.
```

For comparison, the published `[0.695, 0.898]` attached to the **0.817** figure is a per-scenario
Wilson interval at n=51 — correctly computed, simply attached to the six-run value rather than the
nine-run one. That is the weld: a per-scenario interval from a six-run figure, quoted beside a
nine-run value.

### Independent corroboration

The published per-run debug figures are `30, 32, 28, 35, 30, 26`. The first three are **exactly**
the v6 values the repair produced (30, 32, 28), and match **nothing** in the stale summary (3, 4, 5).

So the published documents were written from correctly rescored data all along; only the *stored
summary blocks* had drifted. The numbers were right and one of the artifacts describing them was
wrong — which is the opposite of the situation that was feared, and the reason this brief reads
records rather than summaries.
