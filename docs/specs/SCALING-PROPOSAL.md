# Scaling proposal: which models, which GPUs, and what actually limits quality

Written 2026-09-06. Every claim here is tied to a measurement already in this repo, or is marked as
an estimate. The short version: **"bigger model" is the right answer for one half of this system and
the measured-wrong answer for the other half.**

---

## 1. The single measurement that decides the model question

`METRICS.md`, "7B vs 1.5B: better at the task, no better as a training signal" — same 60 problems,
8 completions, temperature 0.8:

| | Qwen2.5-Coder-1.5B | Qwen2.5-7B-Instruct |
|---|---|---|
| Mean pass rate | 0.0375 | **0.0729** (2×) |
| Mean case fraction | 0.087 | **0.166** (2×) |
| Total problems with signal | 27 | **32** |
| **Binary-usable (10–90% band)** | **7** | **6** ↓ |
| **Dead-group fraction** | **88.3%** | **90.0%** ↑ |

Read those last two rows carefully. The 7B is **twice as good at the task** and **slightly worse as a
GRPO curriculum**, because two problems went from "sometimes solved" to *always* solved — dead from
the opposite end. GRPO learns only from groups with within-group variance; a group where all G
samples score identically contributes exactly zero gradient.

**So: scale the tutor, do not scale the RL policy expecting the RL to improve.** Scaling the policy
without fixing the corpus makes the training signal worse, and that is measured, not predicted.

---

## 2. What actually limits quality (and it isn't parameter count)

**Correction to an earlier draft of this document: dead groups were NOT the binding constraint.**
The 88.3% / 90.0% figures above are the *binary-reward dead-group fraction on the 60 ML/DL eval
problems*. The actual training run on the filtered DeepCoder corpus recorded
**`dead_groups: 51/200 = 25.5%`** — meaning **74.5% of rollout groups produced a gradient**. The
training signal was healthy. Conflating the eval-set figure with the training-set figure pointed at
the wrong fix, and would have led to buying a bigger GPU to solve a problem that did not exist.

**The real gap is that nobody ever measured whether the policy improved on its own training
distribution.** The loop evaluates only on the 60 held-out ML/DL problems, which are
*out-of-domain*. So the run cannot distinguish between:

- **(a)** GRPO learned nothing — the recipe is broken; or
- **(b)** GRPO learned DeepCoder-style Python fine, and it simply did not transfer to ML/DL.

Those demand opposite responses, and the existing instrumentation cannot tell them apart. **Adding
an in-domain held-out slice is the cheapest, highest-value change available** — a few hundred
problems withheld from the same filtered pool, evaluated alongside the 60. If the in-domain curve
moves and the ML/DL curve stays flat, the loop is proven to work and the finding becomes a clean,
publishable transfer result rather than an ambiguous null.

**Domain mismatch, which this project predicted before running it.** `P3-CORPUS-SCOPE.md` §7:

> *"Transfer is unproven. Training on general Python and evaluating on ML/DL implementation problems
> may show little movement. This is the honest headline risk, and the evaluation set is built to
> detect it rather than hide it. A flat eval curve is a publishable result, not a failure."*

Training data is DeepCoder — general competitive-programming Python. The eval is ML/DL
implementation. The null result confirmed the stated risk. **The fix is in-domain data, not
parameters.**

---

## 3. Recommended models

### 3a. The tutor — yes, go bigger. This is the product.

Currently Qwen2.5-7B-Instruct, QLoRA-tuned, AWQ 4-bit, 5.16 GiB served. Measured AWQ footprint on
this project is ≈0.7 GB per billion params, so sizes below are grounded in our own number.

| Model | AWQ 4-bit (est.) | Fits | Why |
|---|---|---|---|
| **Qwen2.5-Coder-14B-Instruct** | ~10 GB | local 5060 Ti (16 GB) | Biggest real upgrade that still runs on hardware you already own. Coder-tuned, same family, so prompts and chat template carry over. |
| **Qwen2.5-Coder-32B-Instruct** | ~20 GB | A40 48 GB | The strongest dense coder in this family. Comfortable headroom for KV cache at 8k context. **My recommendation if you rent.** |
| **Qwen3-Coder-30B-A3B** | ~20 GB | A40 48 GB | MoE: ~30B quality at ~3B active params, so materially faster per token than the dense 32B. Worth benchmarking against it. |
| Qwen2.5-72B-Instruct | ~40 GB | A40 48 GB (tight) / H100 80 GB | Diminishing returns for a tutor whose job is Socratic hinting, not frontier reasoning. Only if 32B proves insufficient. |

