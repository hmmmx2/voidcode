# VoidCode AI — Training, Ranking and Serving Specification

**Target role profile.** Machine Learning Software Engineer, large scale personalization and infrastructure teams.
**Repository scope.** VoidCode AI only. This build shares no code, no database, no model weights, and no deployment target with SYNTHIEN AI. Do not import from it, do not extract a common package, do not reference it in documentation.
**Build window.** 8 to 10 weeks part time.
**Hardware.** Two NVIDIA RTX A6000 at 48 GB each in one machine, 96 GB aggregate, running training inside WSL2 on Windows. Native Linux is not available and is not going to be. Plus rented cloud instances for the Kubernetes phase.
**Prime directive.** Every number this build produces must be measured, logged, and reproducible. A number you cannot regenerate on demand is worthless.

---

## 0. Instructions for the coding agent

**This is a standalone repository and a standalone session.** SYNTHIEN AI has its own specification and its own agent session. Do not read from it, write to it, or reason about it here. If a task appears to need something from that project, it belongs in the other session.

**Session start checklist. Run this at the top of every new session, including resumed ones.**

1. Read `docs/DECISIONS.md`. Every irreversible choice already made lives there. Do not relitigate a decision without being asked.
2. Read `docs/METRICS.md`. It shows exactly which phases have real numbers and which are still empty.
3. Read `docs/OPEN_QUESTIONS.md`. Answer or escalate anything blocking before starting new work.
4. Run `git log --oneline -20` to see where the last session stopped.
5. State in one paragraph what you believe the current state is and what you intend to do next. Wait for confirmation before writing code.

Read this whole file before writing code. Section 2 contains an interconnect constraint that decides the entire training design, so read it before touching a training script.

**Execution order. This overrides the section numbering. Read it before planning any work.**

The sections are numbered by subject, not by build order. Build in this order.

| Order | Section | Blocked on hardware? | Why here |
|---|---|---|---|
| 1st | **Phase 2, Spark feature pipeline** | **No, CPU only** | The top skill gap across all three target roles, and it runs today on existing hardware |
| 2nd | **Phase 3, two-stage ranking** | No, CPU only | Depends only on Phase 2 mastery vectors |
| 3rd | **Phase 1, training** | Yes, waits on the A6000 pair | Only course explanation text needs the fine-tuned model, and that is the last part of Phase 3 |
| 4th | Phase 4, sandbox and Kubernetes | Rented cluster | Independent of everything above |
| 5th | Phase 5, experimentation | No | Needs the Phase 3 ranker to experiment on |

**The training phase is not the starting point and never was.** It is the most hardware-constrained part of this build and the least valuable for screening. Phases 2 and 3 close the requirements that no amount of resume rewriting can argue around, and they need nothing but the machine already on the desk. If the GPUs have not arrived, that changes nothing about what to start.

**Rules of engagement.**

1. Work in the execution order above, not in section order. The real dependencies are Phase 2 before Phase 3, Phase 3 before Phase 5, and Phase 1 before the course explanation step in section 5.3 only. Phase 1 does **not** block Phase 2 or Phase 3.
2. At the end of every phase, write measured numbers into `docs/METRICS.md` using the ledger in section 8. Write `NOT MEASURED` rather than an estimate.
3. Never describe this platform as large scale in any artifact unless the Spark pipeline is genuinely processing a corpus above one million rows. If it processes ten thousand rows, say ten thousand rows.
4. Prefer widely used libraries. This code will be read by an interviewer.
5. If a requirement here is technically wrong, stop and flag it in `docs/OPEN_QUESTIONS.md` rather than working around it silently.
6. Sandboxed code execution is a security surface. Treat every requirement in Phase 4 as mandatory, not advisory.
7. Commit at every acceptance gate with a message naming the phase and the headline metric.
8. At the end of every phase, append two or three candidate resume bullets to `docs/BULLETS.md`, written only from measured figures in the ledger. Bracket anything not yet measured. This is a deliverable, not an afterthought.
9. For each phase, write a short problem statement into `docs/DESIGN.md` before coding. Two paragraphs. What the business problem is, and how it becomes an analytical problem. Consulting-style employers screen for exactly this translation, and writing it while the work is fresh is far easier than reconstructing it for an interview.

**Ask the operator for these before starting.**

