# Provenance of every published number

**What this is.** One place that says, for each measured figure in this repo: what it measures, on
which artifact and hardware, over how many runs, with which interval, and whether it is safe to
repeat outside the document it lives in. Compiled 2026-09-13 by reading the artifacts, not the
summaries of them.

**Why it exists.** A figure was repeated with a run count that belonged to one metric and a
confidence interval that belonged to another. Both halves were real and the sentence was false.
Every table here therefore keeps the value, its denominator and its interval in the same row, and
names the file each came from.

**The rule this document enforces:** a number is quotable only with the qualifier in its row. A
value separated from its artifact, its run count or its scale is not a weaker claim — it is a
different one.

Enforced by `tests/test_reported_numbers_are_attributable.py`.

---

## How to read this

**Three verdicts.**

| verdict | meaning |
|---|---|
| **SAFE** | Reproduces from a stored artifact. Repeat it with the qualifier in its row |
| **QUALIFIED** | Real, but false without a specific caveat stated alongside it |
| **NOT SAFE** | Retracted, superseded, underpowered, unattributable, or forbidden by the file that records it |

**Two interval scales, and they are not interchangeable.** Where a figure is a mean over repeated
runs of a fixed scenario set, two different intervals answer two different questions:

- **run-to-run** — a t interval on the per-run means. Bounds the mean *on these fixed scenarios*.
  This is rerun stability.
- **per-scenario** — a Wilson interval at the scenario count. Bounds *generalisation to new
  scenarios*. This is the wider, honest one.

A Wilson interval over runs × scenarios pooled together is **neither**. Repeated runs of one
scenario set are not independent trials, so pooling reports a confidence it has not earned. For
localisation it reads `[0.774, 0.846]`, which sits close to the run-to-run interval and is not the
same claim.

---

## 1. Models

There is no single model. Four artifacts, and the one the tutor evaluation measures is not the one
the fine-tuning work produced.

| role | model | source |
|---|---|---|
| **What every `READINESS.md` eval number measures** | **stock `Qwen/Qwen3.5-9B`**, snapshot `c202236235762e1c871ad0ccb60c8ee5ba337b9a`, **no adapter** | `docs/READINESS.md:240` |
| QLoRA SFT base (the 7B tutor) | `Qwen/Qwen2.5-7B-Instruct` | `llm/configs/training_config.yaml:8`; `llm/outputs/final_model/adapter_config.json` |
| GRPO policy base (the 30B) | `Qwen/Qwen3-Coder-30B-A3B-Instruct` — MoE, ~30B total / ~3B active per token | all four `artifacts/*/adapter_config.json` |
| 30B serving and rollout build | `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` — third-party AWQ, **not quantized here** | `scripts/pod_serve_rl.sh:30` |
| First GRPO policy | `Qwen/Qwen2.5-Coder-1.5B-Instruct` | `scripts/train_grpo.py:772`; `scripts/pod_grpo.sh:69` |

> **The single largest hazard in this document.** `docs/READINESS.md:240-242` states the provenance
> plainly: stock 9B, **no adapter**, SGLang fp8, local RTX 5060 Ti. Every tutor gate therefore
> measures the prompt, routing and withholding layer — the scaffold — and **nothing in
> `READINESS.md` measures the 30B, the GRPO policy, or the QLoRA fine-tune.** The tutor figures and
> the RL figures must never appear in one series.

---

## 2. Hardware

| fact | value | source |
|---|---|---|
| Cloud GPU actually used | **NVIDIA A40**, `46068 MiB`, driver 570.195.03 | `docs/rl/probe-a40_x2_secure.json`, `probe-a40_x4_secure.json` |
| A40 **usable** VRAM, measured | **44.43 GiB, not 48** | `docs/rl/METRICS.md:316` |
| Local card | **RTX 5060 Ti**, `16311 MiB` = 15.93 GiB, Blackwell, WDDM, driver 591.86 | `docs/rl/probe-rtx5060ti_x1_local.json`; `docs/DECISIONS.md:26` |
| Provider | **RunPod only.** Pods `z6h0zfdo3wd7nc` (2×A40), `idh7wv10e4vqk2` (4×A40, later flagged faulty by RunPod) | `docs/rl/PLAN.md:1`; `docs/rl/p0-evidence/README.md:28`; `docs/rl/METRICS.md:280` |
| A40 matmul, bf16 8192² | 106.05 / 107.33 TFLOP/s | the two probe files |
| Local FP8 | 97.4 TFLOP/s e4m3, **2.01×** over BF16's 48.5 | `docs/rl/DECISIONS.md:475-479` |
| NCCL all-reduce busbw | **7.72 GB/s over SHM** — supersedes an earlier 22.11 GB/s P2P reading | `docs/rl/DECISIONS.md:311-323`; `docs/rl/METRICS.md:73` |

