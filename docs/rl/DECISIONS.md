# Decisions

One entry per decision that constrains later work. Each records what was chosen, what it rules out,
and **what would reverse it** — a decision whose reversal condition is unstated is indistinguishable
from a habit.

## D-016 — The merge / quantize / vLLM-serve pipeline never completed

**Status:** answered, as V0 of the Revised Plan requires

The Revised Plan asks directly: *"the merged and AWQ model directories hold no weight shards, so the
vLLM serving path cannot start. Resolve whether that pipeline ever completed before repeating its
numbers anywhere."*

**It did not complete.** Checked: no `.safetensors` anywhere in this repository, and no
`awq_model` directory at any documented path (`MODEL_PATH`, `~/swinburne_models/awq_model`,
`./llm/outputs/awq_model`). There are no weights to serve and there never were.

**Consequences.**

- **Any figure attributed to that pipeline is unbacked and must not be repeated.** That includes
  any AWQ throughput or quantised-quality number in older documents.
- The P5 serving path proven this session serves **stock Qwen2.5-Coder-1.5B-Instruct**, not a
  merged or quantised artefact. Recorded plainly in `PLAN.md`.
- The GRPO policy is also not available: `train_grpo.py` had no save path until after its pod was
  released, so the 200-step weights are gone. `--save-to` now exists so it cannot recur.

**Reverses if:** the shards turn up on hardware not checked here. The check was this repository and
the documented cache paths, not every disk on the machine.

## D-015 — A plan may not keep a method its own decisions have disproved

**Status:** decided, after a phase sat "blocked" that was never blocked

P5 specified `vllm serve --port 8080`. **D-011 had already recorded, from a hard failure, that
vLLM cannot run on this machine at all.** The two documents contradicted each other for the whole
project and nobody reconciled them, so P5 read as blocked-by-environment when it was really
blocked-by-stale-spec. The requirement was an OpenAI-compatible endpoint on port 8080 — which
Ollama, already installed, serves, and which llama.cpp defaults to. Verified: 200, correct answer,
52 tokens.

The general failure is worth naming because it is cheap to repeat: **a decision that invalidates a
planned method must be applied to the plan, not just recorded.** D-011 was written up carefully and
then left to sit next to a phase it had killed.

Practically: when a `DECISIONS.md` entry rules a tool out, grep `PLAN.md` for that tool in the same
commit.

**Reverses if:** the project moves to native Linux, where vLLM runs and is the better server. The
port and the API contract stay the same either way, which is why the substitution is cheap.

## D-014 — Characterise the instrument before tuning anything against it

**Status:** decided, forced by three wasted runs

Three learning rates were compared on `mean_case_fraction` before anyone asked what that metric
could resolve. The answer, measured afterwards: **at lr=2e-6 the policy provably did not move** —
KL flat at 2–5e-4 across 100 steps, no drift — **and the eval still fell 0.111 → 0.0649, a 42%
swing.** A metric that moves that far with the policy frozen cannot distinguish the learning rates
it was being used to choose between.

The reading taken from the lr=2e-5 run — "it degrades the policy" — was therefore not supported by
its own evidence. That run's reward also ran 0.019 → 0.688 → 0.025 across adjacent logged steps:
violent noise, not the clean decline it was reported as.

Three fixes, in order of effect:

1. **Common random numbers.** Reseed to the same value before every eval, so checkpoints are
   compared on identical draws instead of two independent doses of noise. Save and restore the RNG
   state around it, or the *training* stream gets rewound too and every post-eval segment replays
   the same rollouts.
2. **A greedy metric.** `do_sample=False` is deterministic, so movement in `greedy_solved` cannot
   be sampling noise. This is the metric to judge the run on.
3. **A reported standard error**, so a swing is read against its own uncertainty.

`scripts/eval_noise_floor.py` evaluates an unmodified policy twice; the difference is the detection
threshold. **A flat curve is only a result once that number shows a change could have been seen.**

**Reverses if:** the noise floor comes back at essentially zero on a larger eval group, in which
case the sampled metric alone is trustworthy and the greedy pass can be dropped for speed.

## D-013 — The sandbox's memory limit is on virtual address space, and 2 GiB is not generous

**Status:** decided, forced by a silently wrong result

`RLIMIT_AS` caps *virtual* address space, not resident memory. numpy reserves several GiB of VA it
never commits, so at `DEFAULT_MEMORY_MB = 2048` the grading child did not fail cleanly — it
thrashed against failing mmaps until the wall clock killed it. Measured: **2048 → timeout at 60 s;
8192 → solved in 0.2 s.**