- Current VoidCode repository layout and what already runs
- Which A6000 variant is installed, Ampere RTX A6000 or RTX 6000 Ada, and whether an NVLink bridge is fitted
- Windows version, WSL2 distribution and kernel version, NVIDIA host driver version, and the CUDA version reported inside WSL
- PCIe link width and generation negotiated for each card, from `nvidia-smi -q | grep -A3 "Link Width"`
- Host RAM installed, and the current `memory=` setting in `.wslconfig`
- Free space on the WSL ext4 filesystem, not on `/mnt/c`
- Cloud budget ceiling for the Kubernetes phase and for the scaling benchmark
- Whether any real learner submission data exists, and how much

---

## 1. Mission and non-goals

**Mission.** Build VoidCode into a programming tutor platform that fine-tunes its own model, processes submission telemetry at real volume, ranks practice problems against a learner's measured weaknesses, executes untrusted code safely, and serves all of it as autoscaling services with live experiments.

**In scope.** Full-parameter fine-tuning, a Spark feature pipeline, a two-stage retrieval and ranking model, a sandboxed execution service, Kubernetes deployment, and an experimentation layer.

**Explicitly out of scope.** Agents, tool calling, and enterprise multi-tenancy. Those belong to SYNTHIEN AI. Do not build them here and do not share code with that repository.

### 1.1 What each phase is for

This build serves two job description profiles. Every phase below traces to at least one named requirement. If a phase stops serving one of these, stop building it.

| Phase | Apple, personalization and infrastructure | QuantumBlack, applied data science |
|---|---|---|
| 1 Training | machine learning solutions, distributed computing | prototyping modelling algorithms, ML on complex data |
| 2 Data and SQL | Hadoop, MapReduce, Spark, large scale ML infrastructure | **PySpark, Hive, SQL, data mining, copious amounts of data** |
| 3 Ranking and statistics | **ranking algorithms, information retrieval, personalization** | **applied statistics, evaluation with relevant metrics, new domains** |
| 4 Sandbox and Kubernetes | **micro-services, cloud-native deployment, server side** | deploying technology applied to business problems |
| 5 Experimentation | A/B experimentation, metric-driven development | statistical inference, evaluation with relevant metrics |
| 6 Risk and communication | not required, but strengthens the screen | **QA and risk management, engineering standards, client-facing delivery** |

**The two requirements this build exists to close** are Spark, which Apple lists as required and QuantumBlack lists as a plus, and ranking algorithms, which Apple lists as required. Phase 2 and Phase 3 are therefore non-negotiable. Every other phase is valuable but secondary.

**Phase 6 is not decoration.** QuantumBlack names QA and risk management and client partnering explicitly, and almost no candidate answers those clauses. It is cheap and it differentiates.

---

## 2. Hardware, interconnect, and strategy — decide this first

Memory is no longer the binding constraint. **The interconnect is.** Read this whole section before writing a training script.

### 2.1 Memory arithmetic, measured

A prior audit resolved the exact parameter count of Qwen2.5-7B-Instruct at **7,615,616,512**, so **1 byte per parameter costs 7.0926 GiB**. Measured activation cost with gradient checkpointing at batch 1 is **2.57 GiB at sequence 1024, 5.02 at 2048, and 9.91 at 4096**, dominated by the loss head rather than by depth. Use these figures rather than rederiving them.

Standard AdamW mixed precision costs 16 bytes per parameter, which is **113.48 GiB of static state**. That exceeds the 96 GiB aggregate of both cards combined. **Two A6000 does not rescue AdamW.** Every viable configuration below cuts the optimizer state.

### 2.2 What WSL2 actually costs you

WSL2 reaches the GPUs through the WDDM paravirtualization layer. Two consequences drive the entire design.

**Peer to peer and NVLink are generally not exposed through WSL2.** NCCL falls back to host-staged transfers, so a collective moves GPU to pinned host memory to GPU rather than card to card. Expect single-digit gigabytes per second rather than the roughly 112 GB/s an NVLink bridge delivers on bare metal.

**WDDM silently spills GPU allocations into host RAM instead of raising an out of memory error.** The prior audit observed a backward pass reaching 28.766 GiB on a 15.93 GiB card without failing. This changes a rule you would normally rely on.