**Standing policy** (`docs/rl/DECISIONS.md:492-495`): the local 5060 Ti is for correctness, kernels
and iteration and is **"never a reported number"**; only L40S-class hardware was designated for
comparison tables.

**Never measured:** A6000, A100, H100, L40, L40S, RTX 6000 Ada. They appear only in the RunPod price
table (`docs/rl/PLAN.md:50-59`). `docs/MEMORY_AUDIT.md` caveat 1 is explicit — *"No A6000 was
measured"*; every 48 GiB figure there is estimator-derived. **Not in the repo at all:** Lambda,
Vast.ai, CoreWeave, Paperspace.

**Two memory figures not to quote.** `45498 MiB` appears in ~16 run logs as the unlabelled second
field of a header line no tracked script produces, printed *before* the model loads — not
attributable to consumed VRAM. `41049 MiB` is **not in the repo**; the only hits for that digit
string are tokenizer IDs.

---

## 3. Serving

**`/v1/models` on this API cannot verify anything.** It is a hardcoded literal
(`apps/api/src/main.py:2162-2174`):

```
id: "voidcode-ai-v5.2"    owned_by: "voidcode-ai"    architecture: "hybrid"
```

It names no model and reads no state, so it returns the same string whatever is loaded. The real
served-model identity comes from the **upstream** backend's own `/models`, which
`backend_registry.served_model()` records and `/health` surfaces — the mechanism added after
`/health` was caught reporting a 7B while a 30B served.

**All 30 scored evidence files record `provenance.served_model` as the literal string
`"whatever /v1/chat/completions serves"`.** The artifact is not in the evidence; only
`READINESS.md`'s prose provenance block asserts it.

| stack | serves | source |
|---|---|---|
| SGLang `v0.5.9-cu130`, fp8, `kv-cache-dtype fp8_e5m2`, ctx 16384 | `Qwen/Qwen3.5-9B` — the eval path | `docs/READINESS.md:241`; `docker-compose.sglang.yml:96-98` |
| vLLM + AWQ, `--enable-lora --max-lora-rank 32` | 30B base + `rl` adapter | `scripts/pod_serve_rl.sh:30-36` |
| vLLM `quantization="compressed-tensors"` | the 7B W4A16 artifact | `apps/api/src/vllm_engine.py:74,145` |

**Naming defect.** `llm/outputs/awq_model/` **is not AWQ.** It was produced by `GPTQModifier`,
scheme `W4A16`, format `pack-quantized` (`docs/rl/model-chain-evidence/awq_artifact.txt`). Only the
30B artifact is genuinely AWQ, and a third party built it.

**Quantization is split by purpose and the two never mix:** NF4 is training-only, AWQ/W4A16 is
serving-only.

---

## 4. Fine-tuning

### QLoRA SFT, 7B — SAFE

`llm/configs/training_config.yaml`, `llm/scripts/train.py`, log `llm/logs/training_20260310_213004.log`:

- r=16, α=32, NF4 4-bit + bf16 compute, 7 target modules, `paged_adamw_32bit`, lr 1e-4, effective
  batch 32 (1 × 32 grad accum), gradient checkpointing
- **40,370,176 trainable parameters (0.92%)**
- **1,860 examples**, split **1,674 / 93 / 93**; modes debug 760, teaching 900, followup 200
- EXPLAIN is prompt-engineered, **not** fine-tuned

