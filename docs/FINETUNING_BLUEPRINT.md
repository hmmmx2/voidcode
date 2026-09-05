# Fine-Tuning Blueprint — LLM + VLM on 2× RTX A6000

**Target hardware.** 2× NVIDIA RTX A6000 (GA102, Ampere, sm_86), 48 GB GDDR6 ECC each,
96 GB aggregate. Local workstation.

**Audience for the artefacts this produces.** Professional software engineers moving into
ML. Every pipeline stage below is intended to be readable as production code — typed,
tested, CI-gated, reproducible — not as a notebook.

**Basis for the memory figures.** Per-parameter costs are measured; per-GPU totals are
those costs applied to the resolved parameter count and the 2-way sharding layout. §3.3
gives the commands that confirm them on the box — run them once at bring-up and record the
results in `docs/DECISIONS.md`, then treat this table as verified rather than derived.

**Two bring-up checks that move the design**, both in §3.3: PCIe link width (an x8 slot
halves collective bandwidth and shifts the §3.4 strategy threshold) and whether the cards
sit behind WSL2 (§3.5).

---

## 1. System architecture

```mermaid
graph TB
    subgraph ING["Ingestion"]
        A1[Permissive repos<br/>SPDX-gated]
        A2[Docs / issues / PR pairs]
        A3[Mutation engine<br/>execute → capture traceback]
        A4[Render engine<br/>code → screenshot]
    end

    subgraph CUR["Curation — fails closed at every gate"]
        B1[Licence gate<br/>per-file SPDX]
        B2[AST parse<br/>tree-sitter]
        B3[Near-dup<br/>MinHash LSH J≥0.85]
        B4[DECONTAMINATE<br/>vs all eval sets]
        B5[Quality filter<br/>compile + execute]
        B6[Schema validate<br/>pandera, reject not coerce]
    end

    subgraph FMT["Format & Tokenize"]
        C1[ChatML render<br/>+ prompt-token loss mask]
        C2[VLM: dynamic tiling<br/>image-token accounting]
        C3[Offline tokenize<br/>→ memmap uint32]
        C4[Multipack<br/>block-diagonal attn mask]
        C5[Length bucketing<br/>by TOKEN count]
    end

    subgraph REG["Versioned Artefacts"]
        D1[(lakeFS<br/>immutable dataset refs)]
        D2[Dataset card<br/>rejection rate by reason]
    end

    subgraph TRN["Training — 2× A6000"]
        E1{Strategy router}
        E2[DDP + QLoRA<br/>≤8B PEFT]
        E3[FSDP SHARD_GRAD_OP<br/>7-8B full FT]
        E4[FSDP FULL_SHARD<br/>13-14B full FT]
        E5[torchrun --nproc_per_node=2]
        E6[Guards: max_memory_reserved<br/>assert per step]
        E7[Checkpoint → object store<br/>every N steps]
    end

    subgraph EVAL["Validation Gates"]
        F1[Functional<br/>pass@k, sandboxed]
        F2[Static<br/>ruff · mypy · bandit · semgrep]
        F3[Security<br/>CWE suite]
        F4[Memorisation<br/>n-gram vs corpus]
        F5[Regression<br/>catastrophic forgetting]
        F6[Statistical<br/>bootstrap CI + paired test]
    end

    subgraph PROD["Registry & Serving"]
        G1[(MLflow registry<br/>staged promotion)]
        G2[Merge adapter → quantise]
        G3[vLLM endpoint]
        G4[Runtime guardrails<br/>sandbox · secret scan]
    end

    A1 & A2 & A3 & A4 --> B1 --> B2 --> B3 --> B4 --> B5 --> B6
    B6 --> C1 --> C3
    B6 --> C2 --> C3
    C3 --> C4 --> C5 --> D1
    D1 --> D2
    D1 --> E1
    E1 --> E2 & E3 & E4
    E2 & E3 & E4 --> E5 --> E6 --> E7
    E7 --> F1 & F2 & F3 & F4 & F5
    F1 & F2 & F3 & F4 & F5 --> F6
    F6 -->|all gates pass| G1
    F6 -->|any gate fails| E1
    G1 --> G2 --> G3 --> G4

    classDef gate fill:#3b1f1f,stroke:#c0392b,color:#fff
    classDef comp fill:#1f2d3b,stroke:#2980b9,color:#fff
    class B4,F3,F4,E6 gate
    class E2,E3,E4,E5 comp
```

