# VoidCode Training — DeepSpeed, GRPO and FP8 on RunPod

## Context

This plan has been revised three times by patching — Thunder Compute 2× L40, then a mixed
A6000/L40 allocation, then RunPod — and the result reads as a document with edit scars. This is a
clean rewrite against the hardware you are actually on and the code that actually exists.

An inventory of both repositories found the old plan was **two commits stale and internally
inconsistent**. It did not know `training/platform_probe.py` existed, still said "12 tests" when
there are 45, still instructed you to port modules that are already committed, quoted five dollar
figures its own budget table refuted, and said "L40" in five places where the pod is an A40 —
including one paragraph that contradicted another about which card the gradient check runs on. Those
are corrected here and the repair is the first work item.

**Standing decisions, unchanged:** standalone repo; optimising for portfolio evidence in ML infra
roles; the desktop app's graded exercises as the verifiable reward; ~$150 ceiling; a mixed A40/L40S
allocation with a reporting rule; the 1→2→4 scaling curve.

---

## 1. What is already built

Verified against the repository, not assumed.

| | State |
|---|---|
| **Reward harness** — `reward/grader.py`, 243 lines | **Done.** CPython port of the app's grader |
| **Catalogue export** — `desktop/src/main/content/catalogue-export.ts` | **Done.** 60 problems, 320 cases, 182 hidden, hashed |
| **P0 probe** — `training/platform_probe.py`, 495 lines | **Done.** NCCL, topology, profilers, disk, matmul floor |
| **`MemoryGuard`** — `training/memory_guard.py`, 204 lines | **Ported and tested.** Not yet wired into a trainer — there is no trainer |
| **Multipack** — `training/packing.py`, 150 lines | **Ported and tested.** Same |
| Everything from P2 onward | Not started |

**45 tests across 4 files, all CPU-only**, plus `tests/mutate_grader.py` (10/10 killed). Three
commits: `8fc5687`, `5d7b2b0`, `89b1677`.

`data/catalogue.json` is 240 KB, sha256 `baa73a0c…`, pinned in `tests/test_differential.py`. Its
`counts` read `{problems: 60, cases: 320, hidden: 182, visible: 138, oracle: 204}`.

**Why the reward is trustworthy:** every reference solves its own problem (60/60); 202 cases agree
with the frozen Judge0 oracle, produced by a different interpreter on a retired platform, with two
divergences excluded *by name* so a third would fail; and 13 spec fixtures require that a *wrong*
answer is wrong. Three independent implementations, one set of values.

---

## 2. Hardware

### RunPod inventory, Community / Secure hourly

| GPU | VRAM | Arch | FP8 | Community | Secure |
|---|---|---|---|---|---|
| **A40** | 48 | Ampere | **no** | **0.35** | 0.44 |
| RTX A6000 | 48 | Ampere | no | 0.33 | 0.49 |
| L40 | 48 | Ada | yes | 0.69 | 0.82 |
| RTX 6000 Ada | 48 | Ada | yes | 0.74 | 0.77 |
| **L40S** | 48 | Ada | yes | **0.79** | **0.99** |
| A100 PCIe | 80 | Ampere | no | 1.19 | 1.39 |
| H100 PCIe | 80 | Hopper | yes | 1.99 | 2.89 |

Multi-GPU pods price as *n* × the single rate.

- **A40 is the only rented card** — see D-009. Same 48 GB as an L40S for 44% of the Secure rate, and
  it takes a **third-generation NVLink bridge at 112.5 GB/s**, which the L40S does not have at all.
- **It is Ampere, cc 8.6, so it cannot do FP8.** That is fine: FP8 runs on the local Blackwell card
  (D-008), where it measures 97.4 against 48.5 TFLOP/s.
- **The trade-off, stated plainly.** An A40 is ~2.4× slower than an L40S on dense BF16 while costing
  2.25× less, so for compute-bound work price-per-unit-work is a wash and hour estimates may grow.
  Memory bandwidth is much closer — 696 against 864 GB/s — and LLM training is often bandwidth-bound.