A timeout scores zero, so the first GRPO run on the A40 reported `solved_any 0/60` against 6/60
measured locally on the same model. **Every correct answer scored zero, and nothing raised.** A
flat eval curve produced this way is indistinguishable from an honest "GRPO did not transfer".

It survived all of development because `_apply_rlimits` is a **no-op on Windows** — no `resource`
module — so the POSIX branch had never once been exercised. The existing memory-bomb test only
asserted the limit *kills* things; nothing asserted a legitimate solution *survives* it.
`tests/test_limits.py::test_a_numpy_solution_survives_the_default_memory_limit` closes that
direction and is mutation-checked: it fails at 2048 and passes at 8192.

The paid filter corpus was checked and is **not** affected — DeepCoder's problems are plain-Python
competitive programming and never approach the limit. Only the catalogue's ML/DL problems import
numpy.

**Reverses if:** a real memory bomb gets through 8 GiB. The correct answer then is a cgroup or
`RLIMIT_DATA`, not a lower `RLIMIT_AS` — the failure mode above would simply return.

## D-012 — Train on the 1060 with any signal, not the 184 strictly in band

**Status:** decided, on measurement

The filter reported 184 problems in the 10–90% band and **1060 with any signal at all** — the extra
876 never fully solve but score partial credit. GRPO trains on `--signal any`.

**Group advantages need variance *within* a group, not a nonzero pass rate.** A problem where
completions score 0.3, 0.0, 0.15 carries a perfectly good gradient and contributes nothing to
`pass_rate`. Discarding those would throw away 83% of the usable corpus on a technicality of how
the band was defined.

This is the same argument that took the 60 local problems from 7 usable under a binary reward to 27
under partial credit, reproducing at scale. Measured dead-group rate on the wider set was 16–32%,
so the partial-credit problems demonstrably do carry gradient.

**Reverses if:** the dead-group rate on the wider set approaches 1 while the strict band stays low
— that would mean the extra problems are contributing dead groups rather than signal.

Decisions waiting on a measurement say so, and name the measurement.

---

## D-001 — Volume disk, no network volume

**Status:** decided. Reversed to a network volume during an A6000 draft, then reversed back when the
card became the A40 — history kept below, because the reasoning is the useful part.

**The decisive fact is availability: an A40 pod offers volume disk, not network storage.** That
settles it before any cost argument, and it is why the A40 was chosen knowing it.

The cost argument still points the same way. The two are billed on different clocks: a network
volume bills **calendar** time, a volume disk bills **pod** time. 100 GB of volume disk across this
plan's 65 pod-hours is **$0.90**; a network volume alive across ~2 months of calendar is **$14.00**.
D-008 sharpened that by moving iteration to the local card — fewer pod hours, spread over more
calendar, which is the worst possible shape for continuous billing.

And the constraints remain, from `create-network-volumes`:

> Select a GPU type (**available options depend on volume location**)

> Network volumes must be attached during Pod deployment. They **cannot be attached or detached
> later** without deleting the Pod.

P2c needs a 4× pod, which is the scarcest configuration in the plan. Pinning to one datacenter's
inventory for it, irreversibly, is the wrong risk to take for six dollars.

**Chosen:** a ~100 GB **volume disk** per pod, `HF_HOME=/workspace/hf`, results in git.

~18 GB of weights and ~10 GB of packages re-download in minutes. At $0.88/hr a 10-minute setup is
**$0.15 a session**. What the plan *produces* that must survive is kilobytes of JSON, which belongs
in version control; a checkpoint that must cross phases goes to a private HuggingFace Hub repo.

**Consequence:** terminate pods between phases rather than stopping them — a stopped pod bills its
volume at the *higher* idle rate while doing nothing.

**The intermediate position, recorded because it was not silly.** During the A6000 draft this was
reversed to a ~50 GB network volume, on the argument that standardising on one GPU type removes the
datacenter-hopping that made pinning expensive, and that $6 is not worth optimising. That argument
is sound on its own terms. It died on a fact rather than a counter-argument: the A40 does not offer
network storage.

**Rates, verified** (`docs.runpod.io/pods/storage/types`): container disk $0.10/GB/mo; volume disk
$0.10/GB/mo running and $0.20 stopped; network volume $0.07/GB/mo to 1 TB, $0.05 beyond.