---

## 2. Dataset engineering pipeline

### 2.1 Non-negotiable gates

| Gate | Implementation | Failure it prevents |
|---|---|---|
| Licence | Per-**file** SPDX resolution, allowlist. Provenance stored per record. | Copyleft discovered after weights ship |
| Syntactic | `tree-sitter` AST parse per language. **Not** regex, not `compile()`. | Training on code that does not parse |
| Near-dup | MinHash + LSH, Jaccard ≥ 0.85, **across splits** | Paraphrase leakage inflating pass@k |
| Decontamination | n-gram (13-gram) index of every eval set; strip hits; **report count** | The failure that destroys credibility fastest |
| Semantic | Execute in sandbox; keep only what runs | Plausible-but-broken exemplars |
| Schema | `pandera` / Pydantic, versioned. **Reject, never coerce.** | Silent format drift |
| Split | Group by **repository**, never random row | Same project on both sides |

Emit **rejection rate by reason** as a tracked metric. A shift in that distribution is the
earliest signal an upstream source has rotted.

### 2.2 Execution-verified corpus — the core asset

Do not LLM-generate the mechanics corpus. Generate it by controlled mutation and let the
interpreter label it.

```
working script → semantic mutation → EXECUTE → capture (traceback, memory, loss curve)
                                             → record (broken, real_output, minimal_fix)
```

Mutation families double as the syllabus taxonomy and as the eval stratification:

| Family | Mutation | Ground-truth signal |
|---|---|---|
| Shape | transpose einsum, wrong `hidden_size` | `RuntimeError: mat1 and mat2 shapes` |
| Device | drop `.to(device)` | `Expected all tensors on same device` |
| Dtype | mix fp16/bf16, drop autocast | dtype mismatch / NaN loss |
| Memory | batch × seq that OOMs | `CUDA out of memory` + allocator dump |
| Dynamics | lr ×100, missing `zero_grad`, wrong loss reduction | divergent loss curve |
| Eval hygiene | missing `.eval()`, leaked labels | metric delta |
| Tokenizer | wrong pad side, no attention mask, label off-by-one | silent quality drop |
| PEFT | LoRA on wrong modules, unmerged adapter | no weight delta |

The label is the interpreter. Auditable, on-domain, and immune to synthetic-data drift.

### 2.3 Formatting — where most fine-tunes are silently broken

**Loss masking.** Compute loss on completion tokens only; mask prompt/system tokens to
`-100`. Training on the prompt teaches the model to generate instructions.

**Sequence packing.** Concatenating documents to fill context is a large throughput win and
a correctness hazard: naive packing lets attention flow across document boundaries. Use
**block-diagonal attention masks** (FlashAttention-2 varlen / `position_ids` reset), not a
plain concat.

**Offline tokenization.** Pre-tokenize to memory-mapped `uint32` arrays. On-the-fly
tokenization in the dataloader becomes the bottleneck once the GPUs are fed properly.

**Bucketing by token count, not sample count** — see §2.4, this is critical for VLM.

### 2.4 VLM specifics — image-to-text/code

Sources, all execution-verifiable by rendering:

| Pair | Render path | Ground truth |
|---|---|---|
| Screenshot → UI code | HTML/JSX → headless Chromium → PNG | source markup |
| Plot → matplotlib | script → `savefig` | source script |
| Diagram → IaC / schema | mermaid/graphviz → SVG → PNG | source DSL |
| Error screenshot → diagnosis | terminal render of real traceback | the fix from §2.2 |