- **Community Cloud is third-party multitenant** where availability "varies by provider", so the
  interconnect is not implied by the GPU name. Reported numbers come from Secure.
- **L40S / H100 remain the escape hatch** if a datacenter FP8 number is ever wanted.

### Storage: volume disk, no network volume

A network volume *"constrains worker deployments to that volume's datacenter, which may limit GPU
availability"*, and when creating a pod you *"select a GPU type (available options depend on volume
location)"*. This plan moves between 1×/2×/4× and Ampere/Ada by design, so pinning a datacenter
fights it — which is the same constraint seen from the other side when an A40 offers volume disk only.

The plan downloads ~18 GB of weights and ~10 GB of packages, both re-downloadable in minutes. What it
*produces* that must survive is **kilobytes of JSON, which belong in git**. Volume disk survives
stop/start on the same pod, covering continuity within a phase.

- **Size the volume to ~100 GB and `export HF_HOME=/workspace/hf`.** The container disk is ephemeral;
  a model cached there is silently re-downloaded on every restart. `make probe` warns when
  `/workspace` is missing, and when it exists but is not a separate mount.
- **Volume disk costs more idle ($0.20/GB/mo) than running ($0.10).** Terminate between phases.
- **A checkpoint that must cross phases goes to a private HuggingFace Hub repo**, not to storage.

### Why not two GPUs for everything

The memory audit's validated estimator (worst error 2.42% static, 9.51% activation) says a
full-parameter **7.6B fine-tune fits on one 48 GB card**:

| Config, one 48 GB card | Static | Peak @1024 | @2048 | @4096 | Fits |
|---|---|---|---|---|---|
| 8-bit AdamW, no master | 43.62 | 46.19 | | | **No** — 1.81 GiB free |
| **Adafactor BF16 + GC** | 29.08 | **31.65** | 34.10 | 38.99 | **Yes** — max seq ≈6,100 |
| GaLore r128 8-bit | 19.20 | 21.77 | 24.22 | 29.11 | Yes — max seq ≈10,200 |

Training never needed a pair. **Comparing parallelism strategies does**, and that comparison is the
DeepSpeed deliverable. Two GPUs are required for NCCL, the strategy table and the rank-kill test;
four for the scaling curve; one Ada card for FP8; one card for everything else.

**A pod is one GPU model**, so the local card and the rented ones never share a job. Local plus cloud
is two independent jobs, not one distributed one. Multi-node stays out of scope rather than faked.

### The reporting rule

Two architectures are now in play — **Ampere** (rented A40) and **Blackwell** (local 5060 Ti) — and
the rule is that they never appear in the same table.

- **Quality metrics may come from either** — pass@1, dead-group rate, reward curves are properties of
  the model, not the silicon.
- **Every throughput or memory number in a comparison table comes from the A40**, except the FP8-vs-
  BF16 table, which is entirely local and says so. One architecture per table, always.
- **No local memory figure is comparable at all.** The box is WDDM, which is the hazard
  `MemoryGuard` exists to detect — see D-008.
- **The gradient check's single-GPU reference runs on the A40 pair** (one process on the 2× pod),
  never on the local card. Cross-architecture float comparison would confound the one assertion
  whose entire value is near-bitwise agreement.

---

## 3. Phases

### P-fix — repair the record. CPU, $0. **Done.**

The rewrite exposed drift that would have misled anyone executing against these files. Recorded
rather than quietly fixed, because the list is the argument for re-reading a document instead of
patching it again.

- **`docs/PLAN.md`** — replaced with this document.
- **`Makefile`** — five stale strings. `help` and the `probe` error advertised
  `SPEC=l40_x2_production` and `SPEC=l40_x2_prototyping`, **spec names that no longer exist**; the
  live ones are `a40_x2_community` / `a40_x2_secure`. `fp8-bench` said "an L40, never the A6000",
  neither of which is in the plan. `bench-scaling` said "production mode only".