**Unresolved, deliberately not planned around:** a third-party post claims Community Cloud pods can
be preempted without warning. RunPod's primary docs do not say so; their guides only say Community
machines "often function like spot instances", and Spot is a separate opt-in pod type. The
kill-and-resume work covers it either way — a vanished host and a dead rank are the same failure.

---

## D-002 — Development card vs measurement card — superseded in part by D-009

**Status:** decided

**Superseded by D-009 on the hardware, kept for the rule.** The original split was A40 for
development and L40S for reported numbers. D-009 standardised on the A40 for everything rented and
moved FP8 and kernels to the local Blackwell card. What survives unchanged, and is the reason this
entry stays, is the *rule* below. But the A40 is **Ampere and has no FP8**,
and Ampere and Ada differ in tensor-core paths and cuBLAS kernel selection, so a table with rows from
both measures the hardware rather than the strategy.

**Chosen — the reporting rule:**

- **Quality metrics may come from the A40.** pass@1, dead-group rate, reward curves are properties of
  the model, not the silicon.
- **Every throughput or memory number in a comparison table comes from an L40S**, one architecture
  per table.
- **The gradient check's single-GPU reference runs on the L40S pod**, one process on the 2× pod —
  never on the A40. That assertion's whole value is near-bitwise agreement, and a cross-architecture
  comparison would confound exactly the thing being asserted.

**Consequence:** 49 of 80 budgeted hours run at $0.35. It also means no pod ever mixes the two — a
RunPod pod is one GPU model, so the "mix" is two independent jobs, never one distributed job.

**Reverses if:** L40S availability collapses. RTX 6000 Ada at $0.74 is the substitute; it is Ada, so
the rule survives the swap intact.

---

## D-003 — Adafactor BF16 across the whole parallelism table

**Status:** decided

The memory audit's validated estimator (worst error 2.42% static, 9.51% activation) puts a
full-parameter 7.6B fine-tune with 8-bit AdamW at **46.19 GiB peak** on a 48 GB card — 1.81 GiB of
headroom, and DDP does not shard the optimizer. Adafactor BF16 with gradient checkpointing peaks at
**31.65 GiB** at seq 1024 and fits every strategy in the table.

**Chosen:** run DDP, ZeRO-2, ZeRO-3, FSDP2 `SHARD_GRAD_OP` and FSDP2 `FULL_SHARD` all on Adafactor.

This is a constraint, not a preference. With 8-bit AdamW the DDP row would not run at all, and a
table missing its baseline compares the sharded strategies only to each other.

**Consequence:** the table measures parallelism, not optimizer choice. Say so in the write-up; do not
let an Adafactor number be read as a general 7.6B throughput figure.

**Reverses if:** the model under test shrinks enough that AdamW fits DDP, at which point the baseline
is available and the constraint is gone.

---

## D-004 — Everything runs on Secure. The question dissolved rather than being measured

**Status:** decided — **and it reverses my own recommendation**

The plan was to probe both tiers and move the reported legs to Community if they measured within
~15%. That was justified against a **saving of roughly $14**, computed when the plan was on L40S at
$0.79/$0.99.

**D-009 moved the cloud card to the A40 and halved every rate — which halved the reason to use
Community too, and I carried the recommendation forward without redoing the sum.** Recomputed:

| | Mixed tiers | All Secure |
|---|---|---|
| P2a / P3a / P3b (development) | $16.10 | $20.24 |
| P2b / P2c / P4b (reported) | $20.24 | $20.24 |
| **Total plan** | **$38.12** | **$42.26** |

**The entire value of running anything on Community is $4.14.**

RunPod's own console warns on selection: *"Community Cloud performance is unpredictable and may
result in unexpected behavior. Secure Cloud offers better reliability and is recommended for all
production and development use cases."* Note *development*, not just production — so it does not
even hold for the 40 hours budgeted to iteration.

**Chosen:** Secure for everything. $4.14 buys the removal of an uncontrolled variable from every
number this project produces, and the numbers *are* the deliverable. A parallelism table measured on
hardware whose vendor declines to vouch for its consistency is weaker evidence, and no amount of
careful methodology repairs that.

**Consequence:** the Community P0 leg is not worth running. Not because the measurement would be
uninteresting, but because it would inform a choice worth $4.14 that has already been made the other
way. `docs/METRICS.md` keeps the Community column reading NOT MEASURED, which is accurate — it was
never measured, and now will not be.

**Reverses if:** the plan grows by roughly an order of magnitude in GPU hours, at which point 18%
starts to be real money and the trade is worth re-examining. At 65 hours it is not.