**Three internal disagreements — do not present these as settled.** The saved adapter has
`lora_dropout 0.1` where the config says `0.05`. The last run used `max_seq_length 1536` where the
config says `1024` (`docs/MEMORY_AUDIT.md:115` records this). `llm/outputs/checkpoint-108/trainer_state.json`
is a different run entirely — 2 epochs, batch 2, 108 steps. And `llm/data/validation_report.txt`
validates a **2,000**-example corpus with a different mode split, not the 1,860 that were trained.

### GRPO / RLVR, 30B — SAFE

`scripts/train_grpo.py`, `rl/grpo.py`; config `docs/rl/METRICS.md:867-868`:

- LoRA r=32, α=64, **attention-only** (`q,k,v,o`), base loaded 4-bit NF4
- 175 steps, group 16, 2 problems/step, `max_new 1024`, lr 1e-6, β 0.04
- **339 train problems / 120 in-domain holdout**, band-filtered from 2,000 DeepCoder problems
- Trainable **13.4M of 15.59B (0.086%)** at r=16 (`docs/rl/run-logs/grpo30b.log:14`)

### PPO and DPO

**PPO** is implemented (`rl/ppo.py`) and **never run** — `docs/rl/OPEN_QUESTIONS.md:52`: *"Not
built. GRPO only."* No PPO run artifact or hyperparameters exist. **DPO is not in the repo** as
anything run; roadmap prose only (`docs/specs/FUTURE_IMPLEMENTATION.md:462`).

---

## 5. Every evaluation number

### 5a. Tutor gates — `docs/READINESS.md`

Artifact for **all** rows: stock Qwen3.5-9B, no adapter, local RTX 5060 Ti (§1).

| metric | value | run count | intervals / spread | corrected or retracted | verdict |
|---|---|---|---|---|---|
| Bug localisation, DIAGNOSTIC surface | **0.813** | 51 × **9 runs** (v6+v7+v8) | range 37–45; **run-to-run [0.778, 0.847]**, **per-scenario [0.675, 0.890]** | yes — was recorded as 0.647 while the headline said 0.817 (`:287`) | **SAFE**, PASS vs ≥0.75 |
| Bug localisation, same metric, smaller pool | **0.817** | **6 runs** (v6+v7) | [0.695, 0.898] **per-scenario** (n=51) | supersedes an inflated 0.647 / 0.608 | **SAFE** as a six-run figure |
| Localisation, HINT surface | 0.150 | 51 | 7–9 | — | QUALIFIED — **not a gate**; the opening withholds line numbers by design |
| **JOINT** — routed correctly *and* localised | **0.761** | 51 × 6 runs | [0.632, 0.860] **per-scenario**; **run-to-run [0.712, 0.811]** | — | **SAFE** as a **FAIL** vs ≥0.80 |
| Routing accuracy, end to end | **0.933** | 75 | no variance | ↑ from 0.707 | **SAFE**, PASS vs ≥0.90 |
| Routing, debug recall | **0.902** | 51 | 46,46,46 | ↑ from 0.569 | **SAFE**, PASS marginal |
| Reasoning **never** reaches level 4 | 0.782 | 51 × 9 runs | 8–14 at L4 | ↑ from a mis-scored 0.255 | QUALIFIED — **FAIL** vs ≥0.98, and `0.782 = 1 − 0.218`; one metric, not two |
| Reasoning **reaches** level 4 | **0.218** | **9 runs** | — | **RETRACTED — published as 0.745** (`:74`, `:540`) | **NOT SAFE** except as the correction |
| Opening disclosure level ≤ 1 | 0.810 | 48 × 9 runs | 35–44 | ↑ from 0.204; was published as 0.875 | QUALIFIED — FAIL, blocking |
| Opening disclosure level = 0 | 0.285 | 48 × 9 runs | 11–18 | ↑ from 0.079 | QUALIFIED — FAIL, blocking |
| Multi-bug localisation recall | 0.540 | 15 | 0.467–0.567 | — | QUALIFIED — FAIL, marginal |
| No invented code, visible answer | 0.957 | 51 | 47–51 | — | QUALIFIED — FAIL inside noise |
| No invented code, displayed reasoning | 0.706 | 47 | 29–38 | — | QUALIFIED — FAIL |
| Bug count accuracy | 0.521 | 48 | 24–26 | — | QUALIFIED — FAIL |
| Responses echoing >50% of source | 0.431 | 3 runs | 22,23,21 | was 0.752 | **SAFE** as an improvement |
| Teaching, all checks | 0.833 | **6** | 4–6 | — | **NOT SAFE** — underpowered |
| Explain, all checks | 0.840 | **5** | 4–5 | — | **NOT SAFE** — underpowered |
| Answer leak rate (binary) | — | — | — | **RETIRED**, superseded by the ladder | **NOT SAFE** |