> **Never treat "it did not crash" as evidence that a configuration fits.** Every training attempt must read `torch.cuda.max_memory_reserved()` and fail loudly when it exceeds the card capacity. An assertion, not a log line. Without this you will get a run that appears to work and is silently executing over PCIe at a fraction of the expected speed.

### 2.3 Benchmark the interconnect before anything else

This is step zero of Phase 1. Do not write a trainer first.

```bash
# inside WSL2
git clone https://github.com/NVIDIA/nccl-tests && cd nccl-tests && make
NCCL_DEBUG=INFO ./build/all_reduce_perf -b 8 -e 1G -f 2 -g 2
```

Record the bus bandwidth at 256 MB and above, and record which transport NCCL selected from the debug output. Write both into `docs/DECISIONS.md`. That single number selects the strategy.

| Measured all-reduce bus bandwidth | Strategy |
|---|---|
| Above 20 GB/s | ZeRO-2 works well. ZeRO-3 is viable if memory demands it. |
| 5 to 20 GB/s | ZeRO-2 with high gradient accumulation only. Do not use ZeRO-3. |
| Below 5 GB/s | Multi-GPU is likely net negative. Take Route B. |

### 2.4 Why ZeRO-2 rather than ZeRO-3

ZeRO-3 shards parameters, so it must all-gather them on every forward pass and again on every backward pass, for **every micro-batch**. Gradient accumulation does not amortize that cost.

ZeRO-2 replicates parameters and communicates only gradients, once per optimizer step when micro-batches are wrapped in `no_sync`. At accumulation 32 that is one collective per 32 micro-batches rather than 64 collectives. On a host-staged link that difference decides whether the second GPU helps or hurts.

**What ZeRO-2 costs.** Parameters are replicated rather than sharded, so per-GPU memory is higher and the 14B class of models stops fitting. Per GPU at sequence 2048, against a 44 GiB gate that reserves 4 GiB for fragmentation.

| Model | Optimizer | Static per GPU | Peak | Fits |
|---|---|---|---|---|
| Qwen 7.6B | 8-bit AdamW with FP32 master | 42.57 | 47.6 | **No** |
| Qwen 7.6B | 8-bit AdamW, no master | 28.38 | 33.4 | **Yes** |
| Qwen 7.6B | Adafactor BF16 | 21.28 | 26.3 | **Yes, wide margin** |
| Qwen3 14.8B | Adafactor BF16 | 41.35 | 47.4 | **No** |

**Record this trade in `docs/DECISIONS.md`.** Choosing WSL2 caps the model at roughly the 8B class. A 14B full fine-tune needs ZeRO-3 parameter sharding, which needs an interconnect WSL2 cannot provide.

### 2.5 Routes, pick one

**Route A, the default.** Qwen2.5-Coder-7B-Instruct or Qwen3-8B. ZeRO-2, 8-bit AdamW without FP32 master, gradient checkpointing, gradient accumulation 32 with `no_sync` on micro-steps. Lands near 33 GiB per GPU at sequence 2048 with real headroom.

**Route B, the fallback if bandwidth measures below 5 GB/s.** Single A6000, Adafactor BF16, gradient checkpointing. The audit projects 31.65 GiB at sequence 1024 and 38.99 at 4096, so it fits with margin and involves no interconnect at all. Use the second card to run a second experiment concurrently rather than to speed up one. Two independent runs at different learning rates is often worth more than a 1.6x speedup on one.

**Route C, the scaling curve, at the end.** Rent 2 and then 4 H100 on Linux for a 200 step benchmark only. Roughly 5 to 20 US dollars total. This is the **only** way to obtain a genuine ZeRO-3 scaling efficiency number, because WSL2 cannot produce one. Do not train a production model there. Measure, record, shut it down.

**Recommendation.** Route A as primary, Route C at the end for the curve, Route B as the failure fallback.

### 2.6 WSL2 setup requirements

Verify every item before Phase 1 and record the results in `docs/DECISIONS.md`.

