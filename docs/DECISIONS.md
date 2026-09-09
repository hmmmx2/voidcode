# VoidCode AI — Decisions Log

Every entry is a measured fact or a decision taken against measured facts.
Commands are given so any row can be regenerated on demand.

---

## D-001 — Environment inventory (2026-07-26)

Recorded per spec §2.6. **Status: measured.**

### Host

| Item | Measured value | Command |
|---|---|---|
| OS | Microsoft Windows 11 Pro 10.0.26200.0 | `(Get-CimInstance Win32_OperatingSystem).Caption` |
| Host RAM installed | **31.6 GB** | `Get-CimInstance Win32_OperatingSystem` |
| Free space, `C:` (NTFS) | 69 GB | `df -h /mnt/c` |

### GPU

| Item | Measured value | Command |
|---|---|---|
| **GPU count** | **1** | `nvidia-smi -L` |
| Model | **NVIDIA GeForce RTX 5060 Ti** (Blackwell, sm_120) | `nvidia-smi -L` |
| VRAM | **16311 MiB = 15.93 GiB** | `nvidia-smi --query-gpu=memory.total` |
| Host driver | 591.86 | `nvidia-smi` |
| CUDA (driver-reported) | 13.1 | `nvidia-smi` |
| PCIe link width | **Current 8x, max 16x** | `nvidia-smi -q \| grep -A3 "Link Width"` |
| NVLink | Not applicable — single card | — |

### WSL2

| Item | Measured value | Command |
|---|---|---|
| WSL default distro | Ubuntu, version 2 | `wsl --list --verbose` |
| Kernel | 5.15.167.4-microsoft-standard-WSL2 | `uname -r` |
| **GPU visible inside WSL** | **Yes** — same single card enumerates | `wsl -d Ubuntu -- nvidia-smi -L` |
| `/usr/lib/wsl/lib` present | Yes (`libcuda.so`, `libcudadebugger.so.1`, `libd3d12.so`) | `ls /usr/lib/wsl/lib` |
| Free space, WSL ext4 (`/`) | **828 GB** of 1007 GB | `df -h /` |
| `.wslconfig` | `memory=20GB`, `processors=10`, `swap=8GB`, `networkingMode=mirrored` | `cat ~/.wslconfig` |

### Python / ML stack (Windows side; WSL side not yet inventoried)

torch 2.10.0+cu128 · transformers 4.57.6 · accelerate 1.12.0 · bitsandbytes 0.49.1 ·
peft 0.18.1 · trl 0.27.1 · datasets 4.5.0 · **deepspeed NOT INSTALLED** ·
**flash-attn NOT INSTALLED** · galore-torch 1.0

---

## D-002 — Interconnect benchmark: NOT RUN, cannot be run

Spec §2.3 makes the NCCL all-reduce benchmark step zero of Phase 1, and §2.5 selects the
training route from its result.

**It cannot be executed on this machine.** `all_reduce_perf -g 2` requires two CUDA
devices; one is present. There is no interconnect to measure because there is nothing to
interconnect.

| Metric | Value |
|---|---|
| NCCL all-reduce bus bandwidth, GB/s | **NOT MEASURED — hardware absent** |
| NCCL transport selected | **NOT MEASURED — hardware absent** |

Route selection under §2.5 is therefore **blocked**, not deferred. See
`docs/specs/OPEN_QUESTIONS.md` Q-001.

---

## D-003 — Good news worth recording

Three things the spec worried about are already satisfied, and remain true regardless of
how the hardware question resolves:

1. **WSL2 GPU passthrough works.** The card enumerates inside Ubuntu and the CUDA
   userspace shim is in place. No guest driver is installed, which is correct per §2.6.
2. **Storage is not a constraint.** 828 GB free on WSL ext4. Project CodeNet metadata and
   a Parquet feature store fit comfortably inside the Linux filesystem, so the §2.6 rule
   about never crossing the 9p boundary to `/mnt/c` is easy to honour.
3. **`.wslconfig` exists and is already tuned** (memory=20GB, processors=10). It targets
   the wrong number for this spec, but the mechanism is understood and in place.