- **`README.md`** — the GPU table quoted **Community** rates (1.58, 3.16) where the budget uses
  **Secure** (1.98, 3.96). Each row now names its tier, and both sets are given.
- **"44 of 60 problems are pure stdlib" was wrong — it is 46.** 14 declare `numpy`; the other 46 need
  no third-party package, and two of those declare `collections` and `math`, which *are* stdlib. The
  44 counted problems with an *empty* import list. Same error in `tests/test_differential.py`'s
  docstring. `test_coverage_is_honest` computes the split at runtime, so no assertion was wrong —
  only the prose describing it.
- **`training/memory_guard.py`** stated Thunder Compute's prototyping tier as a *live* justification.
  Now history, with the live argument resting on RunPod Community Cloud. The two Thunder references
  in `training/platform_probe.py` were already past-tense and attributed, and stay.
- **`tests/` fixtures** — `l40_x2_production` as a spec string and a `$2.78/hr` figure from the old
  provider; `A6000_CAPACITY` naming a card no longer in the plan for what is really the 48 GiB every
  candidate shares.
- **`docs/DECISIONS.md`** — referenced by two documents and did not exist. Written, with D-004 and
  D-005 left explicitly open because P0 decides them.

**Acceptance, met:** no file names a spec key, GPU or make target that does not exist; `make help`
prints runnable commands; the stdlib count is 46 everywhere; 45 tests still pass.

### P0 — Platform truth. `a40 x2`, 2 h, **$3.56**. Gates everything.

**Runbook: [`docs/RUNBOOK-P0.md`](RUNBOOK-P0.md)** — pod settings, commands, the read-before-you-
terminate list, and a symptom table. One hour on Community, one on Secure, running the built probe
unchanged:

```bash
export HF_HOME=/workspace/hf
git clone https://github.com/NVIDIA/nccl-tests && (cd nccl-tests && make -j)
make probe SPEC=a40_x2_community
make probe SPEC=a40_x2_secure
```

**The diff is the deliverable**, not just a gate. Community is third-party multitenant, so two pods
with the same GPU name can have different interconnects, and nobody publishes that. It also decides
which tier the reported legs run on — if Community measures within ~15% of Secure, run everything on
Community and save ~$14.

The probe already reports: NCCL busbw at ≥256 MiB and the transport selected, topology and PCIe link,
peer-to-peer per ordered pair, whether `torch.profiler` returns real CUDA events, whether `ncu`/`nsys`
work, compute capability (so FP8 is confirmed not assumed), a BF16 matmul floor, and whether
`/workspace` is a real separate mount.

**Routing, from the measured number:**

| busbw ≥256 MiB | Route |
|---|---|
| > 20 GB/s | ZeRO-2 and ZeRO-3 both viable |
| 5–20 GB/s | ZeRO-2 / FSDP2 `SHARD_GRAD_OP` only, high gradient accumulation |
| < 5 GB/s | Multi-GPU is net negative — report that as the finding |

**Acceptance:** two JSON records in `docs/`, the route recorded in `docs/DECISIONS.md` with the number
that drove it, and `docs/METRICS.md`'s P0 table filled.

### P1 — Reward harness. **Done.** $0.

`reward/grader.py` reproduces `repr(round_recursive(normalise(entry(*args)), 8))` compared as an exact
string. Nothing further is required; it is the input to P3.

### P2 — SFT, parallelism, fault tolerance. **$43.80.**

**P2a — trainer development. `a40 x1`, 12 h, $4.20.** ~~Dataloader, wire in `MemoryGuard` and
`packing.py` (both ported, neither yet called by anything)~~ **— the wiring is done.** As of the P3
session, `training/trainer.py` imports and uses both: `MemoryGuard.for_current_device()` at line
113 (disabled and no-op on CPU, so the loop runs either way) and `pack()` at line 65 via
`batch_for_step`, with `packed_inputs` from `collate.py` at line 123. `training/parallel/bench.py`
also constructs a `MemoryGuard`. The loop is covered by `tests/test_faulttol.py`, whose
save/resume cases are what `build_state`'s momentum choice exists to make falsifiable.