- Windows 11, or Windows 10 21H2 or later, with WSL2 running Ubuntu 22.04 or 24.04
- Install the NVIDIA driver **on the Windows host only**. Do not install a driver inside WSL. The CUDA userspace library is surfaced at `/usr/lib/wsl/lib` and installing a guest driver breaks it
- Confirm both GPUs appear in `nvidia-smi` inside WSL before anything else. If only one appears, stop and flag it rather than working around it
- Set `memory=` in `.wslconfig` on the Windows side. WSL2 defaults to half of host RAM, which on 31.6 GB yields roughly 16 GB and is not enough. Target 96 GB, which means 128 GB installed on the host
- Keep the dataset, checkpoints, and the Hugging Face cache inside the WSL ext4 filesystem. Never on `/mnt/c`. Crossing the 9p boundary is slow enough to dominate data loading time
- Set `NCCL_DEBUG=INFO` for the first runs so the selected transport is visible. If NCCL hangs at initialization, try `NCCL_P2P_DISABLE=1`
- DeepSpeed installs and runs in WSL2 Ubuntu. Verify with `ds_report` and record which ops compiled
- Expect CPU offload to be slower than on bare metal, since host memory access also crosses the virtualization layer. Avoid offload unless measurement forces it

---

## 3. Phase 1 — Training has moved

Training, reinforcement learning, parallelism strategies, kernels, and precision work are now specified in `VOIDCODE_TRAINING_SPEC.md` and built in a separate agent session against this same repository.

The two halves serve different employers, run at different times, and need different hardware. The training half is blocked on the A6000 arriving. This platform half is blocked on nothing and should start first.

**What this session needs from the training session.** A checkpoint loadable for inference, used in Phase 3 to generate course module explanations and in Phase 4 as the served model. Until it exists, use the base instruct model. Never block platform work on training work.

**What this session must not do.** Do not write training code here. Do not create DeepSpeed configs here. If a task below appears to require fine-tuning, it does not, and you should flag it in `docs/OPEN_QUESTIONS.md` rather than improvising.

**Hardware sections 2.1 through 2.6 above still apply** to the training session and are kept here as the shared record of the WSL2 decision. Read them, then hand them to the training session.

---

## 4. Phase 2 — Spark feature pipeline

### 4.1 Requirements

- PySpark on a local cluster in standalone mode is acceptable. The point is the programming model and the data volume, not a managed cluster.
- Ingest a public submission corpus of at least one million rows. Project CodeNet has roughly 14 million submissions and is the obvious choice. Bootstrapping volume from a public corpus is legitimate and should be stated plainly in the README.
- Storage. Parquet partitioned by date, or Delta Lake if you want time travel for the experimentation phase.
- Output artifact. A per-learner concept mastery vector.

### 4.1a SQL and Hive layer, required

Spark alone does not evidence SQL, and SQL is named as a must-have rather than a plus. Build this deliberately rather than treating it as a byproduct.

- Register every Parquet output in a **Hive metastore** so the same tables are reachable from Spark SQL and from HiveQL. This is roughly a day of work and earns a named keyword outright.
- Build `sql/` holding named analytical models as plain `.sql` files, each documented and each runnable standalone. Not notebook cells.
- Every model must use SQL that demonstrates range rather than `SELECT *`. Required at minimum. Window functions for per-learner running mastery, common table expressions for multi-step derivations, `GROUP BY ROLLUP` or `GROUPING SETS` for concept hierarchies, and a self-join or lateral pattern for prerequisite relationships.
- Write at least six analytical models. Cohort retention by signup week, concept difficulty ranking with confidence bounds, learner funnel from first attempt to first accepted solution, error taxonomy shifts over time, concept co-failure pairs, and per-concept time to mastery percentiles.
- Add a `sql/tests/` directory asserting row counts, null rates, and referential integrity on every model. A SQL layer without tests is not evidence of engineering standards.

### 4.2 Concept taxonomy

Define 40 to 80 programming concepts in `data/concepts.yaml`. Arrays, hash maps, two pointers, binary search, dynamic programming on sequences, graph traversal, recursion with memoisation, and so on. Tag every problem in the catalog with one to four concepts. This taxonomy is the backbone of both ranking and course generation, so build it before the pipeline.

### 4.3 Feature engineering

Compute per learner and per concept.