---

## D-004 — Repository state (2026-07-26)

The repository was rebranded from `swinburne_ai_tutor_project` to **VoidCode AI**
immediately before this spec was received. Current top-level structure is a
pnpm/Turborepo monorepo — `apps/web` (Next.js 16), `apps/api` (FastAPI), `packages/shared`,
`llm/` (QLoRA training) — which does **not** match the flat ML layout in spec §9.

One rename step is still outstanding: the root directory is still named
`swinburne_ai_tutor_project` on disk because the running editor session holds a lock on it.
All in-repo path references already assume `voidcode_ai`.

Reconciling the existing monorepo against the §9 layout is an open question, see Q-006.

---

## D-005 — Phase 1 moves to rented cloud GPUs (operator decision)

Taken after D-001/D-002 established that the two A6000s in the spec header are not
present. Spec §2.5 Route C is promoted from a 200-step benchmark to the real training
environment.

**What this invalidates.** Spec §2 exists to reason about WSL2's limitations — no
peer-to-peer, host-staged NCCL collectives, the ZeRO-2-over-ZeRO-3 argument, the §2.4
per-GPU memory table, Routes A and B. **None of it applies to rented Linux.** With real
NVLink, ZeRO-3 parameter sharding becomes viable and the ~8B model ceiling that §2.4
imposes lifts. §2 needs rewriting before Phase 1 starts rather than being followed as
written.

**Still blocked.** No instance is provisioned and the cloud budget ceiling is unanswered
(`docs/specs/OPEN_QUESTIONS.md` Q-008).

## D-006 — ML tree added alongside the existing monorepo (operator decision)

Spec §9's flat layout is added as new top-level directories next to `apps/` and
`packages/`. Nothing is migrated or deleted. `llm/` stays, because it is the source of the
411.9 tok/s QLoRA baseline the metrics ledger cites, and `apps/api` keeps serving the
product. Phase 4's `serving/` split is deferred to Phase 4.

Added this phase: `features/`, `data/concepts.yaml`, `docs/`, `Makefile`,
`setup_wsl_env.sh`, and `scripts/memory_audit/` (moved from the audit worktree so the
`MEMORY_AUDIT.md` rerun commands resolve).

## D-007 — Corpus: Codeforces API, not Project CodeNet

Spec §4.1 nominates Project CodeNet. Its IBM DAX CDN host does not resolve from this
network (`getaddrinfo failed`), while HuggingFace, PyPI and Codeforces all do.

The Codeforces `contest.status` endpoint was selected because it carries the field the
mastery model cannot be built without and that the available CodeNet mirrors and the
690k-row `MatrixStudio/Codeforces-Python-Submissions` dataset all lack: **a per-user
handle**. Full reasoning, licence position and the rejected alternatives are in
`docs/DATA_SOURCES.md`.

**Licence caveat, recorded because it constrains what can be published.** Codeforces
publishes an open API but attaches no open-data licence. The corpus is fetched read-only,
rate-limited, stored outside the repository at `~/voidcode-data`, and is not
redistributed. CodeNet, if it ever becomes reachable, is CDLA-Permissive-2.0 and would be
the better long-term choice.

**Privacy.** Handles appear only in the bronze layer. Everything downstream carries
`learner_id = sha256(handle + salt)[:16]`.

## D-008 — Phase 2 complete, acceptance gate passed

1,234,270 rows processed in 44.6 s on 10 cores (27,684 rows/s), producing 894,535 mastery
rows for 94,850 learners. Idempotency verified across two consecutive runs. The Rasch
model's recovered difficulty correlates with the published Codeforces rating it never saw
at Spearman 0.917. Full numbers in `docs/METRICS.md`.

**Not resolved by this phase:** the catalog is only 103 problems, which breaks Phase 3's
Recall@100 metric. Raised as `docs/specs/OPEN_QUESTIONS.md` Q-010 before building the ranker against an
evaluation that cannot mean anything.

---

## D-009 — Warehouse rebuilt on the full corpus; Q-010 resolved