### 5b. GRPO / RL results — `docs/rl/`

Measured before pod `mg5ku6g5kfcw77` was lost; all artifacts survive.

| metric | value | n | against | verdict |
|---|---|---|---|---|
| Holdout `mean_case_fraction`, in-domain | **0.5680 → 0.6385, +0.0705** | **120** held-out DeepCoder problems | noise floor **sd 0.0127** (3 frozen-policy evals) — the effect is ~5.5× the floor | **SAFE** (`docs/rl/METRICS.md:887,892`) |
| Dead groups | **72% → 12.9%** | — | — | **SAFE** (`docs/rl/RESULT.md`) |
| Transfer to the 60 authored ML problems | **−0.67 SE** — no transfer | 60 | — | **SAFE** as a negative result (`docs/rl/METRICS.md:890`) |
| `holdout_greedy_solved` | 59–68, **sd 4.5 of 120 on an unchanged policy** | 120 | — | **metric DISCARDED** — quotable only as the discard (`:901`) |
| Training signal lost to grading stalls | 28 of 350 groups (~8%) | — | — | **SAFE** (`:923`) |
| Step cost model | 559 s/step at 32 completions — backward **88%**, generation 10%, grading 0.4%; ≈15.4 s per completion; 175 steps ≈ **26 h** on one A40 | — | — | **SAFE** (`:984`) |
| Band filtering | 2,000 DeepCoder problems → 459 usable (`in_band_fraction` 0.2295), 285 always-solved | 2,000 | — | **SAFE** (`data/deepcoder-band-30b-templated.json`) |

### 5c. Ranking — `docs/METRICS.md`, `docs/RANKING_*.md`

| metric | value | cohort | interval | verdict |
|---|---|---|---|---|
| NDCG@10, **eleven-feature** LambdaMART | **0.2143** | 60 eval learners, 11,267-problem catalogue, cutoff 2026-07-15 | **[0.1590, 0.2697]** | **QUALIFIED** — "eleven-feature" is mandatory (see below) |
| NDCG@10, popularity baseline | **0.0511** | same | [0.0261, 0.0816] | **SAFE** — CI lower bound clears the baseline ~3× |
| NDCG@5 | 0.1467 vs popularity 0.0497 | same | — | SAFE |
| Recall@100 | **0.616** vs popularity 0.190, difficulty-sorted 0.009 | same | — | SAFE |
| NDCG@10, all-11 ablation row | **0.2584**; removing `catalog_popularity` alone drops it to **0.0367** | **40–120** learners, seed 20260812 | — | QUALIFIED — **a different cohort** from the 0.2143 row; never merge |
| Sparse-history learners | **0.1272 [0.1045, 0.1523]** vs overall 0.1888 — **32.6% below**, interval excludes the mean | 700 learners | shown | **SAFE**, and a negative finding |
| Sparse bucket vs popularity | 0.1272 vs 0.0276 — **4.6×** | same | — | SAFE |
| Personalisation | mean top-10 overlap **4.52 of 10**; 0 of 780 pairs identical | 40 learners | — | SAFE |
| Tie-break defect, found and fixed | 0.3142 in row order vs **0.0200** shuffled — **94% inflation** | 11,272 candidates, 12 distinct scores | — | **SAFE as a methodology catch; 0.3142 is NOT SAFE as a result** |