| Feature | Definition |
|---|---|
| Attempt count | submissions touching the concept |
| Pass rate | accepted over total |
| First attempt pass rate | strongest weakness signal |
| Mean attempts to accept | persistence and difficulty proxy |
| Error taxonomy distribution | share of compile errors, runtime errors, wrong answers, timeouts |
| Time to accept | median seconds |
| Recency weighted mastery | exponential decay with a 30 day half life |
| Difficulty adjusted mastery | Elo or a one-parameter item response model over problem difficulty |
| Concept co-failure | conditional failure rate given failure on a prerequisite concept |

**Idea worth building.** The item response model is the strongest single addition here. Fitting learner ability and problem difficulty jointly is a genuine modelling contribution rather than aggregation, and it gives you a defensible answer when an interviewer asks what makes your mastery estimate better than a pass rate.

### 4.3a Unsupervised data mining, required

Ranking is supervised. QuantumBlack names data mining separately, and a purely supervised pipeline does not answer it. Two additions, both cheap on top of the mastery vectors you already have.

- **Learner segmentation.** Cluster mastery vectors with k-means and a Gaussian mixture, select the cluster count by silhouette score and BIC rather than by eye, and characterise each segment in plain language. Expect archetypes such as strong on syntax and weak on algorithms. Report cluster stability across bootstrap resamples, since an unstable clustering is not a finding.
- **Association rule mining.** Run FP-Growth over per-learner failed-concept sets to surface concept pairs that fail together more than chance predicts. Report support, confidence, and lift, and filter on lift above 1.5. These rules feed the prerequisite graph in Phase 3 and are themselves a client-presentable result.

### 4.3b Statistical rigour, required

The item response model in 4.3 is the strongest statistical work in this build. Treat it as a modelling exercise, not a feature transform.

- Fit learner ability and problem difficulty jointly under a one-parameter logistic model. Report log likelihood and convergence behaviour.
- Quantify parameter uncertainty by bootstrap over learners, and carry standard errors forward. A mastery estimate from three attempts is not the same as one from three hundred, and the pipeline must know the difference.
- Validate calibration. Bucket predicted pass probability into deciles and plot observed against predicted. Report expected calibration error. A ranker built on a miscalibrated mastery estimate inherits the miscalibration.
- Reproduce the fit independently in R under `analysis/irt_validation.R` and confirm the parameter estimates agree with the Python implementation within tolerance. This is a genuine cross-check, and it evidences R without inventing anything.

### 4.4 Acceptance

- The pipeline processes above one million rows and the row count is recorded
- Every SQL model runs against the Hive metastore and every SQL test passes
- Segment count is selected by a stated criterion, and cluster stability is reported
- Item response parameters carry bootstrap standard errors, and calibration error is reported
- The R validation agrees with the Python fit within a stated tolerance
- Wall clock and rows per second are recorded on a stated core count
- Mastery vectors are written for at least ten thousand synthetic or real learners
- The job is idempotent and reruns cleanly from raw input

---

## 5. Phase 3 — Two-stage ranking

### 5.1 Candidate generation

- Retrieve 200 to 500 candidate problems per learner from the full catalog
- Combine three sources. Concept match against the weakest concepts, collaborative signal from learners with similar mastery vectors, and a prerequisite graph walk that surfaces the missing foundation beneath a failure
- Report Recall at 100 against the held-out set of problems the learner subsequently attempted and passed

### 5.2 Ranking model

- LightGBM with the LambdaMART objective. Groups are learners, labels are graded relevance.
- Label definition. Grade 3 where the learner attempted and eventually passed after at least two attempts, which indicates a productive struggle. Grade 2 for passed on first attempt. Grade 1 for attempted and abandoned. Grade 0 for never attempted. Justify this in `docs/RANKING_DESIGN.md`, because an interviewer will ask why a first-attempt pass is not the top grade.
- Features. Mastery vector features from Phase 2, problem difficulty and concept tags, learner and problem interaction terms, recency, and catalog popularity.
- Report NDCG at 5, NDCG at 10, and Recall at 100 against two baselines. A difficulty-sorted baseline and a popularity baseline.
- Guard against leakage with a strict temporal split. Train on submissions before a cutoff date, evaluate after it. A random split here would invalidate every number.

### 5.3 Course assembly

Turn the ranked list into a course. Group the top ranked problems into modules by concept, order modules by the prerequisite graph, and cap each module at five to eight problems. Generate the module explanation with the Phase 1 fine-tuned model.

### 5.4 Acceptance