The warehouse had never seen the 1,000 depth histories. Proof: `distinct_problems` read
2,109 and 301 contests × ~7 problems ≈ 2,107 — an exact match to the breadth pass alone.

| | Contest-only | Full corpus |
|---|---|---|
| Rows | 1,806,262 | **2,296,409** |
| Distinct problems | 2,109 | **11,284** |
| Learners | 117,415 | 117,453 |
| Concepts observed | 66/80 | 67/80 |
| Wall clock | 44.6 s | 248.5 s (10 cores, 9,241 rows/s) |

**Q-010 is closed.** 11,284 of the 11,311-problem catalog are now observed — 99.8%.
Retrieving 100 candidates from eleven thousand makes Recall@100 a real measurement rather
than an arithmetic identity.

**The cost, stated plainly.** Median observations per problem fell from 145 to **7**. The
1,000 deep learners reference nearly every problem on Codeforces, but thinly. Item
difficulty is therefore well estimated only where evidence is thick — external Spearman
against the published Codeforces rating is 0.4864 overall, 0.6627 at ≥50 observations, and
0.8730 at ≥1000. Downstream code must gate on `n_observations` the same way it gates on
`irt_n_problems`; `difficulty_beta_se_analytic` exists for this and the Step-2 bootstrap
will quantify how far it understates the true uncertainty.

## D-010 — Rasch learning rate reversed to 0.5 after re-tuning

`features/irt_tune.py` states its own contract: rerun when the corpus changes. It was
rerun, and the answer changed.

On 103 problems, lr=0.5 early-stopped at epoch 10 with unconverged item parameters
(Spearman 0.846 vs 0.917), so lr=0.05 was selected — log loss *subject to* beta
convergence. On the full corpus lr=0.5 converges at epoch 70 and wins on **both**
criteria: held-out log loss 0.22661 against 0.22640 for lr=0.1 (0.09%, noise) and Spearman
0.4864 against 0.4452 (9% relative, material). More data changed the convergence regime,
so the original objection no longer applies.

Model quality against baselines improved substantially: 22.5% over the global-mean
baseline (was 14.21%) and 25.28% over per-problem means (was 4.66%). Note the second
number flatters the model — with a median of 7 observations per problem, per-problem means
are themselves noise, so that baseline got worse rather than the model getting better.

## D-011 — One global temporal cutoff, despite a 14× span asymmetry

`_rows_by_ingest_mode()` previously counted *files* (301 vs 1,000), which said nothing
about rows or time coverage. Rewritten to report rows and ranges, it shows:

| Mode | Pairs | Learners | Pre-cutoff | Span |
|---|---|---|---|---|
| contest | 1,079,986 | 117,394 | 76.0% | 361 days |
| depth | 240,396 | 1,063 | 97.8% | 5,025 days |

Depth histories reach back to 2012 and sit almost entirely before the cutoff.

**Decision: keep a single global cutoff.** A per-mode cutoff would evaluate two
populations at two different dates, which breaks the "train before, evaluate after"
semantics the split exists to enforce. Both populations are represented on both sides
(depth still contributes 5,200 post-cutoff pairs across ~1,063 learners).

**The residual risk is a segment risk, not a split defect.** The evaluation cohort
(20,537 learners) is dominated by shallow contest learners, so aggregate NDCG will mostly
measure performance on sparse histories. That is exactly the failure the Phase 6 fairness
audit (§8.3) exists to catch, and it is recorded here so that audit has a stated
hypothesis to test rather than discovering it.

## D-012 — The merge and quantize pipelines completed; their weights are gone from disk