> **Mandatory qualifier.** `docs/RANKING_DESIGN.md:138-148` holds a second *measured* table where
> LambdaMART scores NDCG@10 **0.0059** and loses to popularity (0.1757) by 30×. That is the
> **nine**-feature model — `catalog_popularity` and `concept_recency_days` are absent from it
> (`:159`) — and the ablation shows the first carries most of the difference. It is now marked
> SUPERSEDED in place, because it is the evidence for why the feature set grew.

### 5d. Throughput

**Training tok/s and generation tok/s are not comparable.** 411.9 / 383.1 / 1049.6 / 500.1 are
training (tokens through fwd+bwd); everything else is generation.

| value | what it measures | verdict |
|---|---|---|
| **411.9 tok/s** | QLoRA training, 7B, seq 1024, **local RTX 5060 Ti** | QUALIFIED — name the card. `docs/METRICS.md:189`: **"not a valid baseline for A6000 throughput comparisons"** |
| 383.1 tok/s | same at seq 2048 | same caveat |
| 1049.6 tok/s | DDP 5.75B Adafactor training on A40 (at 41.01 GiB/dev) | SAFE |
| 500.1 tok/s | 7.6B single-GPU A40 training, fits at 37.17 GiB | SAFE |
| 90.4 / 161.2 / 254.0 / 405.2 / **619.9** tok/s | 30B AWQ generation at concurrency 1 / 2 / 4 / 8 / 16 on A40, zero failures | SAFE — same server, different concurrency |
| 1129.3 / 4699.8 tok/s | 1.5B generation, vLLM per-prompt vs batched | SAFE — same model, different submission pattern |
| 356.7 tok/s | `hf_generate` rollout baseline, 1.5B, A40 | SAFE |
| 18.6 tok/s | measured on the local card | SAFE |
| 157.1 tok/s | 7B W4A16 under vLLM 0.11 | QUALIFIED — *"a small-batch latency-shaped figure, not a sustained throughput benchmark"* |
| **2.4 tok/s** | 7B W4A16 through transformers eager | **NOT SAFE** — `generation_test.md:30`: *"Do not quote 2.4 tok/s anywhere."* |
| **730 tok/s** | 1.5B 8-bit AdamW | **NOT SAFE** — **discarded** as WDDM-spill-contaminated (`MEMORY_AUDIT.md:527`) |
| **15.1 / 1295.7 tok/s, "85.8×"** | 30B eager vs vLLM | **NOT SAFE** — source comments only, no artifact |
| ~80–120 / ~10–20 tok/s, "5–8×" | spec-document estimates | **NOT SAFE** — projections, never measured |

---

## 6. Data and ranking pipeline

| fact | value | source |
|---|---|---|
| Rows fetched from the Codeforces API | **2,341,061** | `docs/METRICS.md:203` |
| Rows **surviving to silver** | **2,296,409** (614 MB NDJSON landing zone, 301 contests + 1,000 learner histories) | `docs/METRICS.md:206`, `:40`, `:204` |
| Spark throughput | **9,241 rows/s**, 248.5 s wall clock, **10 cores**, WSL2 | `docs/METRICS.md:41`, `:216` |
| Learners with mastery vectors | **117,453** | `docs/METRICS.md:42` |
| Catalogue coverage | **11,284 of 11,311 (99.8%)**; concepts **67 of 80** | `docs/METRICS.md:43`, `:218` |
| Warehouse | 170 MB Parquet, snappy; **25 columns**, all nine §4.3 features populated | `docs/METRICS.md:220-226` |
| Eval cohort | **20,537 learners** (≥3 pre- and ≥3 post-cutoff) — **learners, not rows** | `docs/RANKING_DESIGN.md:123` |
| Train/eval split | **1,056,303 / 264,079 pairs**, median 6 post-cutoff problems | `docs/RANKING_DESIGN.md:126-127` |
| Ranker | **LightGBM LambdaMART**, `objective=lambdarank`, **11 features** | `features/ranking.py:48-71`; `models/ranker_demo.txt:7` |
| Calibration | 5-fold isotonic over **1,320,382** out-of-fold rows; cold-start ruled out at 1,996 (0.15%) | `docs/METRICS.md:86`, `:92` |
| Rasch 1PL | held-out log loss **0.22661**; Spearman **0.4864** overall / 0.6627 ≥50 obs / **0.8730** ≥1000 | `docs/METRICS.md` |
| Stack | **pyspark 3.5.3** pinned, embedded Derby Hive metastore | `features/requirements.lock.txt:27`; `sql/session.py` |