- The ranker beats both baselines on NDCG at 10
- The temporal split is verified by a test that fails if any evaluation row predates the cutoff
- A generated course renders end to end for a sample learner

---

## 6. Phase 4 — Execution sandbox and Kubernetes serving

### 6.1 Code execution sandbox

Untrusted code execution is the highest risk component in this build. All of the following are mandatory.

- Container runtime with kernel isolation. gVisor or Kata Containers, not a plain Docker container.
- No network namespace access from inside the sandbox.
- Read-only root filesystem with a small writable tmpfs.
- Hard limits. CPU quota, memory limit, process count limit, open file limit, and a wall clock timeout defaulting to 10 seconds.
- Seccomp profile denying by default.
- Non-root user inside the container.
- One container per submission, destroyed after execution. Never reuse.
- Structured output capturing stdout, stderr, exit code, wall time, and peak memory.

Support Python, Java, and C++ at minimum, since those are the languages already on the resume.

**Adversarial test suite is mandatory.** Fork bombs, memory exhaustion, infinite loops, attempted outbound network calls, filesystem escape attempts, and long output floods. Every one must be contained, and each gets a test.

### 6.2 Kubernetes deployment

- Three separately deployed services. Inference, execution, and the application programming interface. Deploying them separately is what makes the micro-services claim true rather than aspirational.
- Horizontal pod autoscaling. Scale inference on GPU utilisation or queue depth through KEDA. Scale execution on pending submission count.
- Liveness and readiness probes on every service, with readiness gated on model load completion for inference.
- Prometheus metrics exported by all three. Grafana dashboard checked into the repository as JSON.
- Resource requests and limits set explicitly on every pod.
- A documented load test. Report p50, p95, and p99 latency against concurrent request counts of 10, 50, and 100.

### 6.3 Acceptance

- Every adversarial sandbox test is contained
- Autoscaling demonstrably adds and removes pods under the load test
- The latency table is populated at all three concurrency levels
- The whole platform comes up from a single command against a fresh cluster

---

## 7. Phase 5 — Experimentation

### 7.1 Requirements

- Deterministic bucketing by hashing learner identifier with an experiment salt. The same learner must always land in the same variant for a given experiment.
- An experiment configuration registry defining variants, traffic split, primary metric, guardrail metrics, and minimum detectable effect.
- Primary metric. Problem completion rate within seven days of course assignment.
- Guardrail metrics. Abandonment rate, median time to first submission, and error rate.
- Sequential testing with an always-valid confidence sequence rather than repeated fixed-horizon t-tests, since you will inevitably peek at results.
- Sample size calculator taking baseline rate, minimum detectable effect, and power.
- Offline interleaving to compare two rankers on historical data without live traffic.

Run at least one real experiment comparing the LambdaMART ranker against the difficulty-sorted baseline. If real learners are unavailable, simulate them from a learner behaviour model fitted on the public corpus, and label the result as simulated in every artifact.

### 7.2 Acceptance

- Bucketing is deterministic under a test with fixed seeds
- One experiment runs end to end and produces a decision with a confidence interval
- Guardrails trigger correctly on a deliberately degraded variant

---

## 8. Phase 6 — Quality, risk, and communication

This phase exists for the QuantumBlack profile, which names QA and risk management, engineering standards, and partnering with clients through to C-level. Almost no candidate answers those clauses, so the differentiation per hour here is high.

### 8.1 Data quality gates

- Add **Great Expectations** or **Pandera** contracts to every Spark stage. Assert schema, null rates, value ranges, cardinality, and referential integrity between submissions, problems, and concepts.
- A contract violation fails the job. It does not warn.
- Track a data quality scorecard over runs so degradation is visible rather than discovered later.

### 8.2 Model risk register

Maintain `docs/RISK_REGISTER.md` with one row per identified risk. Required columns are risk, likelihood, impact, detection method, mitigation, and residual risk after mitigation.

Populate at minimum with the following, since each is real in this platform.

- Temporal leakage in the ranking train and test split
- Mastery estimates from very few attempts driving confident recommendations
- Popularity bias, where the ranker surfaces widely attempted problems regardless of learner fit
- Model drift as the problem catalog and learner population change
- The fine-tuned tutor leaking full solutions in hint mode
- Untrusted code execution escaping the sandbox

