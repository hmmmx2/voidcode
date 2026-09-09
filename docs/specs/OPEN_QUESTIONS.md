# VoidCode AI — Open Questions

Raised under spec §0 rule 5: *"If a requirement here is technically wrong, stop and flag
it in `docs/OPEN_QUESTIONS.md` rather than working around it silently."*

Severity: **BLOCKING** stops a phase. **MATERIAL** changes a number or a design.
**MINOR** is an inconsistency to tidy.

## Status board

| # | Severity | Status |
|---|---|---|
| Q-001 hardware absent | BLOCKING | **ANSWERED** — Phase 1 moves to rented cloud GPUs |
| Q-002 ZeRO-2 vs `no_sync` memory | MATERIAL | **OPEN** — settle by measurement on the cloud box |
| Q-003 host RAM 31.6 GB | MATERIAL | **MOOT for Phase 2** — pipeline ran inside 20 GB |
| Q-004 PCIe at 8x | MINOR | **MOOT** — cloud hardware, not this box |
| Q-005 layout contradictions | MINOR | **PARTLY RESOLVED** — taxonomy lives only at `data/concepts.yaml` |
| Q-006 monorepo reconciliation | MATERIAL | **ANSWERED** — ML tree alongside `apps/`, nothing deleted |
| Q-007 start Phases 2–5 | — | **ANSWERED** — Phase 2 started, complete, gate passed |
| Q-008 budget, real learner data | — | **OPEN** — now blocks Phase 1 |
| Q-009 SYNTHIEN sequencing | MINOR | **OPEN** |
| Q-010 catalog too small for Phase 3 | **BLOCKING for Phase 3** | **NEW — OPEN** |

---

## Q-010 — BLOCKING for Phase 3 — NEW — The problem catalog is too small to rank

Phase 2 succeeded on volume and learner count but not on **problem diversity**, and that
directly undermines Phase 3's headline metric.

`contest.status` returns submissions for the ~7 problems belonging to that contest, so 15
contests produced **1,234,270 rows and 94,850 learners across only 103 distinct problems**.

Spec §5.1 asks candidate generation to "retrieve 200 to 500 candidate problems per
learner" and report **Recall@100**. With a 103-problem catalog, retrieving 100 candidates
returns 97 % of everything that exists — Recall@100 would be ~1.0 by construction and
would measure nothing. NDCG@10 remains computable but over a very thin candidate set.

Three ways forward, in cost order:

1. **`user.status` per learner.** Returns a learner's full cross-contest history, so the
   catalog grows to thousands of problems and histories deepen from ~8 problems to
   hundreds. Costs one rate-limited request per learner: 10,000 learners ≈ 6 hours of
   wall clock at 2.2 s/request. Sample a few thousand active learners rather than all
   94,850.
2. **Many more contests, one page each.** Cheap — 200 contests ≈ 25 minutes — and lifts
   the catalog to ~1,400 problems. Learner histories stay shallow, because most learners
   still appear in one contest.
3. **Accept it and report Recall@100 as not meaningful**, ranking only within-contest.
   Honest but weakens Phase 3 considerably.

**Recommendation: (1) on a sampled learner set, with (2) to broaden the catalog.**
Needed before Phase 3 candidate generation is worth building. Flagged now rather than
after the ranker is written against an unusable evaluation.

---

## Q-001 — ANSWERED — The specified hardware is not present on this machine

> **Resolution (operator): rent cloud GPUs for Phase 1.** Spec §2.5 Route C is promoted
> from a 200-step benchmark to the actual training environment.
>
> **Consequence that needs writing down:** this makes most of spec §2 inapplicable. The
> WSL2 interconnect analysis, the ZeRO-2-over-ZeRO-3 argument, the §2.4 memory table and
> Routes A and B all reason about a two-A6000 WSL2 box that does not exist and will not
> be used. On rented Linux with real NVLink, ZeRO-3 becomes viable again and the model
> ceiling rises above the 8B class. **§2 should be rewritten before Phase 1 starts.**
> Cloud instances are not yet provisioned and the budget ceiling (Q-008) now blocks
> Phase 1.

Spec header states: *"Two NVIDIA RTX A6000 at 48 GB each in one machine, 96 GB aggregate."*

Measured (`nvidia-smi -L`, see `DECISIONS.md` D-001):

| | Specified | Measured |
|---|---|---|
| GPU count | 2 | **1** |
| Model | RTX A6000 (or RTX 6000 Ada) | **GeForce RTX 5060 Ti** |
| VRAM per card | 48 GB | **15.93 GiB** |
| Aggregate VRAM | 96 GB | **15.93 GiB** |
| Host RAM | 128 GB (§2.6, to give WSL 96 GB) | **31.6 GB** |

### What this invalidates

**Every route in §2.5 is unavailable.**

- **Route A** (ZeRO-2, 2 GPU) — needs a second GPU. Not present.
- **Route B** (single card, Adafactor BF16) — the spec calls this the safe fallback at
  31.65 GiB for sequence 1024. That is **twice this card's total VRAM**. The prior audit
  did not project this, it *ran* it: Adafactor BF16 on the 7.6B model reached `backward`
  at 28.766 GiB and then **failed at `opt_step`** trying to allocate 2.03 GiB.
