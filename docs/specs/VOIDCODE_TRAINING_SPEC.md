# VoidCode AI — Training and RL Infrastructure Specification

**Target role profile.** Machine Learning Engineer, training and inference infrastructure. Nous Research and equivalent labs.
**Repository scope.** VoidCode AI. This is the **training half** of VoidCode. The data platform half lives in `VOIDCODE_PLATFORM_SPEC.md` and is built in a separate session. Neither touches SYNTHIEN AI.
**Build window.** 10 to 14 weeks part time.
**Hardware.** RTX 5060 Ti at 15.93 GiB today. Two RTX A6000 at 48 GB each under WSL2 when they arrive. Rented Linux instances for anything WSL2 cannot do.
**Prime directive.** Every number is measured, logged, and reproducible. Where a claim comes from a paper rather than your machine, reproduce it before repeating it.

---

## 0. Instructions for Claude Code

Read this whole file before writing code. Section 1.2 contains a hardware truth table that rules several phases out on local hardware entirely.

**Rules of engagement.**

1. Work phase by phase. Do not start a phase before the previous one passes acceptance.
2. Write measured numbers into `docs/TRAINING_METRICS.md` after every phase. Write `NOT MEASURED` rather than an estimate.
3. **Assert on memory, never infer it from the absence of a crash.** WDDM under Windows and WSL2 silently spills GPU allocations into host RAM. A prior audit observed a backward pass reaching 28.766 GiB on a 15.93 GiB card without failing. Every training step must read `torch.cuda.max_memory_reserved()` per device and raise when it exceeds card capacity.
4. Never describe a run as multi-node unless it crossed a network boundary between physical machines. Two GPUs in one box is multi-GPU and single-node. The distinction matters to this audience and conflating them is the fastest way to lose credibility.
5. Reproduce before citing. If a paper reports a number, reproduce it on your own hardware or state clearly that you did not.
6. Prefer readable implementations over clever ones. An interviewer will read the RL loop line by line.
7. Flag anything ambiguous or technically wrong in `docs/OPEN_QUESTIONS.md` rather than working around it silently.

**Ask the operator before starting.**

- Whether the A6000 have arrived, and whether an NVLink bridge is fitted
- Cloud budget ceiling, since three phases here need rented hardware
- Whether the memory audit from the prior work is public yet, since Phase T0 depends on it
- Which base model the tutor is standardising on

---

## 1. Mission, scope, and hardware truth

### 1.1 Mission

Build the training and post-training infrastructure for the VoidCode tutor to a standard that evidences distributed training, reinforcement learning, GPU performance engineering, and numerical verification.

**Out of scope here.** Spark, SQL, ranking, Kubernetes, sandboxing, and experimentation. All of that is in `VOIDCODE_PLATFORM_SPEC.md`. Agents and retrieval belong to SYNTHIEN.

### 1.2 Hardware truth table, read before planning anything

| Capability | 5060 Ti, 15.93 GiB | 2x A6000, 96 GiB, WSL2 | Rented Linux |
|---|---|---|---|
| LoRA SFT up to 7B | Yes | Yes | Yes |
| Full-parameter SFT 7B | No | Yes, ZeRO-2 with 8-bit AdamW | Yes |
| LoRA GRPO 1.5B | Yes | Yes | Yes |
| LoRA GRPO 7B, trainer and rollout split | No | Yes, one card each | Yes |
| Full-parameter GRPO 7B | No | **No.** Policy, gradients, optimizer, reference, and rollout engine total 85 to 95 GiB before overhead | Yes, 8x80 GB |
| Tensor and pipeline parallelism | No | Yes, degree 2 | Yes, higher degrees |
| **Multi-node** | No | **No.** One box is not multi-node | **Required** |
| **FP8 training** | No | **No.** Ampere has no FP8 tensor cores | **Required, H100 or newer** |
| Triton kernel development | Yes | Yes | Yes |
| MoE expert parallelism | No | Yes, small MoE only | Yes |
| Vision encoder attachment | Yes, small | Yes | Yes |

**Two capabilities cannot be faked locally.** Multi-node training and FP8. Both are named in the target job description, both need rented hardware, and both are cheap. Budget roughly 100 US dollars total and stop treating them as blocked.