Every mitigation must point at a test, a monitor, or a gate that exists in the repository. A mitigation with no artifact behind it is a wish.

### 8.3 Fairness and segment audit

Evaluate ranking quality separately across the learner segments from 4.3a, and across beginner against advanced learners.

- Report NDCG at 10 per segment, not only in aggregate
- Flag any segment where performance falls more than 15 percent below the mean
- Report whether the ranker under-serves learners with sparse histories, which is the most likely failure mode here

This is the single most QuantumBlack-shaped piece of work in the build. Aggregate metrics hiding a badly served subgroup is exactly the failure their clients care about.

### 8.4 Model card and monitoring

- Write a model card for the ranker covering intended use, training data and its provenance, evaluation results by segment, known limitations, and out-of-scope uses.
- Instrument drift monitoring on the mastery vector distribution and on the incoming problem mix, with an alert threshold you can defend.

### 8.5 Engineering standards

- Type hints throughout, checked in CI with mypy or pyright
- Linting and formatting enforced, not suggested
- Test coverage reported, with the Spark transformations and the ranking label construction covered specifically
- Every phase runnable from a single documented command
- `docs/ARCHITECTURE.md` explaining the data flow from raw submissions to an assembled course

### 8.6 The stakeholder deliverable

Produce a short decision document at `docs/STAKEHOLDER_BRIEF.md`, written for someone who does not read code.

- State the business problem in one paragraph, in learner and outcome terms rather than model terms
- Present the headline result as expected change in completion rate with a confidence interval, not as NDCG
- Show the segment audit as a risk, and state what you would monitor after deployment
- Give a recommendation and the conditions under which you would not deploy
- Maximum two pages, with at most three exhibits

**This document is a portfolio artifact in its own right.** For a consulting-model employer it may carry more weight than the ranking code, because it demonstrates the translation step that most technical candidates cannot do.

### 8.7 Acceptance

- Every Spark stage has a data contract and a violation fails the job
- The risk register has at least six rows and every mitigation points at a real artifact
- Segment-level ranking metrics are reported and any underserved segment is named
- The model card is complete
- The stakeholder brief is two pages and contains no unexplained model jargon

---

## 9. Metrics ledger

Maintain `docs/METRICS.md` with this structure.

| Metric | Baseline | Current | Measured on | Command |
|---|---|---|---|---|
| NCCL all-reduce bus bandwidth, GB/s | n/a | | | `make bench-nccl` |
| NCCL transport selected | n/a | | | `make bench-nccl` |
| Model parameters fully fine-tuned | 0 | | | |
| Training throughput, tokens per second | QLoRA 411.9 at seq 1024 | | | `make bench-train` |
| Peak reserved memory per device, GiB | | | | `make bench-train` |
| WSL2 two-card speedup over one card | 1.00 | | | `make bench-train` |
| Scaling efficiency, rented Linux only | | | | `make bench-cloud` |
| Dataset validation rejection rate | | | | `make build-dataset` |
| Spark rows processed | 0 | | | `make features` |
| Spark rows per second on N cores | | | | `make features` |
| Learners with mastery vectors | 0 | | | `make features` |
| Catalog size | | | | |
| Recall at 100, candidate generation | | | | `make rank-eval` |
| NDCG at 10 against difficulty baseline | | | | `make rank-eval` |
| NDCG at 10 against popularity baseline | | | | `make rank-eval` |
| Sandbox adversarial tests contained | 0 | | | `make sandbox-test` |
| p95 latency at 100 concurrent, ms | | | | `make loadtest` |
| Pods at peak under autoscaling | | | | `make loadtest` |
| Experiment effect size and confidence | | | | `make experiment` |
| SQL analytical models passing tests | 0 | | | `make sql-test` |
| Learner segments identified, stability score | 0 | | | `make segment` |
| Association rules above lift 1.5 | 0 | | | `make mine` |
| IRT calibration error | | | | `make irt` |
| Data contracts enforced across Spark stages | 0 | | | `make data-quality` |
| Risk register rows with a backing artifact | 0 | | | `docs/RISK_REGISTER.md` |
| Worst-segment NDCG at 10 against the mean | | | | `make fairness` |

---

## 10. Repository layout