**What actually remains of P2a is the single-GPU 7.6B Adafactor run end to end**, which needs the
card. The CPU-side work this line was written to schedule has already happened incidentally.

**P2b — the parallelism table. `a40 x2` Secure, 14 h, $27.72.** The DeepSpeed deliverable. Build both
and measure — the platform branch's `FINETUNING_BLUEPRINT.md` argues FSDP2 *over* DeepSpeed at this
scale, and a table settles it better than a preference.

| Strategy | Note |
|---|---|
| DDP | baseline |
| DeepSpeed ZeRO-2 | `no_sync` on micro-steps |
| DeepSpeed ZeRO-3 | only if P0's busbw permits |
| FSDP2 `SHARD_GRAD_OP` | the ZeRO-2 equivalent |
| FSDP2 `FULL_SHARD` | the ZeRO-3 equivalent |

**Run the whole table with Adafactor BF16.** This is a constraint, not taste: DDP does not shard the
optimizer, so at 7.6B with 8-bit AdamW it needs 46.19 GiB and **does not fit a 48 GB card**. Adafactor
fits every row, which is what makes them comparable.

Assert on `max_memory_reserved()` per device via `MemoryGuard` — never infer fit from the absence of a
crash. **Measure the `no_sync` trap**: the blueprint predicts a full BF16 gradient buffer at
**14.19 GiB, not 7.09**, meaning the memory table and the throughput optimisation cannot both be
quoted as written. Confirm or refute with a number. Fault tolerance: sharded
`torch.distributed.checkpoint`, `torchrun --max-restarts`, **`SIGKILL` one rank mid-run**, resume, and
assert the loss curve matches. Gradient check against a single-GPU reference **on the same A40 pod**.

**P2c — the scaling curve. `a40 x4` Secure, 3 h, $11.88.** 200 steps at 1, 2 and 4 GPUs, same config,
reporting scaling efficiency. The artifact two GPUs structurally cannot produce.

**On the data:** benchmark on a fixed public instruction corpus so throughput is reproducible, and say
plainly that the table is a *systems* measurement and not a claim the model got better. The old SFT
corpus is unusable — 1,860 examples over 13 unique problems, every one truncated — and rebuilding it
is not on this critical path.

**Acceptance:** every strategy in the table with real numbers and its pod recorded; the kill/recovery
test passes with the step and wall clock; the gradient check passes; `NOT MEASURED` wherever a run did
not happen.

### P3 — GRPO on the verifiable reward. **$17.18.**

**P3a — iteration. `a40 x1`. ✅ done.** ~~LoRA with vLLM **colocated**
(`vllm_mode="colocate"`)~~ — **as run, this used full-parameter GRPO with HF `generate`, not LoRA
and not colocated vLLM.** vLLM was never installed on that pod; P3b later measured what it would
have been worth (3.17×). Recorded rather than quietly rewritten, since the plan's cost estimate was
built on the colocated assumption.

Result: 200 steps at lr=5e-6 on 1060 filtered DeepCoder problems, **no measurable transfer** to the
60 held-out problems, on an eval verified deterministic beforehand. See `METRICS.md`.

- Reward = `reward/grader.py`, partial credit by cases passed, small format penalty for unparseable
  output.
- **Dead groups are the thing to design against.** Log the rate every step; filter to problems whose
  base pass rate is between roughly 10% and 90%, *measured before training*; plot dead-group rate
  beside reward, because a reward curve without it is uninterpretable.
- **Write the GRPO loop yourself** and validate against TRL's `GRPOTrainer` — same batch, same seed,
  assert advantages, KL and the clipped objective agree within tolerance.
