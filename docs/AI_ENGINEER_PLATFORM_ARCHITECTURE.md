# AI Engineer Platform — System Architecture and Data Strategy

**Audience.** Working software developers moving into AI engineering. They already have
Git, CI, Docker, APIs, testing and code review. They do **not** have a tensor mental
model, a GPU memory mental model, training-dynamics intuition, evaluation design, or data
quality instincts. Design for that gap specifically — do not teach programming.

**Scope.** Teaching practical ML / DL / LLM / VLM engineering, with hands-on fine-tuning.

> **Provisional placement.** This is a *different product* from VoidCode AI (a Socratic
> tutor for university students learning Python/Java). It is filed here pending a decision
> on whether this is a VoidCode pivot or a second product — see §11. If it is a second
> product it should move to its own repository, because the VoidCode spec §0 explicitly
> scopes that repo to one build.

---

## 1. The constraint that determines the architecture

It is not scale. It is **untrusted code with CUDA access**.

Learners must run real fine-tunes, which means arbitrary Python touching a GPU. Every
cheap isolation primitive you would reach for on a CPU exercise degrades here:

- Containers share the host kernel *and* the NVIDIA driver. Device nodes are passed in.
- `nvidia-smi` from inside a container can enumerate contexts belonging to other tenants.
- gVisor's GPU path (`nvproxy`) is materially newer and narrower than its CPU sandbox.
  Treat it as something to validate against your exact driver + CUDA + framework combo,
  not as a given.
- MIG partitions a GPU but does not give you a security boundary you would bet a business
  on against arbitrary code.

**Therefore: the isolation boundary is one job per VM per GPU, not one job per container.**
Firecracker/Kata with device passthrough, or simply one pod per dedicated node. This
decision propagates into node pools, scheduling, cold-start budget and unit economics.
Retrofitting it later is a rewrite, so commit now.

### The corollary that makes the business work

Split the curriculum by *whether a lesson needs code execution at all*, and by *whether it
needs a GPU*. Most of what makes someone an AI engineer does not need a big GPU.

| Tier | Learner supplies | Isolation | Backing compute | Cost profile |
|---|---|---|---|---|
| **A. Config-only** | YAML: model, LoRA rank, lr, dataset, seq len | No user code — shared worker pool | Shared small GPU, batched | Cheap, near-instant |
| **B. Notebook, CPU** | Arbitrary Python, no CUDA | Container + seccomp + no network | CPU pool | Cheap |
| **C. Notebook, GPU** | Arbitrary Python + CUDA | **Dedicated VM, GPU passthrough** | Single-tenant GPU node | Expensive — gate it |
| **D. Capstone** | Full repo, possibly multi-GPU | Dedicated node, spot + checkpointing | 1–2 large GPUs | Metered, quota'd |

Tier A is underrated. A learner who submits a config and watches loss curves, memory
profiles and eval deltas has learned most of the mechanics of fine-tuning without you ever
executing their code. Push as much of the curriculum into A and B as it will bear.

---

## 2. GPU tiering derived from measurement, not spec sheets

These are **measured** on this project's hardware (single 16 GiB card, `docs/MEMORY_AUDIT.md`),
which is what makes them usable for capacity planning rather than guesswork. Peak allocated,
batch 1, gradient checkpointing on, sequence 1024.

| Model | Configuration | Peak | Verdict |
|---|---|---|---|
| Qwen2.5-0.5B | Full FT, AdamW FP32 | 9.56 GiB | fits 16 GB |
| Qwen2.5-0.5B | Full FT, 8-bit AdamW no master | **3.11 GiB** | fits 8 GB |
| Qwen2.5-0.5B | Full FT, GaLore r128 | 2.57 GiB | fits 8 GB |
| Qwen2.5-1.5B | Full FT, AdamW FP32 | — | **OOM at `opt_step`** on 16 GiB |
| Qwen2.5-1.5B | Full FT, 8-bit AdamW no master | **9.10 GiB** | fits 16 GB |
| Qwen2.5-7B | QLoRA r16 (NF4) | **10.38 GiB** | fits 16 GB, 411.9 tok/s |
| Qwen2.5-7B | QLoRA r16, seq 2048 | 13.09 GiB | fits 16 GB, 383.1 tok/s |
| Qwen2.5-7B | Full FT, AdamW (static state) | **113.48 GiB** | needs ~3× A6000 |
| Qwen2.5-7B | Full FT, Adafactor BF16 | 31.65 GiB (39.0 at seq 4096) | fits one 48 GB |