**What this does not change:** the fault-tolerance work stands on its own. It was built for a dying
rank, and a Secure pod can still lose one.

---

## D-005 — Parallelism route

**Status:** **open — decided by P0**

The routing table is in `training/platform_probe.py` and is applied to NCCL busbw at ≥256 MiB:

| busbw | Route |
|---|---|
| > 20 GB/s | ZeRO-2 and ZeRO-3 both viable |
| 5–20 GB/s | ZeRO-2 / FSDP2 `SHARD_GRAD_OP` only, high gradient accumulation |
| < 5 GB/s | Multi-GPU is net negative — that becomes the finding |

**Measured on Secure: 22.11 GB/s, transport P2P.** That clears the top band, so **ZeRO-2, ZeRO-3,
FSDP2 `SHARD_GRAD_OP` and `FULL_SHARD` are all viable** and P2b runs the full five-row table.

It cleared it **without NVLink**. `nvidia-smi nvlink -s` reported all links inactive and `topo -m`
showed `PIX`, a PCIe switch, so this is PCIe peer-to-peer. D-009 argued the A40's NVLink bridge might
be what made the top band reachable; the measurement says PCIe P2P on this host is enough on its
own. Worth knowing, because it means no pod-hunting for a bridge.

Community is still NOT MEASURED, and that is D-004's business rather than this entry's.

---

## D-009 — A40 is the cloud card, and FP8 moves to the local Blackwell

**Status:** decided. Supersedes the A40/L40S allocation in D-002 and D-008.

A40, 48 GB, **Community $0.35 / Secure $0.44** — against L40S at $0.79/$0.99. Half the price for the
same VRAM, and it offers **volume disk**, which is the storage D-001 chose.

(An intermediate draft picked the RTX A6000 and counted network storage in its favour; D-001 had
already ruled network storage out, so that was an argument for a thing we do not want. The A6000
also cannot be booked ×2, which settles it.)

**Two consequences, one bad and one better than expected.**

**Ampere has no FP8.** The A40 is GA102, compute capability **8.6**, below the 8.9 floor. With the
A40 as the only cloud card there is no Ada, Hopper or Blackwell left in the cloud tier, so P4b's
FP8-vs-BF16 comparison has nowhere to run there.

Resolved by running it on the local 5060 Ti. An FP8/BF16 comparison measured on **one** card is
internally self-consistent, and the 2.01× ratio in D-008 is a real measurement. What is lost is
comparability of the absolute TFLOP/s to a datacenter part, so the claim is scoped to the ratio and
names the card. The escape hatch, if a datacenter FP8 number is ever wanted, is a single `l40s x1`
Secure session at $0.99/hr — deliberately a bolt-on, not a dependency.

**Dual A40 supports a third-generation NVLink bridge at 112.5 GB/s bidirectional** (NVIDIA's own
specification). The L40S has none at all; dual-L40S talks over PCIe. The P0 routing table's top band
is `> 20 GB/s -> ZeRO-2 and ZeRO-3 both viable`, which NVLink clears comfortably and PCIe might not.
This makes the parallelism phase *more* likely to produce a full five-row table, on the cheaper card.

**Not assumed:** whether a given RunPod A40 pod has the bridge fitted is not implied by the GPU name.
That is exactly what `make probe` measures, so P0 gained value rather than losing it.

**Revised reporting rule.** One architecture per table still holds, and the architectures are now
Ampere (A40) for everything rented and Blackwell (local) for FP8 and kernel development. The two must
never appear in the same table.

**Budget:** **$38.82 over 65 cloud hours**, down from $76.84 — A40 Secure is 44% of L40S Secure, and
kernel development, FP8 and serving all moved local. See `docs/PLAN.md`.

**The caveat, now measured and smaller than I claimed.** I estimated the A40 at ~75 TFLOP/s dense
BF16 and called it 2.4× slower than an L40S. The probe measured **107.18 TFLOP/s** on the Secure
pod. Against the L40S's ~181 spec figure that is ~1.7×, not 2.4× — and at 2.25× cheaper the A40 is
*better* value than I told you, not merely comparable. (Loose comparison: a measured number against
a spec sheet.) The saving is real for everything
wall-clock-bound, and for memory-bandwidth-bound training the gap narrows to 1.24× (696 against
864 GB/s). NVLink, if the pod has it, is the term that could make the A40 outright better.

---

## D-011 — vLLM cannot run under WSL2: UVA is not available