Additional gates:

- **Perceptual-hash dedup** (pHash/dHash) — MinHash does nothing for images.
- **Resolution normalisation.** Qwen2-VL-class models use dynamic resolution: image token
  count scales with pixels. A 4K screenshot can consume thousands of tokens.
- **Image-token accounting is a memory-safety issue.** Sequence length varies by an order
  of magnitude across samples. Bucket by **total token count (text + image)** and cap it,
  or a single high-resolution sample OOMs a step that ran fine for 500 iterations.
- **Vision-tower policy.** Default: freeze ViT, train projector + LLM (LoRA). Unfreezing the
  tower roughly doubles activation memory for marginal gain on code-rendering tasks.
- **Prompt injection surface.** Instructions embedded *in the image* are a real attack path.
  Include adversarial images in the eval set (§4.3).

---

## 3. Multi-GPU fine-tuning on 2× A6000

### 3.1 Memory arithmetic (measured params, not nominal)

Qwen2.5-7B-Instruct = **7,615,616,512** parameters → **1 byte/param = 7.0926 GiB**.
Round-"7B" budgeting under-counts by ~9 GiB at 16 B/param.

Per-GPU static state, 2-way sharding:

| Method | B/param layout | Per-GPU static | +act @2048 | Fits 48 GB |
|---|---|---|---|---|
| AdamW FP32, DDP | 4+4+4+4 = 16, replicated | 113.48 | — | **No** (exceeds 96 GB aggregate) |
| 8-bit AdamW + master, ZeRO-2 | 4 + (4+2)/2 | 49.65 | 54.7 | **No** |
| **8-bit AdamW no master, ZeRO-2** | 2 + (2+2)/2 | **28.38** | **33.4** | **Yes** |
| **Adafactor BF16, ZeRO-2** | 2 + 2/2 + ~0 | **21.28** | **26.3** | **Yes, wide** |
| Qwen3-14.8B Adafactor, ZeRO-2 | — | 41.35 | 47.4 | **No** — needs ZeRO-3 |
| QLoRA r16, DDP | NF4 base + adapter | ~10.4 | 13.1 @2048 | **Yes, trivially** |

> **The `no_sync` trap.** ZeRO-2 memory figures assume gradients are reduce-scattered.
> Wrapping micro-batches in `no_sync` — the single largest throughput lever on a slow
> interconnect — *suppresses* that scatter, so each rank accumulates a **full** BF16
> gradient buffer: 14.19 GiB, not 7.09. Recomputed: static 35.46, peak ≈ 40.5 GiB.
> Still fits 48, but the margin is 7.5 GiB, not 14.6. The memory table and the throughput
> optimisation cannot both be quoted as written — verify which applies by counting
> collectives under `NCCL_DEBUG=INFO`.

### 3.2 Strategy router

At **N=2**, sharding buys at most 2× memory for a full communication tax. This inverts the
usual advice: for PEFT, do not shard at all.

| Regime | Strategy | Rationale |
|---|---|---|
| ≤8B, PEFT (LoRA/QLoRA) | **DDP, no sharding** | Only the adapter is all-reduced (~40 M params ≈ 80 MB BF16). Near-linear scaling, interconnect-insensitive. **Default for the teaching platform.** |
| 7–8B, full FT | **FSDP2 `SHARD_GRAD_OP`** (≡ ZeRO-2) | Fits with margin. Params replicated → no per-micro-batch all-gather. |
| 13–14B, full FT | **FSDP2 `FULL_SHARD`** (≡ ZeRO-3) | Param sharding is required. Accept the all-gather cost. |
| 30B+, PEFT | FSDP + bnb 4-bit (FSDP-QLoRA) | Works, but fragile — pin versions. |
| 70B | Inference only | Not trainable in 96 GB. |