- **Reward-hacking audit** using the 13 named mutants as a regression set; monitor KL; record in
  `docs/RL_FINDINGS.md`.

**P3b — the physical split. `a40 x2` Community, 6 h, $4.20.** Trainer on GPU 0, `trl vllm-serve` on
GPU 1. This earns the trainer–inference separation claim and the weight-sync overhead number;
colocate produces neither.

**The honest constraint:** 60 problems is small and the 10–90% filter cuts it further. This is a
demonstration of a genuinely verifiable RL loop, not a large run, and the write-up must say so. If
dead groups make training impossible, the documented fallback is a public verifiable corpus for
training with all 60 app problems held out for evaluation.

**Acceptance:** pass@1 improves on held-out; dead-group rate, KL and reward on one plot; weight-sync
cost measured; PPO comparison arm populated; at least one hacking attempt found and documented, or its
absence argued with evidence.

### P4 — Kernels and FP8. **$10.14.**

**P4a — kernel development. `a40 x1`, 12 h, $4.20.** Fused cross-entropy first, justified by your own
measurement: at seq 1024, **2.04 GiB of 2.57 GiB** activation is the loss head and 0.19 GiB is all 28
transformer layers. Then fused RMSNorm with residual. Correctness and iteration here.

**P4b — the reported numbers. `a40 x1` Secure, 6 h, $5.94.** Re-benchmark both kernels on Ada against
eager and `torch.compile` — per the reporting rule, a table's numbers come from one architecture —
then **FP8 vs BF16 through TransformerEngine**. L40S FP8 is 733 TFLOPS dense against 362 BF16, so the
ceiling is 2× and the real figure will be lower.

**Known limits:** some hosts virtualise the GPU and break the profiling path, so there may be no
Nsight occupancy or roofline analysis — P0 answers whether this one does. Report wall clock, memory
and numerics, and never imply a profile that was not taken. TransformerEngine on Ada has rough edges;
`torchao` float8 is the documented fallback.

### P5 — Serve it back. **local, $0.** Re-specified.

~~`vllm serve --port 8080`~~ **— that method contradicts D-011 and was never possible on this
machine.** vLLM allocates a UVA buffer during engine init and UVA is not exposed through WSL2; it
has no native Windows support either. The phase kept a method the project had already disproved,
which is why it read as blocked rather than as needing a different tool.

**The requirement was never vLLM.** It is an OpenAI-compatible endpoint on **port 8080**, which the
desktop app's `llamacpp` provider picks up with zero code changes — and 8080 is llama.cpp's server
default, so the provider name was the clue. Ollama serves the same API and is already installed.

**Verified locally** against `qwen2.5-coder:7b` on the existing daemon:

```
POST /v1/chat/completions -> 200, model qwen2.5-coder:7b, 52 tokens, correct answer
```

To move it to the port the app expects, set the host and restart the daemon:

```
OLLAMA_HOST=0.0.0.0:8080 ollama serve
```

Left for the operator rather than done here: Ollama is a running service on this machine and other
work depends on it, so restarting it is not a change to make unattended.

**What is served is the base model.** The GRPO policy was never checkpointed — `train_grpo.py` had
no save path until after that pod was released — so the trained weights are gone. Given P3a
measured no transfer, base and trained are behaviourally equivalent here, but the write-up should
say "serving the base model", not imply otherwise. `--save-to` now exists so this cannot recur.

---

## 4. Budget

Standardised on the **A40** (D-009), with FP8, kernel development and serving moved to the local
Blackwell card (D-008). A40: Community $0.35, Secure $0.44; multi-GPU pods price as n x the single
rate.

