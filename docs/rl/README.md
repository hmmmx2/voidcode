# VoidCode Training

Training and post-training infrastructure for the VoidCode tutor: distributed SFT, GRPO on a
verifiable reward, Triton kernels, and FP8 — on RunPod.

Separate from the [desktop application](../swinburne_ai_tutor_project), which is a shipped
Electron/TypeScript product with its own CI, licence gate and packaging tests. The two exchange
exactly one artefact: `data/catalogue.json`.

**Nothing here has run on a GPU yet.** The plan is `docs/PLAN.md`; what is built so far is the reward
harness, which is CPU-only by design.

## What exists

| | Status |
|---|---|
| **Reward harness** (`reward/`, `tests/`) | Built and verified. 10/10 mutants killed |
| **P0 platform probe** (`training/platform_probe.py`) | Built. Runs on a fresh box before any pip install |
| **`MemoryGuard`, multipack** (`training/`) | Ported, and now actually wired into `trainer.py` |
| **Packing correctness** (`training/collate.py`, `numerics/`) | **Proved on CPU.** Packed and unpacked gradients agree exactly |
| **Fault tolerance** (`training/faulttol/`) | **Proved on CPU.** Process killed mid-run, resumed, curve identical |
| Platform measurement (P0) | **Not run** — needs a RunPod pod |
| Parallelism benchmarks (P2b/P2c) | Not started — needs 2 and 4 GPUs |
| GRPO (P3) | Not started |
| Kernels and FP8 (P4) | Not started |

69 tests, all CPU-only. `docs/METRICS.md` is the ledger; every GPU row in it currently reads
`NOT MEASURED`, which is accurate rather than pending.

Two P2 properties are settled without renting anything, because they are identical at 30k
parameters on a laptop and at 7.6B on two A40s: **packing is correct** (packed and unpacked
gradients agree exactly — `make test`) and **a killed run resumes to the same curve**
(`make faulttest`). Only the throughput numbers need the pod.

## Which GPU, and why

Only one phase needs two GPUs in one pod — the DeepSpeed/FSDP2 comparison. The memory audit shows a
full-parameter 7.6B fine-tune fits on **one** 48 GB card with Adafactor (31.65 GiB peak at seq 1024),
so training never needed a pair; comparing parallelism strategies does.

RunPod, **A40 throughout** (D-009). The tier is part of the rate, so each row names the one it is
budgeted at - development on Community, reported numbers on Secure:

| Work | GPU | Tier | $/hr | Why |
|---|---|---|---|---|
| Iteration: GRPO tuning, trainer debugging | **A40 x1** | Community | 0.35 | 48 GB, the cheapest 48 GB RunPod has |
| Parallelism table, fault tolerance, NCCL | **A40 x2** | Secure | 0.88 | A collective needs two ranks |
| Scaling curve 1->2->4 | **A40 x4** | Secure | 1.76 | A curve needs three points |
| Reported kernel benchmark | **A40 x1** | Secure | 0.44 | One architecture per table |
| **Kernels, FP8, serving** | **local 5060 Ti** | - | **0** | Blackwell sm_120 *does* FP8 - see below |

**The A40 cannot do FP8** - it is Ampere, compute capability 8.6, below the 8.9 floor. That is fine,
because the local RTX 5060 Ti is Blackwell (12.0) and measures FP8 at 97.4 TFLOP/s against 48.5 for
BF16. The FP8-vs-BF16 table is therefore entirely local, internally consistent, and labelled as such.

**A40 takes a third-generation NVLink bridge at 112.5 GB/s**, which the L40S does not have at all -
so the parallelism phase may get a better interconnect than the more expensive card would have given.
Whether a given pod has the bridge fitted is not implied by the GPU name, which is what `make probe`
is for.

**The honest trade-off:** an A40 is roughly 2.4x slower than an L40S on dense BF16 while costing
2.25x less, so for compute-bound work the price per unit of work is close to a wash and the hour
estimates may need to grow. Memory bandwidth is much closer, 696 against 864 GB/s.

**Community Cloud is third-party multitenant** where availability varies by provider, so the
interconnect is not a property of the GPU name. Run the reported legs on Secure Cloud, and run the
probe on both to see whether it matters.

**The reporting rule.** Quality metrics (pass@1, dead-group rate) may come from either card - they
are properties of the model. Every throughput or memory number in a comparison table comes from the
rented A40, except the FP8 table which is entirely local. One architecture per table, always, and
no local *memory* figure is comparable at all because the box is WDDM.

## Storage: volume disk, no network volume

A network volume "constrains worker deployments to that volume's datacenter, which may limit GPU
availability", and when creating a pod you "select a GPU type (available options depend on volume
location)". This plan hops between 1x/2x/4x and Ampere/Ada by design, so pinning a datacenter fights
it — the same constraint you see from the other side when an A40 offers volume disk only.