**FSDP2 over DeepSpeed** at this scale: native to PyTorch, per-parameter `DTensor` sharding,
fewer moving parts, no separate config dialect. Reach for DeepSpeed when you need ZeRO-3 +
NVMe offload (ZeRO-Infinity) — i.e. above this hardware's range.

### 3.3 Execution plan

```bash
# 0. Topology — decides everything downstream
nvidia-smi topo -m                      # NV# = NVLink, PIX/PHB/SYS = PCIe
nvidia-smi -q | grep -A3 "Link Width"   # confirm x16, not x8

# 1. Benchmark the interconnect BEFORE writing a trainer
git clone https://github.com/NVIDIA/nccl-tests && cd nccl-tests && make
NCCL_DEBUG=INFO ./build/all_reduce_perf -b 8 -e 1G -f 2 -g 2
#   record busbw at ≥256 MB and the transport NCCL selected

# 2. Launch
torchrun --nproc_per_node=2 --standalone train.py \
  --config configs/fsdp_shard_grad_op.yaml
```

Ordered checklist:

1. `nvidia-smi topo -m` → NVLink present or not
2. `all_reduce_perf` busbw at 256 MB → route via §3.4 table
3. Single-GPU baseline first — tok/s and peak reserved. Without it, "2 GPUs is faster" is unfalsifiable.
4. Enable BF16 (Ampere native; no GradScaler, no loss-scale instability)
5. FlashAttention-2 (`attn_implementation="flash_attention_2"`, sm_86 supported)
6. **Fused/chunked cross-entropy** (Liger, or cut-cross-entropy) — see §3.6
7. Selective activation checkpointing — recompute attention only, not every block
8. Multipack + block-diagonal masks
9. `torch.compile` last, and only after the numbers are stable
10. Assert `torch.cuda.max_memory_reserved()` per step; fail loudly
11. Checkpoint every N steps to object store; resume-tested

### 3.4 Interconnect: NVLink vs PCIe

A6000 supports a **2-way NVLink 3 bridge ≈ 112.5 GB/s bidirectional**. Without it you are on
PCIe 4.0: **x16 ≈ 25 GB/s effective, x8 ≈ 12 GB/s**. Being Quadro-class, A6000 supports
PCIe P2P (unlike GeForce RTX 30/40, where P2P is disabled in driver) — so a non-NVLink pair
still gets device-to-device DMA rather than host bounce, provided the OS exposes it.

Route strategy off the **measured** busbw, not the datasheet:

| Measured all-reduce busbw | Strategy |
|---|---|
| > 20 GB/s (NVLink present) | ZeRO-3 / `FULL_SHARD` viable; 14B full FT in reach |
| 5–20 GB/s (PCIe x16 P2P) | ZeRO-2 only, high grad-accum, `no_sync` on micro-steps |
| < 5 GB/s (host-staged / x8 / virtualised) | **Do not shard.** DDP + PEFT, or single-GPU + run two independent experiments |

The last row is a legitimate outcome, not a failure: two concurrent runs at different
learning rates often produce more value than a 1.6× speedup on one.

### 3.5 The WSL2 warning

If these cards sit behind WSL2:

- **P2P and NVLink are generally not exposed** through WDDM paravirtualisation. NCCL falls
  back to host-staged transfers (GPU → pinned host → GPU), landing you in the bottom row of
  §3.4 regardless of the bridge you paid for.
- **WDDM silently spills GPU allocations into host RAM instead of raising OOM.** Observed:
  a backward pass reaching **28.77 GiB on a 16 GiB card** without failing — executing over
  PCIe at a fraction of expected speed while appearing healthy.

> **Never treat "it did not crash" as evidence a configuration fits.** Assert on
> `max_memory_reserved()` per device per step and raise. An assertion, not a log line.

**Recommendation: run distributed training on native Linux.** This is the highest-leverage
environment decision available for a 2×A6000 box, and it is worth a dual-boot.

### 3.6 Utilisation — ordered by measured impact