```
voidcode/
  train/          dataset.py trainer.py eval.py
  configs/        ds_zero2.json ds_zero3.json model.yaml
  features/       spark_jobs/ concepts.yaml irt.py mastery.py segment.py mine.py
  sql/            models/ tests/ metastore/
  analysis/       irt_validation.R calibration.py
  ranking/        candidates.py lambdamart.py course_builder.py eval.py fairness.py
  sandbox/        runner.py policies/ languages/ adversarial_tests/
  serving/        inference/ execution/ api/
  deploy/         k8s/ helm/ grafana/
  experiments/    bucketing.py registry.py sequential.py interleaving.py
  quality/        contracts/ drift.py scorecard.py
  data/           concepts.yaml
  docs/           METRICS.md DECISIONS.md DATA_SOURCES.md RANKING_DESIGN.md
                  RISK_REGISTER.md MODEL_CARD.md STAKEHOLDER_BRIEF.md
                  ARCHITECTURE.md OPEN_QUESTIONS.md
  Makefile
```

---

## 11. Stretch ideas, only after Phase 6 passes

Ranked by screening value per hour.

1. **Knowledge tracing model.** Replace static mastery with a Deep Knowledge Tracing or SAKT model predicting the probability of passing the next problem. This is the state of the art in the domain and it is a genuine modelling story rather than an aggregation story.
2. **Feature store.** Materialise mastery vectors into a low latency store such as Redis with a documented consistency contract between the batch pipeline and online serving. Training and serving skew is a question you will be asked.
3. **Multi-armed bandit for problem selection.** Thompson sampling over concepts, balancing exploring an unknown weakness against exploiting a known one. Pairs naturally with the experimentation layer.
4. **Streaming ingestion.** Kafka into a structured streaming job so mastery updates within minutes rather than nightly. Earns the real-time vocabulary honestly.
5. **Model distillation.** Distil the fine-tuned tutor into a smaller model and report the quality against latency trade-off. Connects directly to the inference optimisation work already on the resume.

Do not start these until the metrics ledger is fully populated.

---

## 12. What each phase earns, by target role

Keep this current. When a phase completes, mark it. When a recruiter asks what you have built, this table is the answer.

| Phase | Apple, personalization | QuantumBlack, Data Scientist II | Agent role |
|---|---|---|---|
| **2, Spark and SQL** | Spark, MapReduce, distributed computing, large scale ML infrastructure | PySpark, Hive, SQL, big data framework, data mining, copious data, feature engineering, applied statistics | — |
| **3, ranking** | ranking algorithms, information retrieval, personalization, recommender | modelling in new domains, evaluation with relevant metrics, prototyping algorithms | — |
| **6, risk and communication** | — | QA and risk management, engineering standards, client partnering, presentations, ethics and integrity | — |
| **1, training** | distributed computing, distributed training | ML on complex data | — |
| **4, sandbox and Kubernetes** | cloud-native deployment, micro-services, server side | deploying technology to business problems, software engineering | scalable and secure for enterprise |
| **5, experimentation** | A/B experimentation, metric-driven product development | statistical inference, evaluation with relevant metrics | experiments, product metrics |

**Read the empty column.** This repository earns almost nothing for the agent role. That is correct and intentional. SYNTHIEN covers it, and the two should not be merged to fake breadth.

**Read the training row.** It earns two phrases, fewer than any other phase, and it is the only one gated on hardware. That is why it sits third in the execution order rather than first.

**Read row three.** Phase 6 earns nothing at Apple and a great deal at QuantumBlack. If QuantumBlack drops off your target list, cut Phase 6 rather than building it out of completeness.

---

## 13. Suggested sequence across both repositories

Run these as two separate agent sessions against two separate repositories. Never both in one session.

**Now, on existing hardware.** Phase 2 here, the Spark pipeline. It is the top gap for two of your three target roles and needs no GPU.

**In parallel, if you have the attention for it.** The SYNTHIEN agent phase, which is the top gap for the third role and also needs no GPU. These two are the only pair worth running concurrently, because they compete for nothing.

**When the A6000 pair arrives.** Phase 1 here. Not before, and do not hold up Phases 2 and 3 waiting for it.

**Never.** Two half-finished platforms with empty metrics ledgers. One completed phase with real measured numbers beats three phases at seventy percent, because bracketed placeholders cannot go on a resume and measured figures can.