**Scale honesty the repo states itself.** `sql/session.py:22-24` — the embedded metastore *"is not a
shared catalog in any operational sense."* `docs/DATA_SOURCES.md:47` — VoidCode has **zero** real
learner submissions; every figure above is Codeforces public data.

**Not in the repo:** XGBoost. **Not computed anywhere:** MRR as a ranking metric (only a teaching
content item, `content/problems/mean-reciprocal-rank.yaml`). **Does not exist:**
`docs/RISK_REGISTER.md` — `docs/METRICS.md:101` records risk-register rows with a backing artefact
as **0, NOT MEASURED**.

---

## 7. Infrastructure

| component | fact | source |
|---|---|---|
| Databases | **Postgres 16-alpine** + **Redis 7-alpine**, both pinned; async SQLAlchemy 2.0 + asyncpg | `docker-compose.yml:16-37`; `apps/api/src/database.py` |
| Migrations | **20 Alembic revisions**, `alembic upgrade head` runs in CI | `apps/api/alembic/versions/`; `.github/workflows/ci.yml:83-85` |
| Code sandbox | **Judge0 CE 1.13.1** pinned, 2 services, `privileged: true` for isolate, loopback-bound, `ALLOW_ENABLE_NETWORK=false`, per-process time+memory limits, **its own** Postgres + Redis | `docker-compose.yml:64-164` |
| Judge0 latency | p95 **897 ms** at 100 concurrent, **19 ms** at 10 | `docs/METRICS.md` |
| CI | **4 GitHub Actions workflows** — `ci.yml` (api / ml-tree / web), `containers.yml`, `desktop.yml` (3-OS matrix, licence gate, SBOM), `release.yml` | `.github/workflows/` |
| Tests | **88 test files, ~1,109 test functions** across `tests/` and `apps/api/tests/` | counted; `pytest.ini` |
| Coverage | **41.27%** against a `--cov-fail-under=40` floor | `docs/METRICS.md`; `ci.yml:163` |
| Containers | **6 compose files, 4 Dockerfiles**; nginx `least_conn` over 3 GPU replicas | `nginx.conf:31-35` |
| Kubernetes | manifests **exist** — Deployment, Service, HPA 2–4, Ingress, 2 NetworkPolicies, Kustomization — and have **never been applied to a cluster**; the deploy job is gated `if: false` | `deploy/base/`; `.github/workflows/containers.yml:125-135` |

> **Say "authored", never "deployed".** `containers.yml:125-128` states it outright: *"`deploy/base`
> has never been applied to a cluster — kubectl is available in CI but no cluster was reachable."*

**Not in the repo:** Terraform, Helm, Skaffold, CloudFormation, Pulumi, CDK, Bicep, any second CI
system, any vector database, SQLite, and any JS test runner for the web app
(`.github/workflows/ci.yml:168-170` says so outright).

---

## Welded numbers — pairs that must never be combined

The failure mode this document exists for: two real numbers, one false sentence.

1. **0.813 + "95% confidence interval."** `READINESS.md:287` gives 0.813 a run count and a range,
   **no CI**. The `[0.695, 0.898]` beside it belongs to **0.817** — a six-run pool — and is a
   per-scenario interval. 0.813's own intervals are `[0.778, 0.847]` run-to-run and
   `[0.675, 0.890]` per-scenario.
2. **0.813 + any trained model.** It measures stock Qwen3.5-9B with no adapter.
3. **0.782 and 0.218 as two metrics.** "Never reaches level 4" and "reaches level 4" — complements
   of one metric, both 9 runs.
4. **Three different "NDCG@10" values.** 0.2143 (60 learners, 11 features), 0.2584 (40–120
   learners, 11 features), 0.0059 (9 features, loses to baseline). Different cohorts, different
   models.