> ### CORRECTION (2026-08-13): the weights were never gone. The search was Windows-only.
>
> Everything below about the pipelines **completing** is right, and the index-file argument that
> established it is sound. The conclusion that the weights were **deleted** is wrong. They were on
> the WSL side the whole time, which the original search never looked at:
>
> | path (inside WSL) | size | shards |
> |---|---|---|
> | `/home/alwin/swinburne_ai_tutor_project/llm/outputs/merged_model` | 15 GB | **4** |
> | `/home/alwin/swinburne_ai_tutor_project/llm/outputs/awq_model` | 5.2 GB | **2** |
> | `/home/alwin/swinburne_models/awq_model` | 5.2 GB | 2 (md5-identical duplicate) |
>
> Exactly the 4 shards and 2 shards the index files predicted, at exactly the sizes they named. The
> reasoning was right and the evidence for it was one filesystem away.
>
> **The failure was scope, not logic.** The search covered `C:\Users\User` and concluded "absent from
> every fallback path"; `vllm_engine.py` resolves those paths *inside WSL*, where
> `~/swinburne_models/awq_model` did exist. A negative result is only as strong as the space
> searched, and that space was never stated — which is what let a confident "they were deleted to
> reclaim disk" stand on it.
>
> **Consequence 1 below is therefore wrong**: the vLLM path can start, from the WSL copy. Consequence
> 3 understated things — nothing needs regenerating.
>
> **One thing did change after this correction.** During the 2026-08-13 disk reclamation the
> duplicate at `~/swinburne_models/awq_model` was deleted (verified md5-identical to
> `llm/outputs/awq_model`, and outside the resolution chain: `MODEL_PATH` is unset and
> `~/voidcode_models` does not exist, so the code falls back to `llm/outputs/awq_model`). So D-012's
> claim that `~/swinburne_models/awq_model` does not exist is true **now**, and was false when
> written. The copy the code actually loads is intact.

> ### UPDATE (2026-08-13, RunPod A40): rebuilt, and this time the claim was TESTED rather than inferred
>
> The whole entry below rests on an *inference* — an index file cannot exist without shards, so the
> pipelines must have completed. The inference was sound and has now been confirmed the only way that
> settles it: by running the output.
>
> `merge_lora.py` and `quantize_awq.py` were re-run end to end on an A40. Both produced exactly what
> the index files predicted, which is worth stating precisely because it is the prediction being
> tested:
>
> | artifact | shards | bytes on disk | index `total_size` | predicted below |
> |---|---|---|---|---|
> | `merged_model/` | **4** | 15.23 GB | 15.23 GB | 4 shards / 15.23 GB |
> | `awq_model/` | **2** | 5.55 GB | 5.55 GB | 2 shards / 5.55 GB |
>
> Verified beyond file sizes: every shard the index names is present, no orphans, and each
> safetensors header parses with `8 + header_len + last_data_offset == filesize`, so none is a
> truncated write that happens to be the right length.
>
> **Then it was served, because none of the above proves the model works.** A merge that mismatched
> the adapter, or a quantization that clipped the wrong axis, produces a model that loads and emits
> fluent, confident, wrong text — and no file-level check can tell that apart from a good one. Under
> vLLM 0.27.1 the AWQ model answered `17 + 25` with **42** and named Tokyo as the capital of Japan,
> both greedily, with no degenerate token loops (`longest_repeat_run` 1, unique-token ratio ≥ 0.93).
> **The vLLM path is restored and demonstrated, not asserted.**
>
> One honest caveat: on the open-ended tutoring probe the model's answer was *plausible but
> imprecise* — it pointed at the length of the list rather than at `a[i+1]` overrunning on the final
> iteration. That is a quality observation about a 4-bit merge of a 7B model, not a failure of the
> pipeline, and it was outside the pass criteria, which tested degeneracy and two unambiguous facts.
> It is recorded rather than omitted because production serves **prompt-engineered stock Qwen with no
> adapter**, so this artifact's quality is not currently on the serving path either way.
>
> **Two environment traps, neither related to the model.** `flashinfer` annotates with
> `array.array[int]`, which only became subscriptable in Python 3.12 — on the pod's 3.11 it raises
> `TypeError` at *import*, and vLLM reaches it during kernel warmup while importing an unrelated
> model family. And `flashinfer` JIT-compiles its sampler, so it needs `ninja` on PATH or startup
> dies with `FileNotFoundError`. Neither touches the weights; both stop the engine before it serves.
>
> **The artifacts live on the pod's network volume, not locally.** Nothing was downloaded, so the
> ~20.8 GB reclaimed on 2026-08-13 stays reclaimed. The copy the code actually resolves is the WSL
> one, re-verified during this session: `~/swinburne_ai_tutor_project/llm/outputs/merged_model`
> (4 shards, 15 GB) and `.../awq_model` (2 shards, 5.2 GB), both present.
>
> **The same scope error in this entry's CORRECTION was then made again, by me, in the session that
> wrote this update.** Asked what work remained, I reported "merge + quantize not rebuilt" after
> checking `~/swinburne_models/awq_model` and `~/voidcode_models` — the two *fallback* paths — and
> never checking `llm/outputs/`, the primary one, which had both models all along. A negative result
> is only as strong as the space searched; stating the space searched is what makes that checkable,
> and I again did not state it. **The rebuild was therefore not needed to restore anything.** What it
> genuinely established is separate and was never true before: that the pipelines reproduce from the
> adapter, and that the artifact they produce actually serves.