- **Route C** (rented Linux) is unaffected — it is cloud hardware.

**No full-parameter fine-tune of a 7.6B model fits on this card under any configuration.**
The lightest configuration measured in the prior audit was GaLore rank-128 with 8-bit
states and layer-wise updates, projected at **21.77 GiB** at sequence 1024. That is still
37 % above this card's 15.93 GiB. There is no optimizer trick that closes a gap this size.

Consequently **§2.3 step zero cannot run** (`all_reduce_perf -g 2` requires two devices),
and since §3.1 forbids writing training code before that number exists, **Phase 1 is
blocked at its first instruction.**

### Question for the operator

Where is the real training hardware? Specifically:

1. Are the two A6000s in a **different machine** that I should be inventorying instead?
2. Are they **not yet purchased**, making this spec forward-looking?
3. Or should Phase 1 be **re-planned for rented cloud GPUs**, promoting §2.5 Route C from
   a 200-step benchmark to the actual training environment?

Option 3 is viable today and would remove the WSL2 interconnect problem entirely — but it
changes the spec's central premise, because §2 exists specifically to reason about WSL2's
limitations. That reasoning becomes moot on rented Linux.

**Nothing in Phase 1 should be written until this is answered.** Phases 2–5 are not
GPU-blocked; see Q-007.

---

## Q-002 — MATERIAL — §2.4's ZeRO-2 memory table conflicts with §3.1's `no_sync` requirement

§3.1 requires wrapping micro-batches in `no_sync` so gradients are communicated once per
optimizer step. §2.4's table gives per-GPU static memory for ZeRO-2 assuming gradients are
sharded across ranks.

**These two cannot both hold during accumulation.** `no_sync` suppresses the gradient
reduce-scatter, so each rank accumulates a *full, unsharded* BF16 gradient buffer until the
step boundary. For the 7.6B model that is 2 bytes/param = **14.19 GiB per rank**, not the
7.09 GiB a sharded half would cost.

Recomputing the "8-bit AdamW, no master" row on that basis:

| Component | Spec §2.4 implies | With `no_sync` during accumulation |
|---|---|---|
| Weights BF16 (replicated) | 14.19 | 14.19 |
| Gradients BF16 | 7.09 (sharded) | **14.19 (full)** |
| 8-bit states m+v (sharded) | 7.09 | 7.09 |
| **Static per GPU** | **28.38** | **~35.46** |
| Peak at seq 2048 (+5.02 act) | 33.4 | **~40.5** |

Still inside the 44 GiB gate, so the row's **"Fits: Yes" verdict survives** — but the
margin is 3.5 GiB, not 10.6 GiB. The Adafactor row is affected the same way and also
survives. The 14.8B row already said "No" and moves further out of reach.

Two things to confirm before relying on either number:

- DeepSpeed's ZeRO-2 may reduce-scatter at every micro-step regardless of an outer
  `no_sync` context, in which case §3.1's throughput lever does not engage at all and the
  §2.4 memory figures are right. **The two claims are coupled and only one can be true.**
  This must be settled by measurement (count collectives under `NCCL_DEBUG=INFO`, as §3.2
  already schedules), not by reading documentation.
- Whichever way it resolves, one of the two sections needs correcting.

---

## Q-003 — MATERIAL — Host RAM is 31.6 GB against a 128 GB requirement

§2.6 requires `memory=96GB` in `.wslconfig`, "which means 128 GB installed on the host".
Installed is **31.6 GB**; `.wslconfig` currently sets `memory=20GB`.

This matters beyond training. §4.1 requires a Spark job over **at least one million rows**.
A 20 GB WSL allocation running a standalone Spark cluster is workable for a Parquet
pipeline of that size if partitioning is sensible, but it constrains executor memory and
rules out caching the corpus in RAM.

Not blocking for Phase 2 — flagging so the §8 ledger records the core count and memory the
throughput number was actually measured on, rather than implying a larger machine.

---

## Q-004 — MINOR — PCIe link is negotiated at 8x, not 16x

`nvidia-smi -q` reports Current 8x against Max 16x. Irrelevant with one card. It becomes
relevant the moment a second card is added, because §2.2 establishes that WSL2 stages
collectives through host memory over PCIe — at 8x that path is halved before NCCL starts.
Worth checking the slot allocation before assuming a second card would reach the §2.3
"above 20 GB/s" tier.

---

## Q-005 — MINOR — §9 repository layout contradicts §3.1 and §4.2

- §3.1 mandates `configs/ds_zero2.json` as the primary training config. **§9's `configs/`
  lists only `ds_zero3.json`, `ds_zero3_offload.json`, `model.yaml`** — the ZeRO-2 config
  that Phase 1 actually trains with is missing, and `ds_zero3_offload.json` appears nowhere
  else in the spec. §2.6 additionally advises against offload.