Two findings from that audit that belong in the curriculum verbatim, because they overturn
what developers assume:

1. **A "7B" model is 7,615,616,512 parameters** — 8.8% more than the name implies. A budget
   built on a round 7.0 B under-counts by ~9 GiB at 16 bytes/param.
2. **Activation memory is a vocabulary problem, not a depth problem.** At sequence 1024, of
   2.57 GiB of activations, **2.04 GiB is the loss head** over a 152k vocabulary and only
   0.19 GiB is all 28 transformer layers.

### Platform tiers that fall out of this

| SKU class | VRAM | What it unlocks | Curriculum role |
|---|---|---|---|
| T4 / L4 | 16 GB | 0.5B–1.5B full FT, 7B QLoRA | **The workhorse.** ~80% of lessons |
| L4 / A10 | 24 GB | 7B QLoRA at longer context, 1.5B comfortable | Intermediate |
| A6000 / L40S | 48 GB | **7B full-parameter FT** (Adafactor) | "Full FT vs PEFT" lesson |
| A100 / H100 | 80 GB | 7B FT with headroom, 14B PEFT, VLM work | Capstone only |

The pedagogical point: teaching the *mechanics* of fine-tuning is model-size-agnostic.
Dataset format, tokenization, loss curves, overfitting, eval design, leakage — all learnable
at 0.5B on a 16 GB card. Reserve 48/80 GB for exactly one lesson where the *point* is scale.

---

## 3. System architecture — four planes

### Control plane
Kubernetes. Stateless API (auth, curriculum, submissions, quota, billing), Postgres for
entities, Redis for sessions and rate limits. **Nothing here is GPU-aware** — that
separation is what lets you scale the product independently of the fleet.

### Compute plane
- **Durable orchestration: Temporal** (or Argo Workflows). Not a bare queue. A fine-tune
  that dies at step 400 of 500 must be resumable and inspectable, and you need
  compensation logic for cleanup. Celery gives you none of that.
- **Node pools**: CPU pool (default), GPU pool (tainted, single-tenant, Karpenter-scaled on
  pending-job count).
- **Spot instances with mandatory checkpointing** every N steps to object store. Spot is
  60–90% cheaper and preemption is survivable *if and only if* checkpointing is enforced by
  the platform rather than left to learner code.
- **Hard per-job limits, enforced not documented**: wall clock, VRAM, dataset bytes,
  checkpoint bytes, egress bytes, max steps.
- **Assert on memory.** Read `torch.cuda.max_memory_reserved()` per step and fail loudly
  above the card's capacity. On WDDM/WSL2 in particular, allocations spill silently into
  host RAM and a run *looks* successful while executing over PCIe at a fraction of speed.
  Never treat "it did not crash" as evidence a configuration fits.

### Data plane
- Object store as the only durable substrate. Everything else is a cache.
- **Dataset versioning: lakeFS or Delta**, not DVC-in-Git. Learner datasets are large and
  mutable; you want branch/merge/time-travel semantics and cheap immutable snapshots so a
  lesson can pin an exact version.
- Parquet for tabular/telemetry, JSONL for instruct records, both partitioned by ingest date.

### Learning plane
This is what makes it a school and not GPU rental.
- **Curriculum-as-code** (§6)
- **Experiment tracking: MLflow** — every learner run is a tracked experiment
- **Model registry** — each learner's fine-tune is a versioned, promotable artifact
- **Graders** — autograding on measured outcomes

**Design rule: learners use the same registry, tracking and pipeline the platform uses.**
Do not build a toy alongside the real thing. The MLOps muscle memory *is* the curriculum.

---

## 4. Dataset pipeline

A DAG with a gate at every stage. The DAG is simultaneously the platform's production
pipeline and a teaching artifact learners read, modify and break.