**Caveat that applies to all of them:** the tutor's quality bottleneck may not be the base model.
The hint ladder is enforced in code, the disclosure scorer was once inflated 3.4×, and no current
tutor accuracy number exists. **Measure the 7B properly first**, or you will not be able to tell
whether a 32B actually helped.

### 3b. The RL policy — keep it small, fix the corpus

Stay at **1.5B–7B for now**. The constraint is what the policy is trained *on*, not how big it is:
the training gradient was healthy (74.5% live groups) and the eval simply measured a different
domain. A 32B policy trained on the same corpus buys a more expensive version of the same null.

The real work, in order:
1. **Add an in-domain held-out eval** — a few hundred problems from the same filtered pool, withheld
   from training. This is the diagnostic that tells "the loop is broken" apart from "the loop works
   and does not transfer", and it costs no extra GPU beyond the eval itself.
2. **Generate in-domain problems** — ML/DL implementation tasks in the style of the 60, with unit
   tests. The 200-item catalogue and `reference_solution` machinery already exist to model them on.
3. **Filter to the 10–90% band measured against the policy you will actually train** — the band is
   a property of the model/corpus pair, not of the corpus, so it must be re-measured per policy.
4. Only then scale the policy.

### 3c. VLM — there is nothing to improve, because there is nothing there

Grep result: **24 content items teach VLM topics; zero VLM models run anywhere in the system.** VLM
is a *subject in the curriculum*, not a capability. "Improving the VLM" would mean building one.

If you want it, the genuinely useful version is **student uploads a diagram or a screenshot** —
architecture sketch, a plotted loss curve, a whiteboard photo — and the tutor critiques it. That is
a real feature for interview prep and it fits the Socratic model.

| Model | AWQ 4-bit (est.) | Note |
|---|---|---|
| **Qwen2.5-VL-7B-Instruct** | ~5 GB | Same family as the tutor; can run *beside* a 14B/32B on one 48 GB card |
| Qwen2.5-VL-32B / 72B | ~20 / ~40 GB | Only if diagram critique becomes central |

Start at 7B. The task is "read this diagram and ask a Socratic question about it", not OCR at scale.

---

## 3d. The measured anchor: what actually fits on one 48 GB card

Measured on the A40 on 2026-09-06, not estimated:

| Config | VRAM | Verdict |
|---|---|---|
| **7B + LoRA r=16, bf16, group 8** | **15.7 GiB of 46** | **Runs. 34% of the card.** |
| 7B full-parameter | ~107 GB (15 policy + 15 ref + 15 grads + ~61 AdamW fp32) | Impossible on one A40 |

LoRA removes three of those four terms: only a 40.4M-param adapter trains (0.527% of 7.66B), and
the reference is the same weights with the adapter switched off, so the second 15 GB copy vanishes.

Weights dominate, so the rest of the table extrapolates from that anchor:

| Model class | bf16 + LoRA | **4-bit NF4 + LoRA (QLoRA)** | Serving, AWQ 4-bit |
|---|---|---|---|
| 7B | **16 GB — fits A40** | ~7 GB | 5.2 GB *(measured)* |
| 14B | ~30 GB — fits A40 | ~12 GB | ~10 GB |
| **32B** | ~64 GB — **does not fit** | **~25 GB — fits A40** | ~20 GB |
| 70B | ~140 GB — no | ~45 GB — 80 GB card | ~40 GB |
| **480B-A35B** | no | **~250 GB — 4× 80 GB** | ~250 GB — 4× 80 GB |

**This is why the answer is a bigger model on one card, not more cards.** A 32B trains on the A40 we
already have, via 4-bit base + fp16 adapter (`--load-4bit --lora-r 16`).

## 3e. On the 480B, honestly

Qwen3-Coder-480B-A35B is Apache-2.0 with repository-scale context, and as a *tutor* it would be
excellent. The problem is arithmetic, not licensing:

- **~250 GB of weights at 4-bit.** Minimum **4× H100 80 GB ≈ $13.96/hr**, or 2× B200 ≈ $13.58/hr,
  before KV cache. That is **~$335/day** to keep a tutor online for a non-commercial project.
- **It cannot be GRPO-trained on any sane budget.** The loop is rollout-dominated — thousands of
  generations per run. At $14/hr a single 200-step run costs more than every experiment in this
  repo combined.