5. **411.9 tok/s + a server card.** It is a local RTX 5060 Ti training figure, and the repo forbids
   it as an A6000 baseline.
6. **2,296,409 and 2,341,061.** Surviving-to-silver versus fetched.
7. **20,537 as a row count.** It is a count of *learners*.
8. **Kubernetes manifests + "deployed."**

---

## Retracted or superseded — never quote as current

Each row gives the corrected value. Several of these were published before correction.

| retracted value | what it claimed | corrected value | source |
|---|---|---|---|
| **0.745** | Reasoning reaches level 4 | **0.218** — 125 of 225 hits were scorer artefacts: echoed student code, the model reciting `PE_DEBUG_PROMPT`'s mandated opening, and quoted punctuation. A v4 figure carried forward across v5–v8 unre-measured; its true value on the same scorer was 0.490 | `docs/READINESS.md:74`, `:122-123`, `:540` |
| **0.9170** | Difficulty vs Codeforces rating, Spearman | **0.4864** — *"a headline correlation nearly twice the real value"*, in the first document a reader opens | `docs/METRICS.md:19` |
| **0.875** | Opening disclosure level ≤ 1 | **0.810** on the corrected scorer (0.789 on the old one) | `docs/READINESS.md:279` |
| **0.255** | Reasoning never reaches level 4 | **0.782** | `docs/READINESS.md:281` |
| **0.647**, **0.608** | Diagnostic localisation | **0.813** over the nine stored runs. The 0.647 was recorded in the gates table while the same file's headline said 0.817 | `docs/READINESS.md:80`, `:231`, `:287` |
| **0.3142** | NDCG@10 | **0.0200** with random tie-breaking — a stable sort over 12 distinct scores inflated the first result by 94% | `docs/RANKING_DESIGN.md:171-174` |
| **1,234,270** rows · **94,850** learners · **103** problems · **894,535** mastery rows | Pipeline scale, the pre-D-009 world | **2,296,409** rows · **117,453** learners · **11,284** problems | `docs/DECISIONS.md:149-150`; `docs/METRICS.md:18` |
| **1,806,262** rows | Pipeline scale — a *second*, different pre-D-009 figure, the "before" column of the D-009 table. Both it and 1,234,270 appear in the repo, so check which you are looking at | **2,296,409** | `docs/DECISIONS.md:167` |
| **22.11 GB/s** | NCCL all-reduce busbw over P2P | **7.72 GB/s over SHM** | `docs/rl/DECISIONS.md:311-323` |
| **0.078** | Per-mode debug score | **0.588** — `bug_localisation` was scored on the answer surface inside `all_passed`, penalising the mode for the disclosure policy a second time | `docs/READINESS.md:62-65` |
| ~~Answer leak rate (binary)~~ | ≤ 0.02 gate | **RETIRED**, superseded by the disclosure ladder | `docs/READINESS.md:282` |
| **730 tok/s** | 1.5B 8-bit AdamW training | **discarded, no replacement** — WDDM host-RAM spill contaminated it | `docs/MEMORY_AUDIT.md:527` |
| `holdout_greedy_solved` | In-domain solve count | **metric discarded** — 59–68 with sd 4.5 of 120 across three evals of an *unchanged* policy | `docs/rl/METRICS.md:901` |

**Measured once and never re-measured after D-009** — quote neither the old value nor a current
one: IRT observations (was 744,643) and ability spread θ (`docs/METRICS.md:239`, `:246`).

---

## What cannot be verified — permanently

RunPod work has ended; these will not be resolved by a later run.

| claim | why it cannot be checked |
|---|---|
| Live `/v1/models owned_by` at any layer | The API's value is a hardcoded constant that reads no state. The upstream backend that would answer truthfully died with pod `mg5ku6g5kfcw77` |
| Which artifact served the v7 and v8 runs | The evidence files record only `"whatever /v1/chat/completions serves"`. `READINESS.md`'s provenance block scopes itself to v6 |
| `policy-30b-seed1`'s weights | Lost with the pod volume. Its config, completions and logs survive; four other adapters remain in `artifacts/` |
| Any A6000, A100, H100 or L40S measurement | Never taken |