```
source → licence gate → parse/normalise → near-dup removal → DECONTAMINATE
       → quality filter → schema validation → split → version + register → card
```

| Stage | Requirement | Failure it prevents |
|---|---|---|
| Licence gate | Per-file SPDX resolution against an allowlist. Provenance recorded **per record**, not per corpus. | Discovering a copyleft file after you have shipped weights |
| Near-dup removal | MinHash + LSH, Jaccard ≈ 0.85. Across splits too, not just within. | Paraphrase leakage inflating eval |
| **Decontaminate** | Strip HumanEval, MBPP, SWE-bench, MMLU and *your own* eval sets before training. Report hit counts. | The single failure that destroys credibility fastest |
| Quality filter | Does it parse? Do imports resolve? Does the training script converge on a tiny fixture? | Teaching from code that does not run |
| Schema validation | One canonical versioned chat schema, enforced with Pydantic/pandera. **Reject, never coerce.** | Silent format drift poisoning the fine-tune |
| Split | Held out by **repository/author**, never random rows. | Files from one project on both sides |
| Card | Auto-generated: counts, sources, licences, rejection rate by reason, decontamination hits. | Unauditable datasets |

Track **rejection rate by reason** as a first-class metric with a dashboard. It is the
fastest signal that an upstream source has rotted, and it is an excellent lesson in itself.

---

## 5. Data strategy — the differentiator

For *this* domain you have an advantage almost no other fine-tuning project has:
**you can generate verifiable ground truth by execution.**

AI-engineering failures are overwhelmingly mechanical and deterministic. So build the core
corpus by controlled mutation and capture the real interpreter output.

```
working ML script  →  semantic mutation  →  EXECUTE  →  capture traceback + memory + loss
                                                     →  record (broken, output, minimal fix)
```

**The label is the interpreter, not an LLM.** That yields a corpus that is large, cheap,
auditable, exactly on-domain, and immune to the "synthetic data that merely sounds right"
failure mode.

### Mutation library — the taxonomy is the syllabus

| Family | Example mutation | What it teaches |
|---|---|---|
| Shape | transpose an einsum; wrong `hidden_size` | tensor mental model |
| Device | drop a `.to(device)` | host/accelerator boundary |
| Dtype | mix fp16 and bf16; forget autocast | numerical precision |
| Memory | batch/seq that OOMs; no gradient checkpointing | GPU memory model |
| Training dynamics | lr 100× too high; forget `zero_grad`; wrong loss reduction | optimisation |
| Eval hygiene | forget `.eval()`; leave dropout on; leak labels | evaluation design |
| Tokenizer | wrong pad side; no attention mask; off-by-one label shift | LLM-specific pitfalls |
| PEFT | LoRA on the wrong modules; adapter not merged | practical fine-tuning |
| VLM | wrong image preprocessing; misaligned vision/text token counts | multimodal |

The eval set follows directly: can the model diagnose a traceback from a mutation family it
has seen, on code it has not? Held out by source repository.

### The two-corpus split

| Corpus | Volume | Label source | Cost |
|---|---|---|---|
| Execution-verified mechanics | Large (10⁵+) | Interpreter | Near-zero marginal |
| Human-written judgment | Small (10³) | Expert annotators | Expensive |

The second covers what execution cannot judge: architecture choices, "fine-tune vs prompt
vs RAG", eval design, when to stop. Pay for judgment, keep the volume low, and never let
synthetic data masquerade as it.

---

## 6. Curriculum-as-code

Each lesson is a versioned bundle:

```yaml
lesson: peft-vs-full-finetune
tier: C                          # dedicated GPU VM
dataset: lakefs://corpora/mechanics@v3.2   # pinned, immutable
base_model: Qwen/Qwen2.5-0.5B-Instruct
budget: {vram_gib: 16, wall_clock_min: 25, max_steps: 500}
graders:
  - loss_decreased: {min_relative_drop: 0.15}
  - eval_beats_base: {metric: exact_match, min_delta: 0.03}
  - no_leakage: {}               # same check the platform's CI runs
  - memory_within_budget: {}
```

Grade on **evidence, not prose**. And ship the graders as the same contracts the platform's
own pipeline runs — a learner who trips the leakage grader has just learned the thing that
actually matters.