---

## 2. Phase T0 — Publish and profile

**This is the highest return phase in the entire specification and it takes a weekend.**

### 2.1 Publish the memory audit

The prior GPU memory audit is legitimate performance engineering work and it is currently invisible. Publishing it converts it into evidence and puts a first mark against the open-source preference.

- Create a public repository containing the audit report, all probe scripts, and the plan files
- Clean the scripts so a stranger can run them. A README with exact commands, a requirements file, and a one-command entry point
- Write a short accompanying post covering the five-stage allocation attribution, the lazy Adam moment allocation finding, the activation decomposition into per-layer and loss-head terms, and the WDDM spill discovery
- The lazy allocation finding is the interesting one. A 1.5B AdamW run that survives model load, forward, and backward, then dies at the first optimizer step, is a genuinely useful thing to have written down

### 2.2 Interconnect and topology profiling

- Build and run `nccl-tests` all-reduce, all-gather, and reduce-scatter across the available GPUs. Record bus bandwidth at 256 MB and above
- Record which transport NCCL selects, from `NCCL_DEBUG=INFO`
- Record topology from `nvidia-smi topo -m`
- Repeat the same benchmark on a rented Linux two-GPU instance and publish the WSL2 penalty as a measured percentage. This comparison does not exist publicly in any useful form and it is a genuine small contribution

### 2.3 Acceptance

- The repository is public, the scripts run from a clean clone, and the README is complete
- Bandwidth and transport are recorded for every available configuration
- The WSL2 against Linux comparison is published with numbers

**Resume bullets produced.**
- Published a GPU memory profiling harness attributing out-of-memory failures across five allocation stages, identifying lazy optimizer moment allocation as the failure point for full-parameter training.
- Measured NCCL collective bandwidth and transport selection across WSL2 and native Linux, quantifying the host-staged penalty at [X percent].

---

## 3. Phase T1 — Supervised training with parallelism and fault tolerance

### 3.1 Parallelism strategies

The job description names data, tensor, pipeline, and context parallelism explicitly. Implement and benchmark each, and be honest about the degrees your hardware allows.

| Strategy | Implementation | Local feasibility |
|---|---|---|
| Data parallel | DeepSpeed ZeRO-2, or FSDP2 with `SHARD_GRAD_OP` | Degree 2 on A6000 |
| Tensor parallel | PyTorch `DTensor` with `parallelize_module`, or Megatron-Core | Degree 2 on A6000 |
| Pipeline parallel | `torch.distributed.pipelining` | Degree 2 on A6000 |
| Context parallel | Ring attention or `DTensor` sequence sharding | Only meaningful above 8k sequence |

**Required deliverable.** A benchmark table of tokens per second and peak memory per device for each strategy and for at least one 2D combination such as data parallel crossed with tensor parallel. Explain which bottleneck each strategy relieves and which it introduces.

Use **TorchTitan** as the reference implementation for the parallelism work rather than rolling your own. It is named in the preferred qualifications, it is readable, and adapting it is a legitimate way to learn the composition rules.

### 3.2 Fault-tolerant training

Named as a responsibility in its own right, and rarely evidenced by candidates.

- Sharded checkpointing through `torch.distributed.checkpoint`, saving optimizer state, model state, dataloader position, and RNG state
- Elastic launch through `torchrun --max-restarts` so a failed rank triggers a restart rather than a dead job
- **A deliberate failure test.** Kill one rank mid-run with `SIGKILL`, restart, and assert the resumed loss curve matches the uninterrupted run to within floating point tolerance. Record the step at which you killed it and the recovery wall clock
- Asynchronous checkpointing so the save does not stall the training loop, with the overhead measured both ways

### 3.3 Numerical correctness

The job description names verifying numerical correctness and validating methods from recent publications. Build this as a standing harness, not a one-off.

