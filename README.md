# VOIDCODE

A Socratic tutor for engineers preparing for ML/DL/LLM/VLM system-design and coding interviews, and
the training infrastructure behind the model that powers it.

This repository is the consolidation of two codebases that were developed separately and could not be
understood apart:

| Half | Was | Holds |
|---|---|---|
| **Platform** | `DUNE project/swinburne_ai_tutor_project` (`feat/voidcode-platform`) | Next.js 16 web client, FastAPI API, `features/`, `ranking/`, 200-item `content/` catalogue, `llm/` QLoRA SFT pipeline |
| **RL training** | `DUNE project/voidcode-training` (`master`) | `rl/` (GRPO, PPO), `reward/` (verifiable reward by unit tests), `training/` (kernels, fault tolerance, numerics, packing) |

Both source repositories are left untouched; this is a fresh tree, not a move.

The two halves exchange exactly one artefact: **`data/catalogue.json`** — the problem catalogue that is
also the RL reward function's answer key. It is git-ignored here (see `.gitignore`); it must exist on
disk for `tests/test_differential.py` to run, and must never be published.

---

## Honest status

Combined from both halves. Nothing below is aspirational — where something is not built, it says so.

| Area | Status |
|---|---|
| Web client, API, Judge0 sandbox, Postgres/Redis | Built |
| Content catalogue | **200 items**, of which **125 executable across 699 test cases**, every reference solution re-verified in CI |
| Two-stage recommender (candidate gen + 11-feature LightGBM LambdaMART) | Built |
| Hint-ladder / disclosure validator | Built |
| QLoRA SFT of Qwen 2.5-7B (LoRA r=16, 4-bit NF4) | **Adapters exist and are real** — `llm/outputs/final_model/adapter_model.safetensors` (155 MB), two checkpoints (78 MB each) |
| LoRA merge → AWQ quantize | **Chain completed and verified 2026-09-06** on a rented A40. Merge → **15.2 GB, 4 shards**, 40.4M LoRA params fused. Quantize → **5.16 GiB, 2 shards**, `compressed-tensors` / `pack-quantized`, **W4A16** (`num_bits=4`, group_size 128, symmetric, `lm_head` ignored), **196 int4-packed tensors = 28 layers × 7 target modules**. Evidence: `docs/rl/model-chain-evidence/`. **The local `llm/outputs/merged_model/` and `awq_model/` are still empty** — the weights live on the pod and are regenerable; see the reproduce steps in their `INCOMPLETE.md`. |
| vLLM serve of the AWQ model | **Demonstrated 2026-09-06.** vLLM 0.11.0 loads the `compressed-tensors` W4A16 artifact natively (no conversion), captures CUDA graphs, and generates: **91 tokens over 3 prompts in 0.58 s (157.1 tok/s)**, all answers correct. Against **2.4 tok/s** for the same artifact under `transformers` eager execution — a **65×** gap, which is the cost of having no fused int4 kernel. Requires vllm 0.11.0 + torch 2.8.0+**cu128** + **transformers<5**; see `docs/rl/model-chain-evidence/vllm_serving.md` for why each pin is load-bearing. The 157 tok/s is a small-batch figure, not a sustained benchmark. |
| Reward harness (`reward/`, CPU-only) | Built and mutation-tested (the RL half reports 10/10 mutants killed — see `docs/rl/README.md`) |
| Packing correctness, fault-tolerant resume | Proved on CPU |
| Triton kernel + RMSNorm **correctness tests** | **Pass on GPU** — 31 tests, 0 skipped, 0 failed, on an RTX 5060 Ti (Blackwell, sm_120) under WSL2 with torch 2.11.0+cu128 / triton 3.6.0. See "Running the GPU tests" below. This is a *correctness* result only — the kernel **benchmarks** (P4a) are still NOT BUILT and no throughput number has been measured. |
| GRPO loop (P3), parallelism benchmarks (P2b/c), kernel/FP8 benchmarks (P4) | **Not started.** `docs/rl/METRICS.md` is the ledger and its GPU rows read `NOT MEASURED`, which is accurate rather than pending. Nothing above changes those rows. |

### Running the GPU tests

`tests/test_kernels.py`, `test_rmsnorm.py`, `test_memory_guard_cuda.py` and the rlimit case in
`test_limits.py` **skip on Windows** — Triton ships no official Windows build and rlimits are POSIX-only.
They are not skipping because the GPU is busy. Run them from WSL2:

```bash
python3 -m venv ~/vc-venv
~/vc-venv/bin/pip install --index-url https://download.pytorch.org/whl/cu128 torch
~/vc-venv/bin/pip install pytest numpy pyyaml
cd "/mnt/c/Users/User/Documents/project X/VOIDCODE"
~/vc-venv/bin/python -m pytest tests/test_kernels.py tests/test_rmsnorm.py \
    tests/test_memory_guard_cuda.py tests/test_limits.py -q
```

The `cu128` index matters: the 5060 Ti is **sm_120**, and an older cu121 wheel installs cleanly and then
fails at kernel launch. Verify with `torch.cuda.get_device_capability(0)` → `(12, 0)`.

---

## Layout

Every Python package sits exactly one level below the root. This is load-bearing, not stylistic:
both halves resolve their root as `Path(__file__).resolve().parents[1]` — `features/content.py`,
`features/taxonomy.py`, `ranking/fairness.py`, `scripts/base_pass_rate.py`,
`tests/test_differential.py`. Nesting a package one level deeper silently breaks content loading, the
taxonomy join, and the RL catalogue lookup. **Do not "tidy" these into subfolders.**

```
apps/{web,api}     web client and API          packages/shared   shared TS types
features/          content, taxonomy, IRT,     ranking/          LambdaMART, fairness,
                   mastery, retrieval                            course builder
content/           200 problem YAML            llm/              SFT pipeline + adapters
rl/                grpo.py, ppo.py             reward/           by_tests, grader, limits
training/          kernels, faulttol,          data/             concepts.yaml, knowledge/,
                   numerics, packing, trainer                    catalogue.json*, deepcoder-*
scripts/           both halves, merged         tests/            both halves, merged
docs/              platform docs + evidence/
  docs/rl/         the RL half's docs, incl. grpo-runs/ evidence
  docs/specs/      the 12 spec documents that used to clutter the root
infra              docker-compose*.yml, nginx.conf, deploy/, sql/
```

## Running it

```bash
docker compose up -d postgres redis judge0-server   # infrastructure
pnpm install && pnpm dev                            # web client on :3000
```

The `Makefile` targets are written to run **inside WSL2 Ubuntu** (JDK, venv and Spark data live on
ext4); they will not work from Git Bash. RL targets are prefixed `rl-` — `make rl-test`,
`make rl-mutate`, `make rl-faulttest`.

## Verifying it

```bash
ruff check .                                                  # lint both halves
python -m features.taxonomy                                   # concept DAG is acyclic
cd apps/api && python -m scripts.verify_problems \
            && python -m scripts.verify_interview_problems    # 125 items, 699 cases
pytest tests -q                                               # both halves' suites
pytest apps/api/tests -q                                      # needs Postgres up
pnpm typecheck && pnpm build                                  # web
```

---

## What changed during consolidation

Recorded so the diff against either source repo is explainable:

1. **`train/` was dropped in favour of `training/`.** The platform half carried a `train/` package
   holding `memory_guard.py` and `packing.py`; the RL half carried a superset `training/` package
   whose copies of those two modules are the deliberate successors — its `memory_guard.py` documents
   the port ("tested and CI-gated on the platform branch and **never wired into a trainer**") and its
   `packing.py` *corrects a factual error* the older copy makes about which of two mechanisms is
   required for correctness. Only the two colliding test files imported `train.*`, so the older
   package and its two tests were dropped and the successors kept. No renaming was needed.
2. **`data/` and `scripts/` merged with zero filename collisions** — verified, not assumed.
3. **The RL half's `docs/` moved wholesale to `docs/rl/`**, resolving the only three doc collisions
   (`DECISIONS.md`, `METRICS.md`, `OPEN_QUESTIONS.md`) while keeping its internal relative links
   intact. `.gitignore` rules that referenced `docs/*` were rewritten to `docs/rl/*`.
4. **12 loose spec documents moved off the root** into `docs/specs/`. Both original READMEs were kept
   (`docs/specs/PLATFORM_README.md`, `docs/rl/README.md`) rather than discarded.
5. **RL Makefile targets were prefixed `rl-`** because both Makefiles defined `help` and
   `bench-nccl`, and a duplicate target makes the later definition silently win.
6. **Excluded from the copy:** `.turbo` (16 GB), `.claude` (4.3 GB), `.venv` (4.8 GB), `node_modules`,
   `.next`, all caches, and both `.git` directories — roughly 26 GB of regenerable material out of
   28 GB. Dependencies must be reinstalled.

> `docs/rl/README.md` states the other half is "a shipped Electron/TypeScript product" and links
> `../swinburne_ai_tutor_project`. That description belongs to a different tree and the link no longer
> resolves now that both halves live here. Left as written rather than silently edited.