**Status:** decided, forced by a hard failure

P3a's plan to run GRPO locally rested on a colocated vLLM. It cannot be colocated because it cannot
start at all:

    RuntimeError: UVA is not available
      vllm/v1/worker/gpu/buffer_utils.py -> UvaBuffer.__init__

**Unified Virtual Addressing is not exposed through WSL2's paravirtualisation layer.** This is the
same class of limitation as the WDDM spill that `memory_guard.py` exists to detect: the layer
between the process and the device reinterprets memory, and some primitives simply are not there.
vLLM 0.26 allocates a UVA buffer during engine init, before any model is loaded, so no memory
setting avoids it. `VLLM_USE_V1=0` fails identically.

**The trainer side is unaffected** — it loaded in 3.12 GiB in the same run, and the whole suite still
passes. Only the inference engine is blocked.

**Consequence for P3a.** The earlier fit measurement was right about the arithmetic and wrong about
the conclusion: 4.32 GiB of headroom is ample, and irrelevant, because the thing it was headroom for
will not start. Local GRPO is still possible with HuggingFace `generate` for rollouts, but that is
the path already measured at ~13 s per problem — roughly 87 hours to filter 24K — so it is viable
for a demonstration and not for the corpus work.

**So the filter pass and any serious GRPO run move to the A40**, where native Linux has UVA. That
restores roughly $5–10 to the plan and is the correct place for it: rollout throughput is exactly
what a rented card buys.

**Reverses if:** WSL2 gains UVA, or vLLM adds a path that does not require it. Neither is worth
waiting for.

**Not tried, deliberately:** running vLLM in a Docker container under WSL2. It shares the same
kernel and the same paravirtualised GPU, so it would fail the same way, and confirming that costs
an hour to learn nothing.

---

## D-010 — Triton kernel work runs under WSL2, not Windows

**Status:** decided, forced by a fact rather than chosen

D-008 moved kernel development to the local card. That is still right, but it was only half an
answer: **the local card is behind Windows, and Triton has no official Windows build.** Measured on
this machine, `torch 2.9.0+cu129`:

    import triton                      -> ModuleNotFoundError
    torch.utils._triton.has_triton()   -> False

So Inductor and every hand-written Triton kernel are unavailable on the Windows interpreter,
regardless of the GPU being present and working.

**WSL2 reaches the same physical GPU.** `nvidia-smi` inside Ubuntu reports the same RTX 5060 Ti,
16311 MiB, driver 591.86, and the Linux wheels bring Triton with them. So P4a runs there.

**Consequence for the code**, which is the part worth getting right: `training/kernels/` must import
cleanly without Triton, because the Windows suite still has to run. It does, and `fused_available()`
exists so that a benchmark cannot report a "fused" number that was silently `F.cross_entropy` on a
machine that never had Triton. **A fallback nobody can detect is worse than no fallback.**

**Consequence for the numbers:** WSL2 is still WDDM-backed, so D-008's rule stands unchanged — local
figures are for correctness and ratios, never for a table beside a datacenter part.

**Reverses if:** an official Triton Windows build appears. Unofficial `triton-windows` packages exist
and were deliberately not used: an unofficial compiler backend is not a thing to put underneath a
correctness argument.

---

## D-008 — Three tiers, not two: the local card does correctness, RunPod does numbers

**Status:** decided, and measured on the card rather than argued from spec sheets

The plan was written as if the only hardware was rented. There is an **RTX 5060 Ti, 16 GB,
compute capability 12.0** on the desk, with CUDA 12.9 and `nvcc` already installed, and it changes
the allocation.

**The correction that matters: FP8 does not require renting an Ada card.** The plan treated the
L40S as the only FP8 path because "FP8 requires compute capability ≥ 8.9 (Ada/Hopper/Blackwell)".
sm_120 is Blackwell, which satisfies that — and it is not a paper claim:

| Measured locally, `torch 2.9.0+cu129` | |
|---|---|
| Device | RTX 5060 Ti, 15.93 GiB, sm_120, 36 SMs |
| BF16 matmul (8192², sustained) | **48.5 TFLOP/s** |
| FP8 e4m3 via `torch._scaled_mm` | **97.4 TFLOP/s** — 2.01× |
| FP8 relative error vs fp32 | 0.0377 |
| `torch.profiler` returns CUDA events | **yes** |
| `ncu` present | yes (`nsys` no) |