---

## How 0.813 reproduces, and the trap on the way

Recorded because reading the wrong field produced a confident, wrong conclusion — that the headline
figure was unreproducible.

**The trap.** The CHECK_SURFACE rescore (commit `0ad8bcd`) recomputed every per-record score in the
v6 files and **left the `summary` block behind.** `summary.by_check.bug_localisation` read 9, 8, 8
out of 51 while the records in the same files read 43, 42, 37. Pooling the stale field across nine
runs gives 0.6013 and a range of 8–45, which matches nothing in `READINESS.md`. The summary was
stale; the records were correct. Repaired by `scripts/resummarise_evidence.py`, with the replaced
block kept in `summary.superseded_summary`.

**The reproduction**, scored off the records:

| pool | files | per-run passes / 51 | pooled | doc |
|---|---|---|---|---|
| **9 runs** | `eval_stream_v{6,7,8}_run{1..3}.json` | 43, 42, 37, 45, 43, 40, 42, 40, 41 | **373 / 459 = 0.8126 → 0.813**, range 37–45 | `READINESS.md:287` ✓ exact |
| **6 runs** | `eval_stream_v{6,7}_run{1..3}.json` | 43, 42, 37, 45, 43, 40 | **250 / 306 = 0.8170** | `READINESS.md:69` ✓ exact, same order |

`READINESS.md:123` and `:540` independently name the pool — *"the nine v6/v7/v8 runs"* — all nine
files carry mtime 2026-08-16, and `:221` records the arms as one config (*"Two arms, one config, no
drift"*). Pooling them is defensible.

**Independent corroboration.** The stale check also dragged five debug bucket rows with it, because
`by_bucket` derives from `all_passed`: debug/ALL read 3, 4, 5 against the records' **30, 32, 28**.
`READINESS.md:71` already publishes `debug, all checks | 30, 32, 28, 35, 30, 26`. The document was
written from correctly rescored data all along; only the stored blocks had drifted. That cross-check
is now a test.

---

## Known internal conflicts, unresolved

Recorded rather than silently picked between. None is repaired.

| conflict | sources |
|---|---|
| Test cases: **495 across 87 problems** vs **699 (421 hidden / 258 visible)** across 200 items — `CONTENT.md:3` calls itself the authoritative computed source | `docs/METRICS.md:97` vs `docs/CONTENT.md:21` |
| SFT `lora_dropout` **0.1** in the saved adapter vs **0.05** in the config | `llm/outputs/final_model/adapter_config.json` vs `llm/configs/training_config.yaml` |
| SFT `max_seq_length` **1536** in the last run vs **1024** in the config | `llm/logs/training_20260310_213004.log` vs the config; noted at `docs/MEMORY_AUDIT.md:115` |
| Training corpus **2,000** examples vs the **1,860** trained | `llm/data/validation_report.txt` vs the training log |
| `SUPERSEDED-SPECS.md:63` claims pyspark/Spark/Parquet/Hive are "absent from the whole repository" — false for this tree; `:68` clarifies the claim is really about `desktop/` | `docs/SUPERSEDED-SPECS.md` |
| `KNOWLEDGE_ARCHITECTURE.md:80` claims zero hits for `PPO\|GRPO` — false; `rl/ppo.py`, `rl/grpo.py` and `scripts/train_grpo.py` all exist | `docs/KNOWLEDGE_ARCHITECTURE.md` |
| `45498 MiB` unlabelled log column | ~16 files in `docs/rl/run-logs/` |

---

## Guards

`tests/test_reported_numbers_are_attributable.py`, each mutation-verified:

1. **Every multi-run interval states its scale.** Mutated by unlabelling each row in turn — a single
   global strip is not a valid mutant here, because the first match sits on a row carrying both
   scales and the guard correctly survives.
2. **Every stored summary agrees with its own records**, across `by_check` *and* `by_bucket`, by
   comparison against `run_evals.summarise` rather than a second implementation. Verified against
   the real pre-fix state, where it fails on all three v6 files.
3. **The superseded ranking table carries its marker**, naming the eleven-feature figures that
   replace it.