- MoE helps *speed* (35B active), not *residency*: all 480B of weights must be in VRAM regardless.

**Verdict: serving-only, and only if a 32B is first shown to be insufficient on a real eval.** There
is currently no trustworthy tutor accuracy number, so that comparison cannot yet be made — which is
the strongest argument for measuring before buying.

## 3f. Recommended pick

**Qwen3-Coder-32B (or any ~27–32B dense coder) at 4-bit.** It is the largest class that:

- **trains** on one A40 via QLoRA (~25 GB of 46), and
- **serves** on one A40 via AWQ (~20 GB), and
- costs **$0.49/hr** rather than $14/hr.

Verify the exact checkpoint name and licence on its model card before pulling it — I cannot confirm
availability of specific revisions offline, and the sizing above is by parameter class, not by a
specific tag.

---

## 4. GPU recommendations, per workload

Grounded in this project's own P0 findings, including the ones that rule options out.

| Workload | Recommended | Why |
|---|---|---|
| **Serving a 32B tutor + 7B VLM** | **1× A40 48 GB** (~$0.49/hr) | ~20 GB + ~5 GB + KV cache fits with room. Cheapest 48 GB on the board. |
| **GRPO on 7B, group 8** | **1× H100 80 GB** or **1× A100 80 GB** | Policy + frozen reference + rollouts. **Single card on purpose** — see below. |
| **GRPO on 1.5B (today's run)** | 1× A40 48 GB | Already sufficient; current run peaks well under. |
| **Corpus generation + filtering at scale** | 1× A40, or the local 5060 Ti | Inference-only and embarrassingly batchable. |
| Kernel / FP8 work | **local 5060 Ti** | Blackwell sm_120 does FP8 at 97.4 TFLOP/s. Renting Ampere for this is paying to go slower. |

**Avoid multi-GPU for the RL work.** P0 measured, on two independent Secure A40 pods, that the
default NCCL P2P transport **deadlocks** and only completes over SHM at 7.72 GB/s — the middle band,
where ZeRO-3 and `FULL_SHARD` are not viable. A single 80 GB card sidesteps the entire class of
problem. This is why I recommend one H100 over two A40s despite the price.

**Do not rent for FP8**, and note A40 is **2-max** on RunPod, so any ×4 plan is unbookable.

---

## 5. Backend / frontend / database — what is actually broken

Audited rather than assumed. `grep` for `TODO`, `FIXME`, `NotImplementedError` across
`apps/api/src`, `features/` and `ranking/` returns **nothing** — the shipped code has no stubs.

Real defects found and their status:

| Issue | Status |
|---|---|
| API Redis client never reconnects after an idle drop; `/health` reports `degraded` and rate limiting silently stops | **Filed as a separate task.** Verified: Redis healthy, raw socket fine, restart fixes it. |
| `dtype` vs `torch_dtype` broke merge→quantize for months | **Fixed**, both scripts |
| `.gitignore` hid its own explanation files | **Fixed** |
| Two `scripts` packages collide by import order | **Fixed** — estimators moved to `rl/estimators.py` |
| Wilson interval excluded its own point estimate at k=n | **Fixed** |
| `rl-eval` stub claimed the GRPO loop was unbuilt | **Fixed** — it was built, tested and run |

**The database is not a bottleneck.** 157 problems seeded, migrations apply, 197 API tests pass
against real Postgres. The one measured infrastructure risk is the Redis reconnect above.

**The frontend is not a bottleneck.** Typecheck 3/3, production build 2/2, all routes compile.

**Where effort actually pays**, in order: (1) in-domain RL corpus, (2) a trustworthy tutor eval
number, (3) a bigger served tutor, (4) the Redis fix, (5) VLM as a new feature.

---

## 6. Ordered plan

1. **Finish the current run** — 1.5B, lr 5e-6, 200 steps, `--save-to` + `--log-completions`. Completes
   the base-vs-post pass@1 comparison and finally enables the reward-hacking audit.
2. **Measure the tutor properly** — a defensible accuracy number for the served 7B. Without it,
   no upgrade can be shown to have helped.
3. **Build the in-domain corpus** — the highest-leverage item, and it needs no GPU to design.
4. **Upgrade the served tutor to 32B AWQ** on an A40 and A/B it against the 7B on that eval.
5. **Add the 7B VLM** for diagram critique, if the feature is wanted.
6. **Re-attempt GRPO at 7B** only once the corpus has a measured 10–90% band.