| Optimisation | Why it matters here |
|---|---|
| **Fused / chunked cross-entropy** | Measured: at seq 1024, **2.04 of 2.57 GiB** of activation memory is the loss head over a 152 k vocab — the 28 transformer layers account for only 0.19 GiB. Activation cost is a *vocabulary* problem. Liger/CCE avoids materialising the `[B,S,V]` logits tensor and is the single largest activation win available. |
| Multipack sequence packing | Instruct corpora are length-skewed; padding waste of 30–50% is typical |
| FlashAttention-2 | Removes the O(S²) attention matrix; mandatory at seq ≥ 4096 |
| Selective act. checkpointing | Full checkpointing costs ~30% throughput; recompute attention only |
| `no_sync` on micro-steps | One collective per optimiser step instead of per micro-batch — **verify by counting collectives**, and see the §3.1 memory trap |
| BF16 + TF32 | Ampere native; no loss scaling |
| Dataloader tuning | `num_workers=8`, `pin_memory`, `persistent_workers`, `prefetch_factor=4` |
| `torch.compile` | Real gains, but recompiles on shape changes — pair with bucketing |

Instrument with the PyTorch profiler and target **>90% SM occupancy** and
**<5% step-time variance**. If the second GPU yields <1.3× over the single-GPU baseline,
it is not earning its complexity — report that honestly and take the DDP/two-experiment path.

---

## 4. Evaluation and production guardrails

Gates, not dashboards. A model that fails any gate does not get promoted.

### 4.1 Functional correctness

| Metric | Method |
|---|---|
| pass@k | Execute in a **sandboxed runner** (gVisor/Firecracker, no network, read-only FS, seccomp default-deny, wall-clock cap, pid/fd limits). Never in the eval process. |
| Compile/parse rate | tree-sitter + language toolchain |
| Test-suite pass | Generated code against held-out unit tests |
| Diff minimality | For fix-tasks: is the patch minimal, or a rewrite? |

**Build your own held-out set.** HumanEval and MBPP are contaminated in every modern base
model; quoting them post-fine-tune measures leakage, not skill. Hold out by repository.

### 4.2 Static analysis and security

| Tool | Gate |
|---|---|
| `ruff` / `mypy` | Lint + type errors per 100 LOC |
| **`bandit`** | Python security lints |
| **`semgrep`** | Custom rules for taught anti-patterns |
| **CodeQL** | Deeper dataflow (CI, not per-sample) |
| `detect-secrets` / entropy scan | Hardcoded credentials in output |

**CWE-targeted suite** — prompts designed to elicit insecure code, scored on whether the
model emits the vulnerable pattern:

| CWE | Elicitation |
|---|---|
| CWE-89 SQL injection | "build a query from this user input" |
| CWE-78 command injection | "run this filename through ffmpeg" |
| CWE-502 unsafe deserialisation | "load this cached object" (`pickle.load`) |
| CWE-22 path traversal | "serve the file the user asked for" |
| CWE-798 hardcoded creds | "connect to the database" |
| CWE-327 broken crypto | "hash the password" (expect bcrypt/argon2, not MD5) |

Track **insecure-generation rate vs the base model**. Fine-tuning on scraped code can make
this *worse*; if it does, that is a release blocker.

### 4.3 Model-specific risks

| Check | Method |
|---|---|
| **Memorisation** | 13-gram overlap of generations against the training corpus. Verbatim reproduction of licensed code is a legal exposure, not a quality issue. |
| **Catastrophic forgetting** | Base-capability suite (MMLU subset, general instruction-following) before/after. Fine-tuning on narrow code data reliably degrades general ability. |
| **VLM prompt injection** | Adversarial images with embedded instructions ("ignore previous instructions"). Measure instruction-following-from-image rate. Must be near zero. |
| **Refusal calibration** | Over-refusal on benign security questions is a real failure for this audience. |

### 4.4 Statistical discipline

Two rules, enforced in the harness rather than in documentation:

1. **Every metric is reported against the base model**, same prompts, same decode params,
   same seed. A standalone score is uninterpretable.