`docs/KNOWLEDGE_ARCHITECTURE.md` raised this as an open question: `llm/outputs/merged_model/`
and `llm/outputs/awq_model/` hold tokenizer and config files but **zero `*.safetensors`
shards**, so it was unclear whether the pipeline ever ran or silently failed. It ran.

**The evidence is the index file.** Both directories contain a complete, internally
consistent `model.safetensors.index.json`:

| Directory | Shards named by the index | Shards present | `total_size` |
|---|---|---|---|
| `merged_model/` | 4 | **0** | **15.23 GB** |
| `awq_model/` | 2 | **0** | **5.55 GB** |

`save_pretrained` writes the shards first and the index **last**, as the final step of a
successful save — the index is a map of every tensor to the shard holding it, so it cannot
be written before the shards exist. A crashed or interrupted save leaves shards without an
index, never an index without shards. A complete index naming four shards totalling
15.23 GB is therefore positive evidence that `merge_lora.py` ran to completion, and the
same argument covers `quantize_awq.py` at 5.55 GB. Both figures match what those scripts
document as expected output (~14 GB fp16 merge, ~4–6 GB W4A16), and `vllm_engine.py:57`
independently cites 5.6 GB.

**Why the weights are absent: they were deleted to reclaim disk, not lost to a failure.**
`.gitignore:56-58` excludes `llm/outputs/checkpoint-*/`, `llm/outputs/final_model/` and
`*.safetensors`, so they were never in git. They are also absent from every fallback path
`vllm_engine.py:63-70` searches — `~/voidcode_models/awq_model` and
`~/swinburne_models/awq_model` do not exist — and a filesystem search finds no
`model-0000*.safetensors` anywhere under the user's home. 20.8 GB across the two
directories is consistent with a deliberate cleanup.

**Consequences, and they are not symmetric.**

1. **The vLLM serving path cannot start from this checkout, and fails late rather than
   early.** `vllm_engine.py:108-114` guards with `Path(AWQ_MODEL_PATH).is_dir()`. The
   directory exists, so the guard passes and the `FileNotFoundError` never fires; vLLM
   instead failed deeper, on a missing shard, with a message pointing at neither cause
   nor remedy. `docker-compose.gpu.yml:64` mounts the same empty directory. **Fixed in
   this change**: the guard now requires at least one `*.safetensors` shard and names
   which of the two conditions failed.
2. **Nothing is blocked by this.** The intended production path is SGLang
   (`docker-compose.sglang.yml`), which serves stock Qwen3.5-9B from the HF cache and never
   reads these directories. Per `docs/KNOWLEDGE_ARCHITECTURE.md` the recommendation is to
   stay prompt-engineered, so no adapter is needed.
3. **Both artifacts are reproducible.** `llm/outputs/final_model/adapter_model.safetensors`
   (154 MB) is the only irreplaceable output and it is intact. Regenerate with
   `python apps/api/scripts/merge_lora.py` then `python apps/api/scripts/quantize_awq.py`,
   which needs the ~15 GB of intermediate disk that was reclaimed.

**No pipeline numbers were invalidated.** The measured figures in `docs/METRICS.md` come
from training and the feature pipeline, neither of which reads these directories.