| Phase | Where | Status | Cost |
|---|---|---|---|
| P-fix, P1 reward harness | CPU | done | $0 |
| P2 packing + fault tolerance | local | **done** — proved on CPU | $0 |
| **P0 platform truth** | `a40 x2` Secure | **done** — 22.11 GB/s, P2P, top band | $0.88 |
| **P2b parallelism table** | `a40 x2` Secure | **done** — FSDP2 SHARD_GRAD_OP wins | $1.94 |
| **P2c scaling curve** | `a40 x2` + `a40 x4` | **done** — 97% at 2, **39% at 4** | $2.55 |
| **P4a kernels** | local Blackwell | **done** — CE keeps, RMSNorm does not | $0 |
| **P4b reported kernel bench** | `a40 x2` Secure | **done** — CE 1.21x, 25% less memory | $0.26 |
| **P2a trainer development** | `a40 x1` | **done** — 7.6B fits at 37.17 GiB, 500.1 tok/s; estimator 17.4% optimistic | included below |
| **P3a GRPO iteration** | `a40 x1` (moved from local) | **done** — no measurable transfer, on a verified-deterministic eval | included below |
| **P3b GRPO trainer/vLLM split** | `a40 x1` | **done** — vLLM 3.17x per-prompt, 13.18x batched | included below |
| P4b FP8 vs BF16 | **local** Blackwell | 2.01x measured | $0 |
| **P5 serve back** | **local** | **done** — OpenAI-compatible endpoint verified; re-specified off vLLM per D-015 | $0 |
| **Spent so far** | | | **$5.63** |
| **Remaining committed** | | | **$10.56** |
| **Projected total** | | | **$16.19** |
| **Reserve against the $150 ceiling** | | | **$133.81** |

**$16.19 against $42.26 planned, 62% under.** Two things did it: D-008 moved kernels, FP8 and
serving to the local Blackwell card, and P4a's fused cross-entropy freed enough headroom
(2.61 -> 4.32 GiB) that GRPO's 22 hours fit locally too.

### P3 changed shape: the 60 are the evaluation set, not the training set

Measured twice, free, locally: Coder-1.5B puts 7 of 60 problems in the usable band; Instruct-7B puts
6, with a worse dead-group rate, and leaves 52 unsolved. **The corpus is the constraint, not the
policy.** See `docs/P3-CORPUS-SCOPE.md`.

So P3a as budgeted — 22 hours of GRPO on these 60 — is cancelled rather than rescheduled. It would
have trained against ~32 problems at a 90% dead-group rate. Training moves to **DeepCoder's 24K
verified problems**, and the 60 become what they are actually good for: a hidden-case, oracle-checked
evaluation set that appears in no public corpus.

This removes $9.68 from the plan and adds one genuinely new piece of code — a second grading mode
for pytest-style tests — which is CPU work.

### What still genuinely needs a pod, and why

- **P2a**, 12 h — a full-size single-GPU training run needs more than 16 GiB.
- **P3b**, 6 h — trainer on one GPU, `trl vllm-serve` on another. One card cannot host both as
  separate processes, and this is the only phase that yields a weight-sync overhead number.

Everything else is either finished or local.

### Booking rule, learned the expensive way

**Run `make probe` before committing hours to any multi-GPU pod.** The 4x A40 had GPU0 alone on a
NUMA node reaching the rest via `SYS`; NCCL hung outright, and with P2P disabled four GPUs were
*slower* than two. The GPU count on the order form does not tell you the topology, and finding that
out after booking hours is how a phase's budget doubles.

**P3b is kept**, having been dropped in an earlier draft on A6000 economics that no longer apply. On
an `a40 x2` Community pair it is $4.20, and it is the only phase that produces a weight-sync overhead
number - vLLM colocated cannot, by construction.

**The one thing the A40 cannot do:** FP8. It is Ampere, compute capability 8.6, below the 8.9 floor.
The FP8 comparison runs on the local card and is reported as a **ratio measured on one card**, not
as a datacenter figure. A single `a40 x1` Community session at $4.74 is the bolt-on if an Ada
number is ever wanted — it is not a dependency of anything.

---

## 5. Repository, as it will be

Built today is marked; the rest is the target shape.