What must survive is **kilobytes of JSON, which belong in git**. Weights (~18 GB) and packages
(~10 GB) are re-downloadable in minutes. Volume disk survives stop/start on the same pod, which
covers pausing mid-phase.

- **Size the volume to ~100 GB and point `HF_HOME` at `/workspace`.** The container disk is
  ephemeral; a model cached there is silently re-downloaded on every restart. `make probe` warns when
  `/workspace` is missing or is not a separate mount.
- **Volume disk costs more idle ($0.20/GB/mo) than running ($0.10).** Terminate between phases rather
  than leaving stopped pods with large volumes.
- **A checkpoint that must cross phases goes to a private HuggingFace Hub repo**, not to storage.

## Running the P0 probe

**[`docs/RUNBOOK-P0.md`](docs/RUNBOOK-P0.md) is the paste-able version** — pod settings, the exact
commands, what to read before terminating, and a symptom table. Read it before renting anything; the
one setting that costs a restart if you get it wrong is picking a `runtime` image when building
`nccl-tests` needs `nvcc` from a `devel` one.

The short form. On a fresh instance, before installing anything:

```bash
git clone https://github.com/NVIDIA/nccl-tests && (cd nccl-tests && make -j)
export HF_HOME=/workspace/hf                    # or the volume is pointless
python -m training.platform_probe --spec a40_x2_community \
  --out docs/probe-a40_x2_community.json --nccl-tests ./nccl-tests
```

Then the same command on Secure Cloud, and diff the two JSON files. **That diff is the measurement** —
Community Cloud is third-party multitenant where availability varies by provider, so two pods with the
same GPU name can have different interconnects. It also decides which tier the reported legs run on.

`--spec` is required and is recorded with every number, because Community and Secure report the same
device name to `nvidia-smi`.

The probe also reports whether `/workspace` is a real separate mount — the cheapest possible moment to
discover that it is not.

`make probe SPEC=…` wraps this. The `Makefile` targets Linux; on Windows call the module directly, as
above.

## The reward harness

GRPO needs a reward that cannot be gamed. The desktop app already is one — 60 problems, 320 cases,
**182 of them hidden**, and every expectation *derived* by executing a reference rather than typed by
hand — but its grader runs in Pyodide inside an Electron `utilityProcess`, which a training loop
cannot call.

So `reward/grader.py` reimplements the comparison rule in CPython. The whole rule is:

```
repr(round_recursive(normalise(entry(*args)), 8))
```

compared as an exact string.

### Why it is trusted

Not because it was ported carefully. Because it agrees with two implementations written by other
people, in other languages, on other interpreters:

1. **Every reference solves its own problem** — 60 of 60.
2. **202 cases against the frozen Judge0 oracle**, produced by a different interpreter on a retired
   platform. Two documented divergences are excluded *by name*, so a third would fail rather than
   blend into a tolerance rule. The app's Pyodide grader already agrees with this oracle, so
   agreement here means three independent implementations produce the same values.
3. **13 spec fixtures** — each a correct solution written independently of the reference, plus mutants
   paired with the case id that must reject them. Agreeing that a *wrong* answer is wrong is the
   property a reward function actually needs.

Plus four tests of the comparison rule itself, which exist because mutation testing found the three
arms above could not reach them: a numpy array matching the equivalent list, negative zero not
failing a correct answer, a raising submission scoring zero, and unparseable output scoring zero
rather than crashing the trainer.

### Running it

```bash
python -m venv .venv && .venv/Scripts/python -m pip install pytest numpy
.venv/Scripts/python -m pytest tests/ -q
.venv/Scripts/python tests/mutate_grader.py     # 10/10 must be killed
```

numpy is optional: 14 of 60 problems declare it and the other **46 need nothing outside the standard
library**, so the suite is meaningful without it — and it reports what it skipped rather than
reporting green over a subset.

### Refreshing the catalogue

From the desktop repository:

```bash
npm run export:catalogue -- <path>/voidcode-training/data/catalogue.json
```

`tests/test_differential.py` pins the file's sha256. That pin is the token a training run reports to
prove which catalogue it graded against, so **updating it is a deliberate edit** — a hash that
updated itself would prove nothing.

The pin is on the file's bytes rather than the document's own `contentHash` for a measured reason:
JavaScript and Python serialise floats differently (`1e-5` becomes `0.00001` in JS and `1e-05` in
Python), so reproducing the exporter's hash in Python would mean reimplementing ECMAScript
number-to-string.

## `data/catalogue.json` is the answer key

It carries reference solutions, `normalise` expressions and the arguments of every hidden case — all
three deliberately withheld from the desktop app's own renderer. It belongs here and must never be
served to a client or packaged into a build.