---

## 7. Evaluation strategy

Working developers understand tests. They do not yet understand that models need
*evaluation*, which is statistical and never binary. Make that transition explicit.

| Layer | What it measures | Teaching point |
|---|---|---|
| Unit | Data contracts, tokenizer round-trip, shape assertions | Deterministic — this part *is* testing |
| Behavioural | Fixed prompt suite, exact-match / pass@k on held-out mutations | Metrics, not assertions |
| Comparative | Fine-tune **vs base model**, same prompts, same decode params | A number alone means nothing |
| Statistical | Bootstrap CIs over items; paired test on per-item deltas | A 1% delta on 200 items is noise |
| Segment | Per-mutation-family, per-language breakdown | Aggregates hide broken subgroups |
| Regression | Did fine-tuning *break* general capability? | Catastrophic forgetting |

Two rules to enforce in the platform, not in documentation:

1. **Always report against the base model.** "My fine-tune got 62%" is meaningless without
   the base model's score on the same suite.
2. **Never report a delta without an interval.** Bootstrap over items, 2,000 resamples,
   paired test. If the intervals overlap, the honest answer is "no measured difference".

---

## 8. Cost model

The economics live or die on tier mix, not on negotiated GPU price.

| Lever | Effect |
|---|---|
| Push lessons to tiers A/B | Largest single lever. A GPU-free lesson costs ~0 |
| Spot + enforced checkpointing | 60–90% off tier C/D |
| Small models for mechanics | 0.5B full FT at 3.11 GiB runs on the cheapest GPU sold |
| Hard wall-clock + max-steps | Caps the tail; runaway jobs are the usual bill shock |
| Scale-to-zero GPU pool | Pay only for queued work; accept ~2 min cold start |
| Per-learner budget with hard stop | Makes worst-case cost per seat *knowable* |

Publish a per-learner GPU-minute budget and enforce it. An unbounded free tier on
single-tenant GPU VMs has no floor.

---

## 9. What breaks at scale

Stated up front because each has an architectural answer, not an operational one.

| Failure | Answer |
|---|---|
| GPU cold start dominates short lessons | Warm pool of N idle nodes; batch tier-A jobs |
| One learner's OOM takes down a shared node | Single-tenant VMs (§1) — the reason for that decision |
| Dataset version drift breaks old lessons | Immutable pinned versions; never mutate in place |
| Checkpoint storage grows without bound | TTL on learner checkpoints; keep only best + last |
| Eval sets leak into the training corpus | Decontamination gate in CI, with hit counts reported |
| Spot preemption loses hours of work | Platform-enforced checkpointing, not learner-enforced |
| Silent host-RAM spill hides a bad config | Per-step `max_memory_reserved()` assertion |

---

## 10. Build order

1. **Tiers A + B, the dataset DAG, and the graders.** No GPU passthrough. This is already a
   complete product for roughly 70% of the curriculum, and it de-risks the hard part.
2. **The execution-verified mutation corpus.** The genuine differentiator, and it needs no
   GPU to build.
3. **Tier C**: one-VM-per-job GPU isolation, spot + checkpointing, hard budgets, warm pool.
4. **Tier D**: capstone, model registry promotion, learner-deployed inference endpoints
   (vLLM), which is the final "AI engineer" skill.

Resist building 3 first. It is the most interesting engineering and the least of the value.

---

## 11. Open questions

| # | Question | Why it changes the design |
|---|---|---|
| 1 | Arbitrary learner code, or declarative configs, in v1? | The single biggest cost and security fork (§1) |
| 2 | VoidCode pivot, or second product? | Decides whether the Phase 2/3 Spark + ranking work carries over or is shelved, and whether this doc moves repos |
| 3 | Cloud budget ceiling and target seats? | Sets the tier mix and whether tier D exists at launch |
| 4 | Are VLMs launch scope or later? | Multimodal roughly doubles preprocessing surface and pushes VRAM up a tier |
| 5 | Self-hosted GPUs, cloud, or hybrid? | Utilisation economics differ sharply; hybrid needs a scheduler abstraction from day one |