- A gradient check comparing your parallelised implementation against a single-GPU reference on a small model. Assert bitwise or near-bitwise agreement on the first N steps
- Loss curve equivalence across parallelism strategies. Data parallel at degree 2 and tensor parallel at degree 2 should produce statistically indistinguishable curves for the same effective batch. If they do not, that is a bug and finding it is the point
- Determinism controls documented. Seeds, `torch.use_deterministic_algorithms`, and where determinism is impossible and why
- **Reproduce one published result.** GaLore's reported memory figures are the obvious candidate, since you already have a validated estimator and prior measurements that disagreed with the estimator by 17 percent in the conservative direction. Publishing a careful reproduction with your own numbers is exactly the work this role describes

### 3.4 Acceptance

- Every parallelism strategy runs and appears in the benchmark table with measured throughput and memory
- The deliberate kill and recovery test passes, with the recovery time recorded
- The gradient check passes against a single-GPU reference
- One published result is reproduced, agreed with, or disputed with evidence

**Resume bullets produced.**
- Benchmarked data, tensor, pipeline, and context parallelism on a [N]B model, reporting throughput and per-device memory across [N] configurations and one 2D composition.
- Built fault-tolerant training with sharded distributed checkpointing and elastic restart, recovering to an identical loss curve after a deliberate rank kill at step [N].
- Verified numerical correctness of parallelised training against a single-GPU reference, and reproduced [paper] memory results within [X percent].

---

## 4. Phase T2 — Reinforcement learning post-training

This closes the largest single gap for this role profile.

### 4.1 Why this project suits GRPO unusually well

The reward is unit test pass rate on generated code. It is **verifiable**, so there is no reward model to train, no preference data to collect, and no LLM judge to calibrate. The execution sandbox from the platform specification is already the reward function. Almost no portfolio RL project has that.

### 4.2 Model and memory

**Start on the 5060 Ti with LoRA on Qwen2.5-Coder-1.5B-Instruct.** Full-parameter GRPO on 1.5B needs 24 to 26 GiB and does not fit. LoRA fits in 10 to 12 GiB because toggling the adapter off gives you the reference policy for free, removing an entire model copy. That is standard practice, not a compromise.

Pick the **code-specialized** 1.5B rather than the general instruct model. Base pass rate matters, and section 4.4 explains why.

**When the A6000 arrive**, move to Qwen2.5-Coder-7B-Instruct with the trainer on one card and vLLM on the other. That physical split **is** trainer-inference separation, which the job description names as a responsibility.

### 4.3 The loop

- Group sampling. Generate G completions per prompt, with G between 8 and 16
- Advantage. Within-group normalisation, meaning reward minus group mean divided by group standard deviation. No value network, which is GRPO's main departure from PPO
- Reward. Unit test pass rate, with partial credit for tests passed rather than binary. Add a small format penalty for unparseable output
- KL regularisation against the frozen reference, with the coefficient configurable and the divergence logged every step
- Clipped surrogate objective, with the clip ratio configurable
- Trainer and inference separation. vLLM generates rollouts, the trainer updates, and policy weights synchronise back on a configurable interval. Measure the synchronisation cost and the staleness it introduces

### 4.4 Dead groups, the failure mode to design against

If all G completions for a prompt fail, every reward is identical, the advantage is zero, and the gradient is zero. Dead groups are the dominant failure of verifiable-reward RL.

- Log the dead group rate every step. It is the most important diagnostic in the run
- Filter the training set to problems where the base model passes somewhere between roughly 10 and 90 percent of the time, measured before training starts
- Implement difficulty curriculum so the distribution moves as the policy improves
- Report the dead group rate curve alongside the reward curve. A reward curve without it is uninterpretable

### 4.5 Reward hacking controls

- Monitor KL against the reference continuously. A sharp rise with a rising reward is the classic signature
- Hold out a test set the reward function never saw
- Inspect completions manually at intervals. Look for tests gamed rather than solved, such as hardcoded expected outputs or exception swallowing
- Record any hacking you find in `docs/RL_FINDINGS.md`. Finding and documenting reward hacking is a stronger result than a clean curve

### 4.6 Also implement PPO

Implement PPO with a value head as a comparison arm, even though GRPO is the primary. The job description names both. A measured comparison of sample efficiency, memory, and wall clock between the two is a better artifact than either alone.

### 4.7 Acceptance