```
voidcode-training/
  reward/        grader.py                        # BUILT
  data/          catalogue.json                   # BUILT, hash-pinned
  tests/         test_differential.py mutate_grader.py      # BUILT
                 test_memory_guard.py test_packing.py       # BUILT
                 test_platform_probe.py                     # BUILT
  training/      platform_probe.py                # BUILT
                 memory_guard.py packing.py       # BUILT, not yet wired
    parallel/    ddp.py zero2.py zero3.py fsdp2.py bench.py
    faulttol/    checkpoint.py elastic.py kill_test.py
    numerics/    gradcheck.py determinism.py
    kernels/     xent.triton.py rmsnorm.triton.py bench.py
    precision/   fp8_te.py compare.py
  rl/            grpo.py ppo.py rollout.py reward_fn.py curriculum.py
                 diagnostics/ dead_groups.py kl_monitor.py hack_audit.py
  configs/       ds_zero2.json ds_zero3.json fsdp2.yaml rl.yaml
  docs/          METRICS.md PLAN.md               # BUILT
                 DECISIONS.md RL_FINDINGS.md      # referenced, to create
  Makefile README.md requirements-dev.txt         # BUILT
```

Carry the discipline that made the desktop app trustworthy: **`NOT MEASURED` is never replaced by an
estimate**, every phase ends with numbers in `docs/METRICS.md`, **every number records the pod that
produced it**, and any prose claim a test could check gets a test.

---

## 6. Verification

Commands that exist today are marked; the rest arrive with their phase.

1. `make test` → 45 tests, CPU only. **Passes today.**
2. `make mutate` → 10/10 grader mutants killed. **Passes today.**
3. `make probe SPEC=…` → **built**, needs a pod. Run on both tiers; the diff is P0's deliverable.
4. `make bench-parallel` → the five-row table, tokens/s and peak reserved per device, all L40S.
5. `make faulttest` → rank killed at a recorded step, resumed, loss curve matches.
6. `make bench-scaling` → efficiency at 1, 2 and 4 GPUs.
7. `make rl-eval` → pass@1 base vs post-RL, with dead-group rate and KL on one plot.
8. `make kernel-bench` → both kernels beat eager, numerics verified forward and backward.
9. `make fp8-bench` → FP8 vs BF16 on L40S, or an explicit statement of why it did not run.
10. `vllm serve --port 8080` → the desktop app reaches it unmodified.

Refreshing the catalogue, from the desktop repo:

```bash
npm run export:catalogue -- <path>/voidcode-training/data/catalogue.json
```

The sha256 pin in `tests/test_differential.py` must then be updated **deliberately** — it is the token
a run reports to prove which catalogue it graded against, and a hash that updated itself would prove
nothing.

## 7. What would invalidate this plan

- **NCCL is poor on the pod you get.** P0 answers it in two hours for $3.56 and measures both tiers,
  so the answer is actionable rather than fatal. If Secure is also poor, P2 becomes single-GPU
  baselines plus a write-up of why — still a real result.
- **Multi-GPU L40S is unavailable when wanted.** Community supply "varies by provider", so a 4× pod is
  not guaranteed on the day. The curve degrades to 1→2; RTX 6000 Ada is the substitute part.
- **TransformerEngine will not build on Ada.** Fall back to `torchao` float8, or state FP8 was not
  tested. An H100 fallback does exist here at $1.99.
- **60 problems is too few for GRPO.** Fallback: public corpus for training, app problems held out.
- **No profiler on either tier.** Kernel work reports wall clock, memory and numerics — never an
  implied profile.

## 8. Note on the desktop repo

`v0.1.0` points at `cae9f1c`, which is **four commits behind** that branch's HEAD — the catalogue
export and the line-endings fix both land after it. That is correct for a tag, which is a snapshot,
and worth knowing only so nobody expects `git checkout v0.1.0` to contain the exporter. Nothing there
is pushed; it has no remote.