- `concepts.yaml` is listed in **both** `features/` and `data/`. §4.2 specifies
  `data/concepts.yaml`. Two copies of the taxonomy that backs both ranking and course
  generation is a drift hazard; it should exist once.

---

## Q-006 — MATERIAL — How does §9's layout reconcile with the existing monorepo?

The repository is currently a pnpm/Turborepo monorepo: `apps/web` (Next.js 16),
`apps/api` (FastAPI, ~1600 lines incl. a vLLM engine), `packages/shared`, `llm/` (QLoRA).
§9 describes a flat ML tree with no mention of any of it.

- Does `serving/api/` **replace** the existing `apps/api`, or wrap it?
- Does `train/` **replace** `llm/scripts/`, or live beside it? The existing QLoRA trainer
  is the source of the 411.9 tok/s baseline in the §8 ledger, so it cannot simply be
  deleted.
- Does the existing Next.js frontend stay in the repository?

Guessing here would mean either a duplicated backend or a deleted baseline.

---

## Q-007 — Not blocked: Phases 2–5 need no GPU

Recorded so the answer to Q-001 does not stall everything. None of the following depend on
the training hardware:

- **Phase 2** — concept taxonomy (§4.2), Project CodeNet ingest, Spark features, IRT model.
  828 GB free on WSL ext4 is ample.
- **Phase 3** — candidate generation and the LambdaMART ranker. Only §5.3 course assembly
  needs the fine-tuned model, and the base instruct model can stand in meanwhile.
- **Phase 4** — sandbox and Kubernetes. The sandbox is CPU-only.
- **Phase 5** — experimentation layer.

§0 rule 1 sequences phases strictly, so this is offered as a question rather than assumed:
**should I start at Phase 2 while Q-001 is resolved?**

---

## Q-008 — Needs an operator answer, not measurable here

- **Cloud budget ceiling** for the Kubernetes phase and the §2.5 Route C scaling benchmark.
  Route C is estimated at 5–20 USD; the Kubernetes phase is open-ended.
- **Real learner submission data** — none found. `llm/data/` holds 1,860 synthetic tutoring
  examples and no submission telemetry. Phase 2 therefore bootstraps entirely from a public
  corpus, and Phase 5 must simulate learners and label every artifact as simulated (§7.1
  permits this explicitly).

---

## Q-009 — MINOR — §11 sequencing says to finish SYNTHIEN AI first

§11: *"Run it to completion first, start applying, then begin this specification... Do not
run both builds in parallel."* Work is starting here instead. Flagging only — the operator
may have completed SYNTHIEN AI or reprioritised deliberately.

---

## Q-010 — BLOCKER FOR LAUNCH — the landing page describes a curriculum that does not exist

The public landing page at `/` positions VoidCode AI as a **DL/ML/LLM/VLM system-design and
coding interview-prep platform** for working engineers. The repository contains no ML learner
content of any kind.

Measured, not estimated:

- `apps/api/scripts/seed_problems.py` — **5 problems, all `difficulty: "easy"`**: two-sum,
  reverse-string, valid-parentheses, merge-two-sorted-lists, best-time-to-buy-and-sell-stock.
- `data/concepts.yaml` — **80 concepts across 8 categories**, all classical DSA
  (foundations, data_structures, techniques, recursion_dp, graphs, math, strings, geometry).
  Zero ML, LLM, VLM or system-design concepts.
- `apps/api/scripts/seed_courses.py` — two courses, both **Swinburne unit codes**
  (COS10009, SWE40006), which contradict the repositioning away from a university product.
- A repo-wide search for `system design`, `transformer`, `attention`, `VLM`, `RAG`,
  `fine-tun`, `embedding`, `quantiz` across yaml/json/ts/tsx/py/sql returns **only this
  product's own inference stack** — never curriculum.

**What the page does claim, and can defend.** The stack strip and FAQ describe the inference
stack only: self-hosted Qwen2.5-7B, QLoRA fine-tune, AWQ 4-bit, SGLang/vLLM, an 8,192-token
reasoning budget with visible thinking traces, and the 88-node acyclic prerequisite graph.
All of those exist. The "Two tracks" section describes *what the tutor does* rather than
asserting a catalogue size, and no problem count appears anywhere on the page.

**What is authored, not shipped.** The hero demo's subject — scaled dot-product attention,
with a missing `1/sqrt(d_k)` and a softmax on `dim=-2` — is written in
`components/marketing/demo/demo-content.ts` and exists nowhere else in the product. A scripted
demo authoring its own content is normal. A visitor signing up and finding five easy DSA
problems is not.

**Before launch, one of:**

1. Author ML implementation and system-design problems, and extend `data/concepts.yaml` with
   an ML branch (the taxonomy loader already enforces acyclicity, so this is additive); or
2. Reposition the page's copy to what the catalogue actually holds; or
3. Ship behind a waitlist that states the catalogue is in progress.

Also outstanding, smaller: `COS10009.png` and `SWE40006.png` in `apps/web/src/assets/images/`
are Swinburne course art still imported by three `Course/` and `Homepage/` components. The
landing page uses neither, but the authed app still shows them.