- Pass at 1 on the held-out set improves measurably over the base model
- Dead group rate, KL divergence, and reward are all logged per step and plotted together
- The GRPO against PPO comparison table is populated
- Weight synchronisation cost between trainer and rollout engine is measured
- At least one reward hacking attempt is found and documented, or its absence is argued with evidence

**Resume bullets produced.**
- Implemented a Group Relative Policy Optimization (GRPO) loop with unit test pass rate as a verifiable reward, lifting pass at 1 from [X] to [Y] over [N] iterations.
- Architected trainer and inference separation with vLLM rollout generation and periodic policy weight synchronisation, measuring synchronisation overhead at [X] percent of step time.
- Compared GRPO against Proximal Policy Optimization (PPO) on sample efficiency, memory, and wall clock, and instrumented KL divergence against the reference policy to detect reward hacking.

---

## 5. Phase T3 — Kernel and precision work

### 5.1 Triton kernels

- Write at least two fused Triton kernels relevant to this workload. A fused RMSNorm with residual, and a fused cross-entropy that avoids materialising the full logits tensor, are both directly useful given the prior finding that the loss head dominates activation memory at 2.04 GiB of 2.57 GiB at sequence 1024
- Benchmark each against the PyTorch eager equivalent and against `torch.compile` output, reporting speedup and memory saving
- Verify numerical agreement with the reference implementation to a stated tolerance, forward and backward
- The fused cross-entropy is the one to prioritise, because you can point at your own measurement showing why it matters

### 5.2 Low precision training

**FP8 needs Hopper or newer. Ampere cannot do it.** This phase requires a rented H100 for roughly a day at under 40 US dollars.

- Run the same configuration in BF16 and FP8 through TransformerEngine, and report throughput, memory, and loss curve divergence
- Document the scaling strategy used and where numerics break down
- If budget does not allow, run an INT8 or BF16 against FP16 comparison locally and state plainly that FP8 was not tested

### 5.3 Acceptance

- Two Triton kernels beat their eager equivalents with measured numbers and pass numerical verification
- FP8 against BF16 comparison is complete, or its absence is explicitly stated

**Resume bullets produced.**
- Wrote fused Triton kernels for RMSNorm and cross-entropy, cutting loss-head activation memory [X percent] and improving step time [Y percent] over the PyTorch baseline.
- Benchmarked FP8 against BF16 training on H100, reporting [X] times throughput at [Y] loss curve divergence.

---

## 6. Phase T4 — Mixture of experts and multi-modal

Both are preferred rather than required. Build them only after T0 through T3 pass.

### 6.1 MoE and expert parallelism

- Fine-tune a small mixture-of-experts model with experts sharded across the two A6000. OLMoE or a small Qwen MoE are reasonable targets given the memory ceiling
- Instrument expert routing. Log load balance across experts, the auxiliary loss, and token drop rate
- Report the all-to-all communication cost as a share of step time, since that is the characteristic bottleneck of expert parallelism and the thing an interviewer will ask about

### 6.2 Multi-modal

This fits the tutor naturally rather than being bolted on. Learners paste screenshots of errors.

- Attach a vision encoder such as SigLIP or CLIP to the tutor with a projection layer
- Train the projection with the language model frozen, then unfreeze selectively
- Evaluate on screenshot-based bug diagnosis against a text-only baseline on the same problems

### 6.3 Acceptance

- Expert load balance and all-to-all cost are measured and reported
- The multi-modal path beats text-only on screenshot diagnosis, or the negative result is reported honestly

---

## 7. Phase T5 — Open-source contribution

Not a phase you complete, a track you start in week one and keep running.

- Begin with a documentation or test fix in vLLM, TorchTitan, or transformers, purely to learn the review process without stakes
- Then something substantive. Your memory profiling work suggests obvious candidates, such as clearer out-of-memory error attribution or documentation of optimizer state allocation timing
- Publish the Triton kernels from T3 as a standalone repository if upstream does not want them
- Track every contribution in `docs/CONTRIBUTIONS.md` with links and status

**Why this matters more here than anywhere else.** This class of lab hires substantially through visible open-source work. A merged pull request in vLLM is worth more to a Nous reviewer than another line on a resume, and the barrier is far lower than people assume.

---

## 8. Metrics ledger

Maintain `docs/TRAINING_METRICS.md`.