So FP8 *development* — numerics, scaling factors, whether TransformerEngine builds at all — is
local, unmetered work, and the 2× ratio is reproducible here. Only the reported comparison needs a
rented card, for a reason that has nothing to do with capability.

**For scale: an A40 is ~362 TFLOP/s BF16 dense.** The local card measured 48.5. That is roughly a
seventh, which is the clearest possible statement of what it is for — correctness at speed-of-
iteration, never a throughput figure.

**The three tiers:**

| Tier | Hardware | What it is for |
|---|---|---|
| Local | RTX 5060 Ti, 16 GB, Blackwell, WDDM | Correctness, kernels, FP8 numerics, iteration. **Never a reported number.** |
| Cheap cloud | A40 ×1, 48 GB, Ampere | Anything needing >16 GB that is still single-GPU |
| Reported | L40S ×1/2/4, Ada | Every number in a comparison table; everything multi-GPU |

**Two hard constraints, both of which make local numbers non-comparable by construction:**

1. **A third architecture.** The reporting rule said "one architecture per table" to keep Ampere
   and Ada from being mixed. Blackwell is a third. A local figure cannot join a table with either
   of the others, so it is never a measurement — it is a check that the code is right.

2. **WDDM, which this repo already knows about.** `memory_guard.py` exists because under WDDM the
   driver silently spills GPU allocations to host RAM instead of raising OOM, so an oversized run
   executes over PCIe while every log line looks healthy. Its docstring cites the observed case: a
   backward pass reaching **28.77 GiB on a 16 GiB card** without failing. That is this card. Local
   memory and throughput figures are therefore suspect *by default*, which is exactly the thing
   the guard was written to detect and has never once been run against.

**Consequence, and it is the real win.** The saving is not the ~$16 of A40 time. It is that the
plan budgeted **46 of 80 hours to iteration** — trainer debugging, GRPO tuning, kernel development
— and iteration under a meter is rushed iteration. Those hours move to a card that costs nothing
per hour.

**Being measured before the phase table is rewritten:** whether Qwen2.5-Coder-1.5B-Instruct with
LoRA and vLLM colocated fits in 16 GB, which decides whether P3a's 22 hours move local or stay on
the A40. Asserting it would be the kind of unmeasured claim this file exists to prevent.

**Reverses if:** nothing. Even if everything fits locally, P0, P2b and P2c stay rented — they need
two and four GPUs, and no amount of local VRAM produces a second card.

---

## D-007 — Packing correctness rests on the mask, not the position reset

**Status:** decided, and it corrects an inherited claim

`packing.py` stated that block-diagonal attention and the `position_ids` reset were *both*
required to stop cross-document contamination. Measured on a float64 oracle model
(`training/numerics/reference.py`), that is true of the mask and false of the reset.

Packed and unpacked gradients agree exactly. They **still** agree when position_ids run 0..N
across the whole buffer, and when every document is shifted by +1000 — bit-identical loss,
75.4184506421 in all three cases. RoPE is a relative encoding: the attention score between *i* and
*j* depends only on (*i* − *j*), so once the mask stops attention crossing a document boundary,
the offset a document starts at is unobservable. Only permuting positions *within* a document
moves the loss.

**Chosen:** reset positions anyway, and keep both properties pinned by tests that say which is
which. `test_rope_makes_a_documents_starting_offset_invisible` asserts the invariance;
`test_position_reset_is_required_for_absolute_encodings` runs the same corpus through a learned
absolute embedding, where the reset *is* load-bearing.

**Consequence:** if a packing bug ever appears, look at the mask first. The reset is defence in
depth, and a green position-handling test is not evidence the mask is right.

**Reverses if:** the model swaps to an absolute or hybrid position encoding, at which point the
reset moves from defence in depth to required — which is exactly what the second test measures.

---

## D-006 — The catalogue hash is updated by hand

**Status:** decided

`tests/test_differential.py` pins the sha256 of `data/catalogue.json`'s bytes. That pin is the token a
training run reports to prove *which* answer key it graded against, so it is updated as a deliberate
edit when the catalogue is re-exported. A hash that updated itself would prove nothing.

The pin is on the file's bytes rather than the document's own `contentHash` for a measured reason:
the exporter hashes `JSON.stringify(payload)`, where `1e-5` serialises as `0.00001`, while Python's
`json.dumps` emits `1e-05`. Reproducing the exporter's hash in Python would mean reimplementing
ECMAScript number-to-string for no benefit.

**Reverses if:** the exporter ever emits a canonical form both languages agree on.