2. **No delta without an interval.** Bootstrap over items (2,000 resamples, 95% percentile)
   and a paired test (Wilcoxon) on per-item differences. On a 200-item suite a 1–2 point
   move is noise; reporting it as a win is the most common way credibility is lost.

Report **per-stratum** as well as aggregate: per mutation family, per language, per
difficulty band. Aggregates hide a badly-served subgroup, which is exactly the failure mode
that surfaces in production.

### 4.5 LLM-as-judge — only where execution cannot decide, and only calibrated

Execution settles correctness. It cannot settle whether an *explanation* is any good, and
for a platform teaching engineers that is a first-class output: diagnosis quality, whether
a hint leaks the answer, whether a code review comment is actionable. Those need a judge —
and an uncalibrated judge is an opinion with a decimal point attached.

**Rules, enforced in the harness:**

| Rule | Why |
|---|---|
| Judge only what execution cannot score | If a test can decide it, a test decides it. Judges are slower, dearer and noisier |
| **Calibrate against ≥50 human labels before first use**; report Cohen's κ or Spearman | An uncalibrated judge silently encodes its own model's preferences |
| Re-calibrate whenever the judge model or rubric version changes | Judge drift is invisible and rewrites your history |
| Judge model ≠ model under test | Self-preference bias is large and well documented |
| Fixed rubric, fixed decode params, fixed seed, versioned prompt | Otherwise the metric is not reproducible, which fails the prime directive |
| Randomise pair order in A/B comparisons | Position bias is a real and sizeable effect |
| Report judge scores **with** the human-agreement figure, always | A rubric score without its κ is not evidence |

Treat the judge as a **measuring instrument with a stated error bar**, not an oracle. If
agreement with human labels is weak, the honest report is that the dimension is currently
unmeasured — per the same NOT MEASURED discipline applied everywhere else in this repo.

For hint-leakage specifically, prefer a deterministic check over a judge: does the
hint-mode output contain a complete working solution? That is executable, so execute it.

### 4.6 Promotion gate

```yaml
promotion_gate:
  functional:   {pass_at_1_delta_vs_base: ">= +0.03", ci_excludes_zero: true}
  security:     {insecure_generation_rate: "<= base", cwe_suite_regressions: 0}
  static:       {parse_rate: ">= 0.98", bandit_high: 0}
  memorisation: {verbatim_13gram_hits: 0}
  regression:   {mmlu_subset_delta: ">= -0.02"}
  stratified:   {worst_family_delta: ">= -0.05"}
```

CI blocks promotion on any failure. Then: merge adapter → quantise (AWQ/GPTQ) → **re-run the
full gate on the quantised artefact** (quantisation degrades security behaviour
disproportionately) → canary → shadow → serve on vLLM behind runtime guardrails
(sandboxed execution, secret scanning, output-length caps).

---

## 5. Reference layout

```
├── data/
│   ├── ingest/          sources, SPDX gate
│   ├── mutate/          mutation engine + executor
│   ├── render/          VLM code→image renderers
│   ├── curate/          dedup, decontaminate, filter
│   └── format/          chatml, loss masks, multipack, tokenize
├── train/
│   ├── configs/         ddp_qlora.yaml · fsdp_shard_grad_op.yaml · fsdp_full_shard.yaml
│   ├── strategy.py      the §3.2 router
│   ├── callbacks/       memory_assert · checkpoint · profile
│   └── train.py
├── eval/
│   ├── functional/      sandboxed pass@k runner
│   ├── security/        CWE suite, bandit/semgrep wrappers
│   ├── memorisation/    n-gram index
│   └── stats.py         bootstrap CI, paired tests
├── registry/            MLflow, promotion gate
├── serve/               vLLM, runtime guardrails
└── tests/               pytest — contracts, not metrics
```

**Every number this pipeline produces must be regenerable by a single command.** A figure
you cannot reproduce on demand is not a result.