| Metric | Baseline | Current | Command |
|---|---|---|---|
| NCCL bus bandwidth, WSL2 and Linux, GB/s | | | `make bench-nccl` |
| Parallelism configurations benchmarked | 0 | | `make bench-parallel` |
| Max parallelism degree achieved, per strategy | 0 | | `make bench-parallel` |
| Multi-node ranks trained across | 0 | | `make train-multinode` |
| Checkpoint recovery time after rank kill, seconds | n/a | | `make faulttest` |
| Gradient check agreement against single-GPU reference | | | `make numcheck` |
| Published results reproduced | 0 | | `docs/REPRODUCTIONS.md` |
| Pass at 1, base against post-RL | | | `make rl-eval` |
| Dead group rate at start and end | | | `make rl-eval` |
| KL divergence at convergence | | | `make rl-eval` |
| Weight sync overhead, percent of step | | | `make rl-bench` |
| Triton kernels beating eager | 0 | | `make kernel-bench` |
| FP8 against BF16 throughput ratio | | | `make fp8-bench` |
| Expert load balance variance | | | `make moe-bench` |
| Merged upstream pull requests | 0 | | `docs/CONTRIBUTIONS.md` |

---

## 9. Repository layout

```
voidcode/
  training/
    parallel/     dp.py tp.py pp.py cp.py compose.py
    faulttol/     checkpoint.py elastic.py kill_test.py
    numerics/     gradcheck.py determinism.py reproductions/
    kernels/      rmsnorm.triton.py xent.triton.py bench.py
    precision/    fp8_te.py compare.py
    moe/          routing.py balance.py
    multimodal/   encoder.py projector.py
  rl/
    grpo.py ppo.py rollout.py reward.py curriculum.py sync.py
    diagnostics/  dead_groups.py kl_monitor.py hack_audit.py
  configs/        ds_zero2.json ds_zero3.json titan/ rl.yaml
  docs/           TRAINING_METRICS.md RL_FINDINGS.md REPRODUCTIONS.md
                  CONTRIBUTIONS.md DECISIONS.md OPEN_QUESTIONS.md
  Makefile
```

---

## 10. What each phase earns

| Phase | Nous, MLE | Apple | QuantumBlack | Agent role |
|---|---|---|---|---|
| T0 publish and profile | open-source track record, NCCL, distributed profiling, GPU memory management | distributed computing | engineering standards | — |
| T1 parallelism and fault tolerance | **multi-GPU and multi-node training, parallelization strategies, fault-tolerant training, checkpointing and recovery, numerical correctness, TorchTitan, Megatron** | **distributed computing, large scale ML infrastructure** | ML on complex data | — |
| T2 reinforcement learning | **RL pipelines, GRPO, PPO, policy optimization, reward modeling, trainer-inference communication, vLLM** | machine learning solutions | prototyping modelling algorithms | — |
| T3 kernels and precision | **NVIDIA GPU programming, Triton, custom kernels, FP8 training, expert-level PyTorch** | — | — | — |
| T4 MoE and multi-modal | **MoE and expert parallelism, multi-modal training** | — | — | — |
| T5 open source | **track record of open-source contributions** | — | — | — |

**Read the last three columns.** This specification is almost entirely for one employer profile. That is correct. Do not build it because it is interesting if that employer is not a real target, because the opportunity cost against the platform specification is high.

---

## 11. Sequence and cost

| Phase | Time | Hardware | Cost |
|---|---|---|---|
| T0 | 1 weekend | any | ~5 USD |
| T2 on 1.5B | 3 weeks | 5060 Ti today | free |
| T1 | 3 to 4 weeks | 2x A6000 | ~50 USD for the multi-node point |
| T2 on 7B | 2 weeks | 2x A6000 | free |
| T3 | 3 weeks | A6000 plus rented H100 | ~40 USD |
| T4 | 3 weeks | 2x A6000 | free |
| T5 | ongoing from week 1 | any | free |

**Start with T0 this weekend, then T2 on the 1.5B, because both run on hardware you already own.** T1 waits for the cards. That ordering deliberately puts a lower-value phase ahead of a higher-value one, on the grounds that work you can start today beats work blocked on delivery.
