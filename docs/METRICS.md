# VoidCode AI — Metrics Ledger

Spec §8. Every figure below was measured on this machine and regenerates from the
command in its row. **`NOT MEASURED` means not measured** — never an estimate standing in
for one (spec §0 rule 2).

**Phase status.** Phase 2 complete and passing its acceptance gate. Phase 1 blocked on
hardware (`docs/specs/OPEN_QUESTIONS.md` Q-001); the operator has elected to move it to rented
cloud GPUs, which are not yet provisioned. Phases 3–5 not started.

**Scale, stated plainly (spec §0 rule 3).** The Spark pipeline processes **2,296,409
rows**. That is two-point-three million rows, and it is a bootstrapped public corpus, not
VoidCode traffic. VoidCode has zero real learner submissions. Nothing here is "large
scale" and the word is not used.

**This file was stale and has been corrected.** Every figure below now reflects the
full-corpus rebuild in `docs/DECISIONS.md` D-009 and the learning-rate reversal in D-010.
It previously reported the pre-D-009 world — 103 problems, 1,234,270 rows, 94,850
learners, and an external Spearman of **0.9170** against a true **0.4864**. That last one
mattered most: this file is titled "Metrics Ledger", it is the first document a reader
opens, and it was carrying a headline correlation nearly twice the real value. The
superseded numbers are kept inline where they show a trade-off, always labelled.

Run everything from inside WSL2: `cd /mnt/c/.../voidcode_ai && make <target>`.

---

## Ledger

| Metric | Baseline | Current | Measured on | Command |
|---|---|---|---|---|
| NCCL all-reduce bus bandwidth, GB/s | n/a | **NOT MEASURED** — hardware absent | — | `make bench-nccl` |
| NCCL transport selected | n/a | **NOT MEASURED** — hardware absent | — | `make bench-nccl` |
| Model parameters fully fine-tuned | 0 | **0** — Phase 1 blocked | — | `make bench-train` |
| Training throughput, tokens/sec | QLoRA 411.9 @ seq 1024 † | **NOT MEASURED** for full fine-tune | — | `make bench-train` |
| Peak reserved memory per device, GiB | — | **NOT MEASURED** for full fine-tune | — | `make bench-train` |
| WSL2 two-card speedup over one card | 1.00 | **NOT MEASURABLE** — one card present | — | `make bench-train` |
| Scaling efficiency, rented Linux only | — | **NOT MEASURED** — not provisioned | — | `make bench-cloud` |
| Dataset validation rejection rate | — | **NOT MEASURED** — dataset not built | — | `make build-dataset` |
| **Spark rows processed** | 0 | **2,296,409** | 10 cores, WSL2 Ubuntu | `make features` |
| **Spark rows per second** | — | **9,241** on 10 cores | 248.5 s wall clock | `make features` |
| **Learners with mastery vectors** | 0 | **117,453** | — | `make features` |
| **Catalog size** | — | **11,284** problems observed of 11,311 in the Codeforces catalog (99.8%) | — | `make features` |
| **Recall at 100** | — | LambdaMART **0.616**, popularity **0.190**, difficulty-sorted **0.009** | 60 eval learners x full 11,267-problem catalogue, cutoff 2026-07-15 | `python -m ranking.eval` |
| **NDCG at 10 vs difficulty baseline** | — | LambdaMART **0.2143** [0.1590, 0.2697] vs difficulty-sorted **0.0000**. The baseline scores zero because the lowest-beta problems have 1-7 observations — an artefact of the IRT fit, not a difficulty claim | same | `python -m ranking.eval` |
| **NDCG at 10 vs popularity baseline** | — | LambdaMART **0.2143** [0.1590, 0.2697] vs popularity **0.0511** [0.0261, 0.0816] — **§5.4 MET**, CI lower bound clears the baseline 3x | same | `python -m ranking.eval` |
| **NDCG at 5** | — | LambdaMART **0.1467**, popularity **0.0497** | same | `python -m ranking.eval` |
| **Top-10 overlap between learners** | — | **4.52 of 10** shared between any two learners; 0 of 780 pairs identical; 48 distinct problems across 40 learners | see `docs/RANKING_ANALYSIS.md` | ablation script |
| **NDCG at 10 without `catalog_popularity`** | — | **0.0367** (from 0.2584) — the feature is load-bearing; alone it gives only 0.0611 | same | `docs/RANKING_ANALYSIS.md` |
| **Best-fitting mastery half-life** | 30 d (assumed) | **365 d** (log loss 0.94902); 30 d is 0.95252 and is the WORST value tested — no decay at all scores 0.94923. Spread across all values is 0.37%, so recency weighting barely matters here | 49,745 held-out attempts, World A | half-life fit script |
| **Retrieval threshold margin** | 0.004 (at 0.50) | **SUPERSEDED — see the row below.** Was 0.034 either side at 0.53 | 10-doc corpus, 8+5 probes | `python scripts/measure_retrieval_threshold.py` |
| **Retrieval threshold, re-measured** | +0.068 gap | **OVERLAPPING: gap −0.028.** Worst on-topic 0.478, best off-topic 0.506. **No threshold separates them.** 0.53 is kept regardless: it admits 0 of 10 off-topic and keeps 25 of 28 on-topic, and the failure directions are asymmetric — a rejected question costs a citation (fail-open), an admitted one makes the tutor cite a paper at the wrong question | 30-doc corpus, 28+10 probes, nomic-embed-text | same |
| ↳ **why it overlaps, and why it is not corpus size** | — | **Acronyms score LOW** (triton 0.478, grpo 0.513, fsdp/ddp 0.519, rmsnorm 0.535) and **polysemous domain words score HIGH off-topic** — "how much attention should I give a new puppy" 0.506 and "what transformer do I need for european appliances" 0.501 beat four real questions. The fix is the embedder, not the number | same | same |
| ↳ **the probe set was the bug** | — | Tripling the corpus first reported an **identical 0.068 gap**, because all 8 probes concerned the original 10 documents — the 20 new ones were never queried. An unchanged number from an unchanged probe set is not evidence that anything held | same | same |
| **Retrieval corpus size** | 10 documents | **30 documents / 30 chunks**, file-backed in `data/knowledge/*.md`, every one validated for a known `concept_id`, an http(s) source and an ISO date | live DB | `python scripts/seed_knowledge.py --write` |
| **Sandbox adversarial probes contained** | 0 | **10 of 12 fully contained, 0 breaches, 2 hardening findings** | Judge0 CE 1.13.1, WSL2 | `python -m sandbox.adversarial` |
| **p95 latency at 100 concurrent, ms** | — | **897 ms** (p50 399, p99 1554), 256 req/s, 1 transport error in 7,692 | single instance, read paths, warm pool | `python deploy/loadtest.py --users 100 --seconds 30` |
| **p95 latency at 10 concurrent, ms** | — | **19 ms** (p50 12, p99 31), 359 req/s | same, at 10 concurrent | `python deploy/loadtest.py --users 10` |
| **Throughput knee** | — | **between 10 and 100 concurrent**: 359 req/s at 10 falls to 256 req/s at 100, so added concurrency costs throughput. 15 DB connections per instance (`pool_size` 5 + `max_overflow` 10) is the queue | — | `python deploy/loadtest.py` |
| **First-connection cost, s** | — | **~21 s**, once per process. Cold asyncpg connect on Docker Desktop for Windows; this is why the k8s `startupProbe` allows 5 minutes | — | `python deploy/loadtest.py` |
| Pods at peak under autoscaling | — | **NOT MEASURED** | — | `make loadtest` |
| **Course renders end to end (§5.4)** | no | **yes** — 9 modules, 36 problems, sizes [6, 2, 1, 5, 8, 7, 5, 1, 1], prerequisite-ordered | real platform learner, 123-item catalogue | `python -m ranking.course_builder --user <id>` |
| Experiment effect size and confidence | — | **BUILT, and every number SIMULATED.** The platform has 9 users; the power calculator says **1,374 per arm / 2,748 total** are needed to detect +0.05 absolute on a 0.30 baseline at 80% power, so no live arm is possible and the run is labelled simulated on every line | spec §7.1 | `make experiment` |
| ↳ **peeking is actually valid** | — | Under a true null with 40 peeks per run: **always-valid confidence sequence 0.003 false positive rate; the same peeking with a fixed-horizon z-test 0.313** (against alpha 0.05). That contrast is asserted in the test, because a sequence that never fires would pass a validity check trivially | 300 simulated experiments | `tests/test_experiments.py` |
| ↳ **it detects real effects too** | — | True lift +0.06 → fires at **n=4,980/arm**, interval [+0.032, +0.084] covering the truth. True lift −0.04 → fires at **n=3,723/arm**, verdict "treatment worse". The fixed-horizon requirement was 1,374/arm, so the right to peek costs roughly **3.6x the data** | same | `make experiment` |
| ↳ **guardrails and interleaving** | — | `--degrade` trips abandonment_rate at **+0.120 → BREACHED - STOP** while the other two stay quiet, and interleaving flips from win_rate 0.016 to **0.976**. Interleaving needs no live traffic, which is why it is usable here at all | same | `make experiment --degrade` |
| **Eval cohort size, temporal split** | — | **20,537 learners** (≥3 pre-cutoff and ≥3 post-cutoff problems; median 6 post-cutoff each) | cutoff 2026-07-15, 80th percentile of first-attempt time | `python -m ranking.split` |
| **Temporal split pairs** | — | **1,056,303 train / 264,079 eval** across 101,937 train and 49,573 eval learners | same | `python -m ranking.split` |
| SQL analytical models passing tests | 0 | **6 of 6 models, 6 of 6 assertion files passing** against Spark SQL over the Hive-registered warehouse. Row counts: cohort_retention 18,080 · concept_difficulty_ranking 76 · learner_funnel 6 · error_taxonomy_shift 610 · concept_cofailure_pairs 1,877 · concept_time_to_mastery 67. Every required technique is used: CTEs, window functions (`FIRST_VALUE`, `LAG`, `RANK`, partitioned `SUM`), `GROUP BY ROLLUP` + `GROUPING_ID`, and a self-join for the prerequisite pattern | live warehouse, 2.3M rows | `make sql-test` |
| ↳ **an assertion caught a broken funnel** | — | **`solved_any` converted at 1.205** — above 1, impossible in a nested funnel. A `persisted` stage (attempted ≥2) had been placed above `solved_any` on the false premise that solving implies persisting; a learner can attempt one problem and solve it. The model passed row counts, null rates, referential integrity and grain uniqueness first — a broken funnel is arithmetically valid under all four | same | `sql/tests/04_value_ranges.sql` |
| **Recovered catalogue reachable from SQL** | on disk, unregistered | **Registered and asserted.** `gold_problem_catalog_complete` (12,217 rows) was missing from `sql/register_tables.py`, so all of it — including the 906 recovered problems — was invisible to Spark SQL and HiveQL. A Python contract reads Parquet directly and cannot catch a missing metastore registration | live warehouse | `sql/tests/06_catalogue_coverage.sql` |
| **Learner funnel (measured)** | — | 117,453 attempted → **109,157 solved any (92.9%)** → 83,603 solved 2+ (76.6%) → 50,437 solved 5+ (60.3%). Only **7.1% bounce without ever solving**; 83.5% solve something on a first attempt at least once | same | `make sql-models` |
| **Time-to-mastery is 0 at the median** | assumed usable | **65 of 67 concepts have p50 = 0 seconds.** Zero-elapsed share ranges 0.43–0.79, mean **0.65** — a first-submission solve has no elapsed time, so the clock never starts. Reported as time to first accepted solution with the zero share as the leading column; "time to mastery" is not derivable, as mastery is continuous with no crossing event | same | same |
| **Co-failure barely identifies prerequisites** | — | Declared prerequisite pairs average lift **1.290**; the 1,701 *undeclared* pairs average **1.203**. A 0.09 separation over 1,877 pairs means co-failure does not distinguish a real dependency from shared problems — the reason model 5 reports `is_declared_prereq` beside the lift instead of inferring edges | same | same |
| **Learner segments, k selected** | — | **k=2 by silhouette** (0.110); GMM picks k=8 by BIC — they disagree. Segments: 33,054 learners at mastery 0.813 / 81.5 attempts vs 25,634 at 0.508 / 145.7 | 58,688 learners (50% retained, ≥8 concepts) | `python -m features.segment` |
| **Segment stability, mean ARI** | — | **0.9844** over 20 resamples — the same weakly separated split every time (silhouette 0.110): reproducible, not sharply divided | same | `python -m features.segment` |
| **Is the segmentation coverage or ability?** | — | **ability** — mastery spread 0.305 across segments, coverage ratio only 1.02x. The artefact limitation 3 predicts was avoided by mean-imputing per concept rather than zero-filling | same | `python -m features.segment` |
| **Bootstrap SE for difficulty (β)** | analytic only | **200 cluster replicates over learners**, 942 s. Median bootstrap/analytic ratio **0.59**, spearman **0.127** — they measure different things: the bootstrap answers "different learners?", the analytic "enough data on this problem?" | 1.32M observations | `python -m features.irt_bootstrap` |
| Segment stability, mean adjusted Rand index | — | **NOT MEASURED** — see above. Expect this to reflect COVERAGE rather than ability: the mastery matrix is >85% missing | — | `make segment` |
| **Association rules above lift 1.5** | — | **946 directed = 473 undirected pairs** (lift is symmetric). vs the hand-curated DAG: 24 agree, 24 inverted (same 24 pairs both ways), 898 absent. Top: `line_sweep`↔`convex_hull` at lift 132.9 | 72,981 learners, DSA concepts only | `python -m features.mine` |
| **IRT expected calibration error** | — | **ECE 0.0348, MCE 0.1708** over 1,320,382 outcomes. Systematically OVERCONFIDENT mid-range (predicted 0.45 → observed 0.28); thinly-observed problems are *better* calibrated (0.0224) than well-observed ones (0.0352) | live warehouse | `python -m analysis.calibration` |
| ↳ **DO NOT USE THE ROW ABOVE — it is in-sample** | — | **It scores persisted θ/β on the rows they were fitted on, and it is the wrong sign.** Reproduced against out-of-fold on identical bucketing: in the 0.35–0.55 band, in-sample reads predicted 0.404 → observed 0.241 (gap **−0.163**, overconfident) while out-of-fold reads 0.403 → 0.435 (gap **+0.031**, *under*confident). Same predicted value, opposite error, because which rows land in a bucket depends on which θ/β you score with. **The honest platform figures are the out-of-fold ones: ECE 0.0138 raw, 0.0001 corrected** | same | `python -m analysis.recalibrate_kfold` |
| **2PL vs 1PL, held-out log loss** | 1PL 0.226606 | **2PL 0.240492 — 6.1% WORSE.** The extra 11,284 discriminations do not pay for themselves at a median 7 observations per problem | same held-out split, 131,797 rows | `python -m features.irt_2pl` |
| **Non-converged betas under 2PL** | 482 (1PL) | **0** — the 2PL removes them entirely, but is the worse predictor, so use the evidence filter instead | same | `python -m features.irt_2pl` |
| **Isotonic recalibration of the 1PL** | raw ECE 0.0131, MCE 0.0730 | **ECE 0.0027 (−79%), MCE 0.0345 (−53%)**, out-of-sample. Fitted on a calibration half, scored on a test half neither the fit nor the calibrator saw. The gain is where the mass is: bucket 0.8–0.9 gap +0.016→+0.000 (2·se 0.006), 0.9–1.0 +0.009→+0.001 (2·se 0.002) | 1,188,585 train / 65,899 calibrate / 65,898 test | `python -m analysis.recalibrate` |
| **K-fold isotonic, on every row** | raw ECE 0.0138, MCE 0.0712 | **ECE 0.0001, MCE 0.0061.** 5 folds; θ/β fitted out-of-fold AND the calibrator fitted out-of-fold, so every one of 1,320,382 rows has an out-of-sample prediction. After correction **no bucket's gap exceeds its own 2·se** — before, all ten did | 1,320,382 rows, 5×300 epochs | `python -m analysis.recalibrate_kfold` |
| **The MID-RANGE defect — RESOLVED** | worst \|gap\| 0.045 | **0.006, an improvement of 0.039 against a noise floor of 0.010.** The earlier "unresolved" was purely sample size: one 10% holdout gave those buckets 221–857 rows and a 0.044 floor; k-fold gives them 4,000–16,000 and a 0.010 floor | same | same |
| **Recalibration vs the 2PL, held-out log loss** | 1PL raw 0.229407 | **isotonic 0.222866 — 2.85% BETTER.** For contrast the 2PL was 6.1% worse. So the cheap monotone correction beats the extra 11,284 parameters by ~9 points of log loss, and it is not merely a reporting fix — it predicts better | same | same |
| **Platt vs isotonic** | — | **Platt is worse than doing nothing in the band that motivated the work: mid-range \|gap\| 0.056 against the raw 0.045**, while improving ECE to 0.0047. Every Platt bucket is still outside noise. Two parameters can stretch and shift a curve but cannot unbend one | same | same |
| **Calibration wired into the API** | not wired | **Shipped as 334 knots in `apps/api/data/calibration_map.json`** (12 KB), applied with `bisect` from the standard library — no sklearn or numpy at request time. Recorded quality is the out-of-fold estimate (ECE 0.013794 → 0.000134, MCE 0.071201 → 0.006106), because the shipped map is fitted on all rows and scoring it in-sample gives a meaningless 0.0 | `GET /v1/recommendations/calibration` | `make export-calibration` |
| **Solve probabilities actually served** | — | **ZERO, by design.** θ/β are keyed by Codeforces handles and problem ids; no platform problem or user has one, so `solve_probability` is null on every item and the response says why. The alternative — mapping the `easy\|medium\|hard` enum onto a Codeforces β — would invent the input | same | `apps/api/tests/test_calibration.py` |
| **Is cold start the explanation?** | — | **No — ruled out.** Only **1,996 of 1,320,382 rows (0.15%)** had a problem no training fold saw, and the seen-only curve (MCE 0.0713) is indistinguishable from the all-rows curve (0.0712) | same | same |
| **Tutor eval, first four-mode baseline** | debug-only, format-scored | **Bug localisation 13/33 = 0.394** [0.247, 0.563] on a stock Qwen2.5-7B-Instruct with the production prompt-engineered system prompts. Format checks are near-perfect by contrast: asks-a-question 39/39, no-answer-leakage 47/48, must-mention 4/15 | 48 gold scenarios across debug/teaching/explain/followup, A40 | `make evals` |
| ↳ **finding the bug vs numbering it** | — | **Located by line number 4/33 (0.121); by quoted code 10/33 (0.303); by either 13/33.** The tutor frequently quotes the exact buggy source line while citing a wrong line number — the gold set counts lines within `source_code`, the model within `user_message`, which prepends a question and a ```` ```python ```` fence (offset 2 in 30 of 33). **Correcting for that offset made the score WORSE (3/30 vs 4/33)**, ruling out a simple coordinate bug: the numbering is just inconsistent. Reported as two signals because a wrong label is a formatting problem and a wrong location is a competence problem | same | same |
| **CUDA content claims, measured on an A40** | asserted | **2 of 3 claims needed correcting.** Online softmax exactness CONFIRMED (max abs diff 4.5e-8 to 8.9e-8, all under fp32 eps 1.19e-7, and not growing as the block shrinks). Launch overhead is **7.25 us, not the 5 us quoted** — though the model is exact: predicted floor 2.899 ms vs measured 2.893 ms, and CUDA graphs give 6.8x. Tensor-core framing was **wrong**: K=4093 costs only 2% in fp32 but 39% in bf16, because dtype is the gate and alignment only bites after it is fixed | NVIDIA A40, torch 2.4.1+cu124 | `python scripts/verify_cuda_claims.py` (needs a GPU) |
| **Content catalogue** | 123 items | **200 items — the revised plan's target MET.** Every per-area minimum met with room: ML+DL 98 (target 60–100) · LLM 58 (40–60) · CUDA 44 (30–50) · Systems 35 (20–40) · VLM 24 (20–30) | `features/content.load_raw` | `python -m scripts.verify_problems` |
| ↳ **auto-graded share** | 79 executable / 30 rubric | **125 executable / 32 rubric.** 495 test cases across 87 problems, every `expected_output` COMPUTED by executing its reference rather than typed, each item carrying independent arithmetic checks asserted before it is written | same | same |
| **Tables with enforced data contracts** | 0 | **4 of 4 schema-clean; 1 failure remaining of 5 found** — the 3 referential ones are fixed, 1 was my schema over-specifying an int width | live warehouse, 2.3M rows | `python -m quality.contracts` |
| **Catalogue referential integrity** | 906 orphans | **PASSING** — backfilled from data already on disk: 12,217 problems (11,311 problemset + 906 reconstructed), 0 duplicates, provenance on every row | same | `python -m features.backfill_catalog --write` |
| **IRT convergence where evidence exists** | — | **FAILING** — 16 problems with ≥7 observations have \|β\| > 10 (max 14.51). Separately, 466 of 5,307 thinly-observed problems do too, which is expected boundary behaviour on n=1 | same | `python -m quality.contracts` |
| Risk-register rows with a backing artefact | 0 | **NOT MEASURED** — `docs/RISK_REGISTER.md` does not exist | — | — |
| **Worst-segment NDCG@10 vs the mean** | — | **Sparse-history learners are UNDERSERVED: NDCG@10 0.1272 [0.1045, 0.1523] against an overall 0.1888 — 32.6% below, and the interval EXCLUDES the mean.** Monotone in history depth: 1–5 problems 0.1272 · 6–20 0.1965 · 21–60 0.2636 · 61+ 0.2664. Sparse learners get **less than half** the ranking quality of established ones | 700 learners, World A, LambdaMART | `make fairness` |
| ↳ **behavioural segments show no gap** | — | segment_0 0.1792 (−5.0%), segment_1 0.1889 (+0.1%) — neither flagged, neither interval excluding the mean. The disparity is entirely about HISTORY DEPTH, not about how a learner practises | same | same |
| ↳ **the audit was a false negative at n=200** | — | At 200 learners the sparse bucket read **−13.8% and did NOT trip the 15% flag**; at 700 it reads −32.6% with a CI excluding the mean. A fairness audit is a subgroup analysis, so it needs more traffic than the aggregate it audits — an underpowered one reports "no problem found" | 200 vs 700 learners | same |
| ↳ **about half the raw gap is task difficulty, and half is the ranker** | — | Sparse learners have a median of **2** gradeable positives against 4 / 8 / 10 for the deeper buckets, and finding 1 of 2 in a top-10 is harder than 1 of 10. Holding the positive count fixed: at **1 positive there is no gap** (sparse 0.0945 n=78 vs 0.1006 n=33); at 2–3 it is −27% (0.1292 n=88 vs 0.1774 n=77); at 4–8 −28% (0.1844 n=58 vs 0.2561 n=104); at 9+ −36% (0.1010 n=36 vs 0.1574 n=40). **The controlled gap widens as positives grow**, which rules out task difficulty as the explanation for the part that remains | 700 learners, same run | `make fairness` |
| ↳ **a popularity fallback for sparse learners would make them WORSE** | — | The obvious cold-start fix, measured before building it: in the sparse bucket LambdaMART scores **0.1272 against popularity's 0.0276 — 4.6×**. Popularity loses in every depth bucket, not just on aggregate | same | `make fairness` |
| **THE FROZEN 33 WERE RE-AUTHORED — every figure measured against them is now a different population** | embedded fence | The frozen set carried its code inline in `user_message`; `VoidCodeAIPanel.tsx` sends `[SOURCE CODE]` **line-numbered**. That embedding was an authoring convenience, not a production shape, and it was expensive: measured in one run, same model and prompt, localisation was **0.702 on numbered scenarios against 0.396 on unnumbered ones** — two thirds of the debug set scored on a message a learner does not produce. `build_messages` now strips the embedded fence and re-attaches the source numbered, so 48 of 51 debug scenarios reach the model in the workspace shape (the 3 exceptions are multi-turn, whose code is in the conversation). **`11/33`, `13/33`, `14/33` and every other FROZEN-BASELINE figure describe the old input and must not be compared across this boundary** | 33 scenarios | `scripts/run_evals.py::build_messages` |
| **STREAMING, 5 IDENTICAL RUNS — the first figures that describe what a learner receives** | non-streaming, thinking-contaminated | Visible answer, 5-run means: `bug_localisation` **26.2/51 (0.514)**, single-bug 19.8/33, multi-bug recall **0.540**, `bug_count_accuracy` 25.0/48, `no_answer_leakage` **72.4/75 (0.965)**, `no_invented_code` **48.8/51 (0.957)**, `asks_a_question` 55.6/57. Per mode: empathy **9/9 in every run** · explain 4.2/5 · teaching 5.0/6 · debug 21.4/51 · followup **0.6/4**. **Leakage and invented-code improved sharply once reasoning was split out; localisation and multi-bug fell.** Multi-bug recall now **fails** its ≥0.55 gate at 0.540 | 75 scenarios × 5 runs | `docs/evidence/eval_stream_run{1..5}.json` |
| ↳ **NOISE FLOOR on this artifact — a change must beat its check's range** | ±3/51 on Qwen2.5/vLLM, does not transfer | Five identical runs, nothing changed between them. `no_invented_code` **47–51** (sd 1.48) · `no_answer_leakage` **71–74** · `mentions_required` **9–12** · `bug_localisation` **25–28** · `bug_count_accuracy` **24–26** · `asks_a_question` **55–57** · empathy's three checks 9–9. **`no_invented_code` swings by 4 scenarios from re-running the same code**, so run 1's headline 51/51 was luck. Routing is deterministic: 55/75 in all five | 5 runs | `scripts/noise_floor.py` |
| ↳ **the reasoning surface is where leakage actually lives** | — | Split scored separately, never merged into the headline. `no_answer_leakage` visible **58/58** against **36.6/58 including reasoning**; `no_invented_code` visible 47/47 against 33.2/47. So ~21 of 58 reasoning traces hand over a complete corrected function, and the ThinkingBlock publishes them. Both surfaces must clear ≤0.02, per the decision to fix the reasoning rather than hide the UI | 58 responses × 5 runs | same |
| **THE PRODUCTION-PATH FIGURES BELOW WERE SCORED ON THE MODEL'S PRIVATE REASONING — corrected** | — | `strip_thinking_tags` required a matched `<think>`/`</think>` pair. **Qwen3.5-9B emits only the closing tag: 57/75 responses carry `</think>`, 0 carry `<think>`.** So nothing was stripped and the grader read the scratchpad as answer text. Rescored on the visible answer: `bug_localisation` **39/51 (0.765) → 30/51 (0.588)**, mean recall **0.784 → 0.627**, multi-bug **12/15 → 8/15** (recall 0.867 → 0.667), single-bug 26/33 → 21/33 — all **inflated**. In the other direction `no_answer_leakage` **50/75 → 71/75** and `no_invented_code` **37/51 → 47/51** were **understated**, because 22 of the 25 leak failures were a complete function sitting in the unstripped reasoning. `asks_a_question` and `bug_count_accuracy` unchanged. Streaming never had the defect — it splits on a bare `</think>` — so **the harness measured a path no learner uses** | 75 responses rescored | `tests/test_thinking_split.py` |
| ↳ **the numbers in every row below are NOT the production numbers** | — | They were produced with `stream: False`; the web client sends `stream: true` (`VoidCodeAIPanel.tsx:1342`). The streaming path also sends per-mode `enable_thinking` and `thinking_budget_tokens`, which non-streaming hardcoded to `True`/absent — so `empathy` and `followup`, which disable thinking to protect 512- and 1024-token ceilings, had it forced on uncapped. **Re-measurement on streaming is pending; treat the rows below as superseded on arrival** | — | `main.py` `_sglang_extra_body` |
| **THE PRODUCTION PATH, MEASURED FOR THE FIRST TIME** — **figures SUPERSEDED by the row above; localisation is 30/51 on the visible answer** | never measured | **75 scenarios through the real request path** — `detect_mode` → `_ground` → `get_system_prompt(pe_mode=True)` → **stock Qwen3.5-9B on SGLang, no adapter**. `bug_localisation` **39/51 (0.765)** [0.632, 0.860], mean recall **0.784**, `bug_count_accuracy` 27/48, `no_invented_code` 37/51, `asks_a_question` 57/57. Per mode (all checks): explain **5/5** · teaching **6/6** · followup 2/4 · empathy 4/9 · debug 9/51. **NOT comparable to any earlier row** — different model, server, prompt path, and the router is live rather than bypassed. 0 generation failures | 75 scenarios, local RTX 5060 Ti, fp8, `mem-fraction-static 0.80` | `docs/evidence/eval_production_sglang_75.json` |
| ↳ **the multi-bug "capability limit" was the 7B artifact, not the system** — **still true, but the margin is smaller: 8/15 and recall 0.667 on the visible answer, not 12/15 and 0.867** | 2/16, recall 0.50 | **12/15 passed, mean recall 0.867** on the production model. The earlier row called this "a genuine 7B capability limit — not a harness artefact, not a metric artefact, not prompt-fixable". That conclusion was right about the artifact and wrong as a statement about VoidCode. Single-bug 26/33 | 15 multi-bug scenarios | same evidence file |
| ↳ **ROUTING IS 55/75 (0.733), AND THE 48/75 BELOW WAS MIS-MEASURED** | never measured end to end | Computed directly from `decide_mode` over the gold scenarios — deterministic, no log parsing, and reproduced exactly by 375 `[route]` lines across 5 runs (55/75 in every run). The 48/75 row below came from aligning log lines to scenarios by order and was wrong. **The corrected per-mode picture is materially different: `empathy` routes 9/9, not 4/9.** So the claim that "roughly half the empathy regression is routing" was false — empathy's 4/9 all-checks score was caused entirely by the non-streaming `enable_thinking` bug, and empathy is now 9/9 in all five streaming runs. debug **31/51** → explain 8, teaching 7, general 2, followup 2, empathy 1; teaching 6/6, explain 5/5, followup 4/4. **The entire routing deficit is debug** | 75 scenarios | `docs/evidence/eval_stream_run{1..5}.json` |
| ↳ **(superseded) END-TO-END ROUTING: 48/75 (64.0%)** | never measured end to end | First measurement of `decide_mode` as the API actually calls it. teaching **6/6** · explain **5/5** · followup **4/4** · debug **29/51** · empathy **4/9**. Debug leaks to explain:12, teaching:4, followup:4, general:2; empathy leaks to debug:4. Misrouting is not cosmetic — it swaps the system prompt AND the token budget (one debug scenario got followup's 1024 cap), and grounding is gated on the *routed* mode, so a misrouted `explain` silently loses retrieval. Alignment verified 73/75 | 75 scenarios | `[route]` lines, `routing_report.py` |
| ↳ **~~the thinking phase does not exist on the served model — hypothesis FALSIFIED~~ — THIS ROW WAS WRONG** | assumed present | **Retracted.** The evidence was "0/75 responses contain `<think>`" — the wrong tag. **57/75 contain `</think>`**; the model emits a closing tag with no opener, and the thinking phase is present. What did not exist was correct *stripping*. The A/B showing `enable_thinking=True` changes nothing still stands as measured, but it does not support the conclusion drawn from it. The original row is kept below verbatim rather than deleted, because the retraction is the record | 75 responses | `tests/test_thinking_split.py` |
| ↳ **(retracted) the thinking phase does not exist on the served model — hypothesis FALSIFIED** | assumed present | The prior row said `PE_DEBUG_PROMPT`'s "in your thinking" enumeration "cannot execute" on Qwen2.5 and that "settling it needs the production model". Settled: **0/75 responses contain `<think>` tags**, and a controlled A/B shows `chat_template_kwargs.enable_thinking=True` changes **nothing** — the model reasons in plain prose instead. So `thinking_budget_tokens` is unenforceable and `strip_thinking_tags` is a no-op here. The enumeration still has nowhere to run, **and multi-bug localisation improved anyway**, so the thinking phase was not the mechanism. Untested remedy: SGLang `--reasoning-parser` | 75 responses + 2-arm A/B | `docs/evidence/eval_production_sglang_75.json` |
| ↳ **answer leakage is the production path's weakest check** — **MOSTLY AN ARTIFACT: 22 of the 25 failures were unstripped reasoning; 4 survive a correct split (71/75)** | — | `no_answer_leakage` **50/75 (0.667)** — **all 25 failures are debug**; every other mode is clean. This is the check that drags debug's all-checks rate to 9/51 despite localisation at 0.765: the model finds the bug and then tells the learner the fix. **Not** explained by the visible scratchpad — within debug, the 6 responses showing reasoning leaked 0/6 vs 25/45 (56%) without it (Fisher p=0.023, n=6, **not pre-registered — a hypothesis, not a result**) | 51 debug scenarios | same evidence file |
| ↳ **empathy REGRESSED on the production path** | 9/9 on the 7B artifact | **4/9 all-checks**, and routing is half of it — only 4/9 empathy scenarios reach empathy mode, 4 route to `debug`. `no_debug_markers` 5/9 and `invites_continuation` 6/9. The 9/9 was measured with the mode supplied by the gold set; with the router live the same prompts are not reached | 9 scenarios | same evidence file |
| ↳ **the SGLang client timeout would have voided this run** | 120s | Modes ask for up to 8192 tokens; measured **18.6 tok/s** on the local card makes teaching ~440s and debug ~220s. 120s truncated everything except followup and empathy. Now `SGLANG_TIMEOUT_SECONDS`, default 900. **A latent production bug, not just a harness one** — at ~80 tok/s an 8192-token answer still needs ~102s | all modes | `apps/api/src/main.py` |
| **THE EVAL WAS MEASURING AN UNGROUNDED MODEL — fixed** | — | `_ground()` is called at exactly one place, inside the FastAPI handler (`main.py:854`), so a harness posting straight to vLLM got **no retrieval and not even the `UNGROUNDED_INSTRUCTION`** production appends when retrieval finds nothing. Every `explain` and `teaching` figure before this measured a system that skips a layer production always runs. `_generate_direct` now embeds the 30 file-backed corpus docs with the same Ollama model `main.py` uses, retrieves at the same `MIN_SIMILARITY`, and applies `ground_prompt` — **including with zero hits**, which is the fail-open path | 11 of 75 scenarios | `pytest tests/test_eval_gold_sets.py` |
| ↳ **all three fabricated facts disappear when grounded** | — | The strongest evidence, and it is per-claim rather than a rate. Ungrounded, the tutor called ZeRO *"Zero Residue Optimization"*, AWQ *"Adaptive Weight Quantization"*, and speculative decoding *"an optimization technique used in beam search"*. **Grounded, all three are gone**, and AWQ is now described correctly as scaling the channels that matter before quantizing. The explain answers were wrong because the model was answering from parametric memory with no reference material — which is exactly what grounding exists to prevent | 3 claims | `docs/evidence/eval_grounded_11.json` |
| ↳ **explain 1/5 → 3/5, and my pre-registered prediction was WRONG** | 1/5 | I predicted grounding would not help, because retrieval picks the wrong document for 3 of 5 explain queries (FlashAttention retrieves the RoPE doc at 0.664). Measured same-session against a fail-open arm: **explain 3/5 vs 1/5, teaching 2/6 vs 2/6, mentions_required 5/11 vs 3/11**. Wrong material still helped more than none | 11 × 2 arms | same |
| ↳ **but the rates are not established, and one control proves it** | — | n=5 gives a 95% CI of [0.23, 0.88]. `teach_lora_rank_001` retrieved **0 hits in both arms**, so its prompts were byte-identical — and it still flipped. That is a direct measurement of the noise floor at this sample size: per-scenario flips are not attributable. Net attributable effect is **+2 helped, −1 hurt, 1 noise flip, 7 unchanged** | 11 scenarios | same |
| **EMPATHY DETECTION FIXED — recall 3/9 → 9/9, false positives held at zero** | 3/9 | `detect_frustration` was `any(signal in msg ...)` over ~60 literals. Restructured into four families over apostrophe-folded, clause-split text with word boundaries and a negation guard. Measured on `tests/fixtures/frustration_cases.py`: **gold recall 9/9**, **curly-apostrophe recall 8/8** (was 2/8), **hard-negative FPs 0/16** (was 10/16), **catalogue FPs 0/185** (unchanged). All four criteria were pre-registered before the rewrite ran | 9 gold + 16 hard negatives + 185 catalogue | `pytest tests/test_routing.py` |
| ↳ **the phone-apostrophe blind spot was half the loss** | — | Every `i'm …` signal was written with an ASCII `'`. With the U+2019 that iOS/macOS autocorrect produces, **5 of 6** common phrasings were invisible: `i'm stuck`, `i can't do this`, `i don't understand`, `i'm terrible at this`, `i'll never get this`. One `str.translate` recovered all of them | 6 phrasings | same |
| ↳ **three literals were routing technical talk into emotional support** | — | Bare `give up`, `hopeless` and `pointless` matched inside `"how do I give up ownership of a mutex in Rust?"`, `"this approach is hopeless for large n"` and `"this loop runs pointlessly twice"`. Deleted; first-person forms are covered by pattern instead. `can't do this` is now first-person too, so `"we can't do this in O(1)"` no longer fires | 9 constructed cases | same |
| ↳ **the negation guard was nearly dead code, and mutation testing caught it** | — | Removing it broke **no** test: every negative was already handled by the first-person requirements and the deleted bare tokens. Probing found the two cases that do reach it — `"i'm not so confused anymore"` and `"not completely lost, just the last bit"`, a student saying they are now FINE. Both now in the fixture, so the mutant dies | 2 cases | same |
| **EMPATHY NOW REACHES A LEARNER'S FIRST MESSAGE** | never | The override was gated on `n_user_messages > 1` because `EMPATHY_SYSTEM_PROMPT` Step 3 says *"look back at the previous assistant message"* — unsatisfiable on turn one. `EMPATHY_FIRST_TURN_PROMPT` is **derived** from it (only Step 3 replaced, so the other rules cannot drift) and the gate is gone. On an A40, the 9 empathy scenarios sent as first turns: **9/9 on the empathy checks, 0/9 claiming a prior exchange** — against the unmodified prompt's **8/9** on the same first-turn input | 9 scenarios × 2 arms | `docs/evidence/first_turn_empathy.json` |
| ↳ **routing accuracy 16/75 → 22/75, all of it empathy** | 16/75 | empathy **3/9 → 9/9** (and 0/9 → 9/9 at turn one); debug 12/51, explain 1/5, followup 0/4, teaching 0/6 all **unchanged**. A targeted fix should move one thing, and this moved one thing | 75 scenarios | `pytest tests/test_routing.py` |
| **THE MODE ROUTER, MEASURED FOR THE FIRST TIME** | never evaluated | **16/75 (21%)** mid-conversation, **13/75 (17%)** on a first turn, against the gold sets' own mode labels. Per mode: debug **12/51** · empathy **3/9** · explain **1/5** · followup **0/4** · teaching **0/6**. Routing is upstream of every prompt: when it is wrong the right prompt is never sent, so each per-mode figure above measures a system the learner never reached | 75 scenarios | `pytest tests/test_routing.py` |
| ↳ **read the rate as a regression FLOOR, not a traffic estimate** | — | The gold sets were authored to exercise each mode's *prompt*, not as router labels. They are defensible ground truth — these are messages that should reach that mode — but they were not written for it. The three defects below do not depend on that caveat | — | same |
| ↳ **`empathy` can never fire on a first message** | — | The override is gated on `n_user_messages > 1`, so a learner opening with *"I give up, I'm terrible at this"* is routed by keyword on their worst turn. The gate exists so the model has context to reference, which is a real reason — now pinned as a decision rather than a surprise | pure logic | same |
| ↳ **`detect_frustration` misses 6 of 9 plainly distressed phrasings** | — | Fires on 3/9. Misses *"I feel so dumb"*, *"I don't think I'm ever going to get this"*, *"should I just quit?"* — the list carries `im dumb` and `i quit` but not these. Ordinary ways a person says they are struggling | 9 scenarios | same |
| ↳ **the code-context signal is restored — SHIPPED** | 12/51 | `_extract_user_intent` strips the `[SOURCE CODE]` block so its contents cannot bias matching toward debug — sound — but that also erased **that code was attached at all**, so a learner asking "the output keeps growing, why?" with their buggy code attached looked like an abstract question. `detect_mode(..., has_code_context=)` now takes the one bit, never the contents. **debug routing 12/51 → 20/51, overall 22/75 → 30/75**, and empathy/explain/followup/teaching all unchanged | 75 scenarios | `pytest tests/test_routing.py` |
| ↳ **`general` is no longer where misroutes go** | 37/53 | **13/45.** The catch-all was swallowing messages that carried code. What remains are genuine mode confusions — a harder problem than a fall-through, and a different one | same | same |
| ↳ *(superseded, kept for the trail)* **the signal was measured and deliberately not shipped** | — | `_extract_user_intent` strips the `[SOURCE CODE]` block so its contents cannot bias matching toward debug — sound — but that also erases **that code was attached at all**. Adding back a bare marker, no contents: debug routing **12/51 → 20/51**, overall **21% → 32%**, nothing else regresses. Not shipped: it changes production routing and is the user's call | simulated | same |
| **RE-RUN AFTER RELABELLING — the extended-set figures are valid again** | stale | 75 scenarios on a fresh A40, **merged fp16** (not AWQ; the two were measured within noise, 20/51 vs 21/51). `bug_localisation` **18/51**, mean recall **0.461**, `bug_count_accuracy` 27/48, `no_invented_code` **48/51**. Per mode: empathy 9/9 · explain **4/5** · teaching 3/6 · followup 1/4 · debug 14/51 | 75 scenarios | `docs/evidence/eval_relabelled_75.json` |
| ↳ **the only clean cross-run comparison is the frozen 33: 14/33 → 13/33** | 14/33 | Two things changed at once — the served artifact (AWQ → fp16) and the wording of 13 extended scenarios — so the extended set cannot be compared across the boundary at all. The frozen 33 changed neither, and moved by **one scenario**, inside the ±3/51 run-to-run noise measured earlier. **The model did not change.** | 33 scenarios | same |
| ↳ **relabelling did NOT improve localisation, and may have cost a little** | 8/18 | The extended set went **8/18 → 5/18**. Clearer bug reports helped ROUTING (12/51 → 20/51, measured offline) and did nothing for FINDING the bug. At n=18 and temperature 0.4 a 3-scenario move is inside noise, so this is "no effect", not "harmful" — but it is certainly not the improvement a clearer request might have been expected to bring | 18 scenarios | same |
| ↳ **grounding shows up again: explain 1/5 → 4/5** | 1/5 | Consistent with the earlier same-session grounded/fail-open A/B (3/5 against 1/5). Two independent runs now put grounded explain well above ungrounded, which is the one clear product-level win in this sequence | 5 scenarios | same |
| **THE DEBUG GOLD SET DID NOT LOOK LIKE REAL TRAFFIC, and that cost 9 routing points** | 28% | 13 of the 18 extended debug scenarios described a symptom without naming a bug — *"clamp(5, 0, 10) gives me 10"*, *"always returns 0"*. Measured over **2,020 real code-submitting user turns, 86% carry debug vocabulary**; this set carried **28%**, over-representing a rare phrasing threefold. Reworded to the base rate (now 83%), keeping every bug, source line and ground-truth entry byte-identical. **debug routing 20/51 → 29/51, overall 44/75 → 53/75, WITH NO CHANGE TO THE ROUTER** — the instrument was wrong, not the product | 18 scenarios | `pytest tests/test_eval_gold_sets.py` |
| ↳ **the first correction overshot to 100% and was walked back** | — | Targeting 86% and landing at 100% is the same error mirrored: it erases the 14% who genuinely report a bug without naming it, and flatters the router instead of maligning it. Three were reverted to symptom-only. The test asserts a **two-sided** window for exactly this reason | 18 scenarios | same |
| ↳ **the extended-set EVAL figures are now stale** | — | The 13 reworded messages are what the model receives, so `bug_localisation 8/18` and everything else measured on the extended set was measured on different input. **Needs a GPU re-run before being quoted**; the frozen 33 are untouched and remain valid | 18 scenarios | `--prompt-mode finetuned` |
| **ROUTING: 16/75 → 53/75, and every mode routes something** | 16/75 | Five targeted fixes, each moving exactly one mode and none regressing another: empathy **3/9 → 9/9**, debug **12/51 → 20/51**, explain **1/5 → 5/5**, teaching **0/6 → 6/6**, followup **0/4 → 4/4**. What remains is the debug long tail, and that is where the gold labels are weakest — many debug scenarios are terse natural phrasings with no keyword at all | 75 scenarios | `pytest tests/test_routing.py` |
| ↳ **followup 0/4 → 4/4: it was too narrow AND too greedy at once** | 0/4 | Every gold message names the prior turn outright — *"You said…"*, *"Earlier you mentioned…"*, *"Follow up:…"*, *"Following on from that…"* — and not one starter matched. Meanwhile "any question of eight words or fewer" was claiming *"what is the capital of France?"* and *"can you review my resume?"*. Explicit back-references are now checked **above `explain`**, which is what fixes the fourth scenario: *"Following on from that — what does a BPE tokenizer do…"* names the prior turn *and* asks a what-does question, and with explain first the generic shape won | 4 scenarios | same |
| ↳ **the real distinction was anaphoric vs generic, not programming vs not** | — | Gating the weak shapes on `is_programming_related` fixed the greediness but **broke `"so why does that work"`** — a genuine continuation with no programming vocabulary. The starter list had been mixing two things: `so `/`but `/`that `/`then ` point backwards and are self-evidencing; `can `/`when `/`why `/`where ` start new topics as often as they continue one. Split accordingly, and both ends hold | 7 probes | same |
| ↳ **`detect_mode` is fixed; the conversation-length override is a separate layer** | — | *"can you review my resume?"* now leaves `detect_mode` as `general` correctly, but `decide_mode` still promotes it at 3+ turns because it is under 30 characters. That heuristic has its own rationale and changing it is a separate decision — pinned by a test so the distinction is not lost | 3 probes | same |
| ↳ *(superseded)* **majority-correct at 40/75** | 16/75 | Four targeted fixes, each moving exactly one mode and none regressing another: empathy **3/9 → 9/9**, debug **12/51 → 20/51**, explain **1/5 → 5/5**, teaching **0/6 → 6/6**. `followup` is the only mode still at zero | 75 scenarios | `pytest tests/test_routing.py` |
| ↳ **teaching 0/6 → 6/6: `teach me` was not a trigger at all** | 0/6 | Every message in the teaching gold set opens *"Teach me…"*, and `teaching_keywords` held none of it — only programming acts like `implement`, `write code`, `solve this`. All six landed on `explain` or `general`: the learner asked to be **taught** and got a definition | 6 scenarios | same |
| ↳ **and the trigger is gated, because ungated it scaffolded the French Revolution** | — | `teach me` is a bare request to be taught *anything*, unlike the rest of the list which names programming acts. Ungated, *"teach me about the french revolution"* reached the TEACHING prompt — which emits `[EXPLAIN][TEMPLATE][GUIDE]` with code blanks, so the model would try to scaffold code for a history question. Gating on `is_programming_related` restores `general` and costs nothing, once `pre-norm`/`post-norm` were added — that vocabulary gap was the single scenario the gate would otherwise have dropped | 3 off-topic probes | same |
| ↳ **the keyword list now knows ML — explain 1/5 → 5/5** | 1/5 | `programming_keywords` was entirely classical CS (`array`, `loop`, `recursion`, `stack`) on a platform repositioned to ML interview prep. 45 of 75 intents contained no keyword it recognised, so `is_programming_related` was False and four of five `explain` questions fell to `general`, the **non-programming** catch-all. The one that worked matched `coding` inside `de-CODING`, by accident. Vocabulary drawn from `data/concepts.yaml`'s 65 ML-side concept names, not invented. **explain 1/5 → 5/5, overall 30/75 → 34/75**, every other mode unchanged | 75 scenarios | `pytest tests/test_routing.py` |
| ↳ **bare `attention` and `transformer` were deliberately left out** | — | They are the polysemy already recorded against the embedder: *"how much attention should I give a new puppy"* scores 0.506 and *"what transformer do I need for european appliances"* 0.501 against the ML corpus. Both are now routing guards, and both still reach `general`. Multi-word forms (`attention head`, `transformer block`, `attention matrix`) carry the domain without the ambiguity | 3 off-topic probes | same |
| ↳ **`followup` over-claims short questions, and it predates all of this** | — | *"what is the capital of France?"*, *"can you review my resume?"* and *"when is the assignment due?"* reach `followup`, not `general`. `followup_patterns` grabs any question of ≤8 words and anything opening `can `/`when `. **Verified against the pre-change router: identical**, so this is the followup catch-all being greedy rather than the keyword list being wide. Pinned by a test so it cannot later be blamed on the ML vocabulary | 3 probes | same |
| ↳ *(superseded)* **the keyword list predates the ML pivot** | — | `programming_keywords` is entirely classical CS (`array`, `loop`, `recursion`, `stack`) with **no ML vocabulary**. 45/75 intents contain no CS keyword; 11 contain ML terms but no CS term, so they are "not programming related" and fall through to `general`. `general` swallows the majority of all misroutes | 75 scenarios | same |
| ↳ **it was untested because it was six lines in a 700-line handler** | — | Extracted to `main.decide_mode()`, a pure function, with behaviour proven identical over **318 (message, turn-count) pairs**. 13 tests; 3 mutants killed (turn-gate removed, intent extraction bypassed, followup override always on) | — | same |
| **AUTHORITATIVE EVAL — correct prompt mode, 75 scenarios, AWQ 4-bit** | wrong-prompt run | **bug_localisation 22/51 (0.431)**, mean recall **0.529**, bug_count_accuracy **27/48 (0.562)**, no_invented_code **44/51**. Per mode: empathy **9/9** · teaching 3/6 · explain 1/5 · followup 0/4 · debug all-checks 16/51. Against the superseded wrong-prompt run: localisation **15/51 → 22/51**, recall **0.363 → 0.529** | `--prompt-mode finetuned` | `docs/evidence/eval_awq_75_scenarios.json` |
| ↳ **reproducible: 21/51 and 22/51 in two independent runs** | — | Same setting, separate sessions, temperature 0.4. Inside the ±3/51 noise floor measured earlier, so the +7 improvement over the wrong prompt is real and the residual figures are stable | 2 runs | same |
| ↳ **each of the three harness fixes moved the extended set** | 1/18 | **1/18 → 4/18 → 8/18** as source delivery, then production sampling, then the correct system prompt were fixed in turn. The scenarios were never "harder"; the harness was wrong three different ways | 18 scenarios | same |
| ↳ **multi-bug is unchanged at 2/16, as the root-cause analysis predicted** | 2/16 | Correct prompt, correct source, production sampling, quantization exonerated, follow-up turn allowed — it does not move. Mean recall 0.529 means it finds about half the bugs in multi-bug programs. **A genuine capability limit of this 7B artifact** | 16 scenarios | same |
| ↳ **two checks got WORSE under the correct prompt, and that is reported** | — | `no_invented_code` **48/51 → 44/51** and `asks_a_question` **57/57 → 50/57**. The fine-tuned prompt produces a different output style; `asks_a_question` leaving the ceiling makes it informative again, but the invented-code regression is a real cost of the correct prompt and is not hidden | same run | same |
| **ROOT CAUSE: the fine-tuned model was served the WRONG SYSTEM PROMPT for every debug eval** | — | `get_system_prompt(mode, pe_mode=True)` defaults to the prompt-engineered prompts built for **stock Qwen3.5-9B on SGLang**. The artifact under test is the **fine-tuned model on vLLM**, whose 1,860 training examples all carry `FINETUNED_SYSTEM_PROMPT` (98.2% identical to today's constant, same prefix). The harness called the function with its default. Measured back to back on one server: overall localisation **14/51 → 21/51**, mean recall **0.333 → 0.510**, single-bug **13/35 → 19/35**. **A ~50% relative error from one omitted keyword argument, with nothing in the output to show it** | 51 debug scenarios × 2 arms | `docs/evidence/ab_prompt_mode_debug.json` |
| ↳ **quantization EXONERATED** | — | fp16 merged **20/51**, AWQ 4-bit **21/51**, mean recall 0.490 vs 0.510, multi-bug 2/16 both. Same weights, same prompt, same sampling — W4A16 is not what broke this | 51 × 2 models | `ab_quant.py` |
| ↳ **"the adapter was trained to report one issue" REFUTED** | — | The v5.3 corpus is **65% two-issue responses** (91 of 140 debug-formatted), only 35% single-issue. The model was not taught to stop at one | 1,860 examples | training data |
| ↳ **the metric contradicts the product, but only for 2 of 16** | — | The tutor writes *"I found **2 issue(s)** … Let's tackle the first one first"*, names one, and stops at **473 chars against a 2048-token cap** — Socratic one-step-at-a-time guidance, which is what the product is FOR, scored as a miss by a check demanding every line in one turn. But a follow-up turn ("is anything else wrong?") recovered the second bug in only **2 of 16** (3/16 → 5/16, recall 0.438 → 0.500). **The pre-registered "majority" criterion FAILED**, so deferral is real and small | 16 multi-bug scenarios | `docs/evidence/multiturn_probe_multibug.json` |
| ↳ **counting is a different ability from enumerating, and much stronger** | — | New `check_bug_count_accuracy`: **28/48** correct counts against **20/51** localisation on the same responses; it states a count at all in 38/48. Conflating the two hid which ability is weak | same run | `run_evals.py` |
| ↳ **the residual multi-bug gap is a genuine 7B capability limit** — **SUPERSEDED, see the production-path row: 12/15 and recall 0.867 on Qwen3.5-9B** | — | After the prompt fix, after exonerating quantization, and after allowing a follow-up turn, the model still finds ~half the bugs in multi-bug programs (mean recall **0.50**). Not a harness artefact, not a metric artefact, not prompt-fixable — the enumerate-first variant failed its guard | — | — |
| **THE PREVIOUS EVAL RUN'S DEBUG HALF WAS VOID — three harness bugs, all mine** | — | The harness sent `user_message` and nothing else. All **18 extended scenarios** keep their code in `source_code`, so the tutor was asked *"why does the output keep growing?"* **with no code at all** — it invented plausible code and critiqued that. The three `eval_mt_*` scenarios lost their conversation history the same way, and sampling was ad-hoc (`temp 0.0`, `max_tokens 1024`) against a mode configured for `0.4`/`4096`. Fixed by `build_messages()` + production sampling; pinned by `test_the_model_always_receives_the_source`. Effect: invented code **35.3% → 5.9%**, extended **1/18 → 4/18**, mean recall **0.353 → 0.431** | 51 debug scenarios | `run_evals.py` |
| ↳ **but `0/16` on multi-bug SURVIVED the fix** | — | **1/16 in two independent runs** at production sampling. The finding was not an artefact of the harness bugs. 45 of 51 responses open "I found **1 issue**" and emit exactly one Issue block — despite a prompt that already says *"identify every bug"* and *"build a complete candidate bug list"* | same | same |
| ↳ **the prompt fix was tried, pre-registered, and FAILED** | — | An explicit ENUMERATE-FIRST directive (production prompt left untouched): multi-bug 1/16 → **2/16** (+1, noise at n=16) while single-bug fell **17/35 → 14/35**, violating the guard set in advance, and invented code rose 0 → 2. **Not merged.** Evidence in `docs/evidence/ab_enumerate_first_multibug.json` | 51 × 2 arms | scratchpad A/B |
| ↳ **root cause: the prompt's enumeration step has nowhere to run** — **RESOLVED, and not as predicted: the served Qwen3.5-9B has no thinking phase either (0/75 `<think>`), yet multi-bug improved regardless** | — | `PE_DEBUG_PROMPT` puts bug enumeration *"in your thinking"*, and production allots `thinking_budget_tokens: 512` on **Qwen3.5-9B**. The evaluated artifact is **Qwen2.5-7B, which has no thinking phase at all**, so the prompt's central mechanism cannot execute. This is a statement about the artifact, not about production — settling it needs the production model | — | `prompts.get_generation_config` |
| ↳ **run-to-run spread is ±3/51 at production sampling** | — | Two runs at *identical* settings gave **15/51 and 18/51** overall (single-bug 14/35 vs 17/35). `temperature 0.4` is production's own value, so the eval is non-deterministic and **single-run comparisons are unreliable** — a difference of a few scenarios means nothing. Multi-bug at 1/16 was stable across both | 2 runs | same |
| **First multi-mode eval run** | never run | **75 scenarios, 5 modes, on an A40.** debug 15/51 · empathy 9/9 · teaching 3/6 · explain 1/5 · followup 0/4. **Served model was Qwen2.5-7B + merged LoRA at AWQ 4-bit, NOT production** (stock Qwen3.5-9B, prompt-engineered, no adapter), and the prompt layer was applied by the harness with the mode taken from the gold set, so `detect_mode()` is untested here. **This is not comparable to 11/33** — different model *and* a different check set (3 checks vs 6 format checks) | 75 scenarios | `--direct-vllm` |
| ↳ **0 of 16 multi-bug scenarios passed** | — | The single most useful thing the run produced. Single-bug scenarios pass **15/35**; scenarios requiring *every* bug to be found pass **0/16**. The tutor reliably finds *a* bug and never *all* of them — invisible to the old set, which was mostly single-bug and 79% easy | 51 debug scenarios | same |
| ↳ **difficulty gradient, finally measurable** | 26 easy / 6 medium / 1 hard | easy **0.423** (n=26) · medium **0.188** (n=16) · hard **0.111** (n=9). Monotone. The extended set alone scores **1/18** against the frozen 33's **14/33**, so the added scenarios are genuinely harder rather than merely more numerous | same | same |
| ↳ **the tutor quotes the right code more often than it numbers it** | — | Passing by quoted code **11/51**, by line number **6/51**, mean per-bug recall **0.353**. Consistent with the earlier finding that numbering and locating are different abilities needing different fixes | same | same |
| ↳ **two checks are at ceiling and cannot discriminate** | — | `no_answer_leakage` **74/75**, `asks_a_question` **56/57**. A check that everything passes measures nothing; they are kept as regression guards, not as quality signal | same | same |
| ↳ **`followup 0/4` overstates the failure** | — | Driven by `check_mentions_required`, a substring match its own docstring calls crude. One response — "batch norm … uses precomputed values" — is substantively correct and fails only because the gold set demands the token `running`. One of the four is a genuine miss. **The gold spec should accept alternatives, and that edit must be made BEFORE the next run, not after seeing this one** | 4 scenarios | same |
| **Tutor eval coverage** | debug only, 33 scenarios | **5 of 6 routed modes, 75 scenarios** — debug 51 · empathy 9 · teaching 6 · explain 5 · followup 4. `general` is uncovered by design: it is the fallback and has no contract to check | — | `make evals` |
| ↳ **debug difficulty rebalanced without moving the baseline** | 26 easy / 6 medium / 1 hard | **26 / 16 / 9** across 51 scenarios. The original 33 are **frozen byte-for-byte** and reported as their own `FROZEN-BASELINE` bucket, so the published **11/33** stays a like-for-like reference instead of quietly becoming 11-of-a-different-51 | 18 new scenarios, 6 multi-bug | `scripts/authoring/build_debug_extended_gold.py` |
| ↳ **a frozen-set scenario was unpassable, and nobody could have noticed** | — | `eval_is_anagram_syntax_logic_001` carried an author's note inside `ground_truth_bugs` reading *"Logic is sound once syntax is fixed"* — so `check_bug_localisation` demanded a tutor cite **line 9, a correct line**, to pass. A right answer scored as a miss: the metric degrades as the product improves. Note moved to `notes`; `expected_bug_count`, the source, and the 33-scenario count are untouched, so the old harness reads exactly what it read before | 1 of 33 | `tests/test_eval_gold_sets.py` |
| ↳ **`-1` is an undocumented sentinel in the frozen set** | — | Three multi-turn scenarios use `expected_bug_count: -1` to mean "do not score the count". Found by the new validator, not by any documentation. Now pinned, and asserted to appear only on `eval_mt_*` ids | 3 of 33 | same |
| ↳ **the difficulty prior did NOT close it either** | — | **Negative result, not merged.** `difficulty_prior.solve_probability` added as a 12th ranker feature: aggregate 0.1887 → **0.1869** (guard violated) and the model gave it a **0.4% gain share, rank 6/12**. Paired bootstrap over the same 700 learners: sparse **−0.0014 [−0.0149, +0.0125] — no effect**, and none of the four depth buckets improved. Note first that `beta_for` (−1/0/+1) and `theta_from_mastery` (logit of mastery) are **monotone relabels of features the model already has**, so as separate columns they are provably no-ops for an axis-aligned tree; only the interaction `sigmoid(θ−β)` could add anything, and it did not | 700 learners, one pre-registered variant | scratchpad `try_prior.py` |
| ↳ **paired testing overturned the eye-read, twice** | — | Comparing per-stratum means side by side said "mixed — better at 2–3, worse at 4–8". Pairing the same learners across both runs said **no effect anywhere**. Cells of 40–90 learners carry more noise than the movements being read from them. `ranking.fairness.paired_delta` exists so this is not re-litigated by eye | same | `paired_delta()` |
| ↳ **empirical-Bayes shrinkage of the history features did NOT close it** | — | **Negative result, reverted.** Replacing "unknown mastery = 0.0" with a shrunk prior `(n·obs + k·prior)/(n+k)`, k=5: aggregate 0.1888 → **0.1906** (within noise) and the controlled 4–8 stratum went the wrong way for sparse learners, 0.1736 → **0.1642**. The trees already receive `mastery_known` and `attempts_on_concept`, so shrinkage re-encoded information the model could already split on | same | reverted in `features/ranking.py` |
| Test coverage, CI-reachable tree | 0 | **41.27%** (floor gated at 40) | GitHub Actions, Python 3.12 | `pytest tests --cov=features --cov=ranking` |

† The 411.9 tok/s QLoRA baseline was measured on a **RTX 5060 Ti (15.93 GiB)**, not on an
A6000. It is a valid measurement of the existing setup on the machine that exists; it is
**not** a valid baseline for A6000 throughput comparisons. Recorded in
`docs/MEMORY_AUDIT.md` §7.

---

## Phase 2 — detail

### Corpus (bronze)

| Quantity | Value |
|---|---|
| Source | Codeforces public API, `contest.status` |
| Rows fetched | **2,341,061** across both passes |
| Passes | 301 contests (breadth) + 1,000 learner histories (depth) |
| Landing zone size | 614 MB newline-delimited JSON |
| Rows surviving to silver | **2,296,409** (duplicate submission ids and `TESTING` / `SKIPPED` verdicts dropped — not evidence of anything the learner did) |

`make ingest` is resumable and idempotent — a manifest records per-file row counts and
already-fetched files are skipped.

### Feature pipeline (gold)

| Quantity | Value |
|---|---|
| Wall clock | **248.5 s** on 10 cores |
| Throughput | **9,241 rows/s** |
| Learners | **117,453** |
| Concepts observed | **67** of 80 |
| Concepts per learner | **NOT RE-MEASURED** since D-009 — the pre-rebuild figures were mean 9.43, median 7 |
| Warehouse size | 170 MB Parquet, snappy |
| Idempotent | **Yes — verified.** Two consecutive runs produced identical `rows_in`, `mastery_rows`, `learners`, `concepts_observed` and `reference_timestamp` |

All nine spec §4.3 features are populated, 25 columns in total: attempt count, pass rate,
first-attempt pass rate, mean attempts to accept, six-bucket error taxonomy distribution,
median time to accept, recency-weighted mastery (30-day half life), difficulty-adjusted
mastery, and the prerequisite co-failure signal.

Measured error taxonomy across all mastery rows: wrong answer **0.2222**, timeout
**0.0460**, compile error **0.0256**, runtime error **0.0137**, memory limit **0.0047**,
unclassified **0.0000** — every Codeforces verdict maps to a known bucket.

### Item response model

Rasch (1PL), fitted jointly over learner ability and problem difficulty.

| Metric | Value |
|---|---|
| Observations | **NOT RE-MEASURED** since D-009 — was 744,643 (learner × problem) on the old corpus |
| Train / held-out | 10% held out, seed 7 (`features/irt_data.py`) |
| **Held-out log loss** | **0.22661** |
| Baseline: global mean rate | → model **22.5 % better** |
| Baseline: per-problem mean rate | → model **25.28 % better** (see caveat below) |
| **Difficulty vs Codeforces rating, Spearman** | **0.4864** overall — 0.6627 at ≥50 observations, **0.8730** at ≥1000 |
| Problems with a published rating | most of 11,284 observed |
| Median observations per problem | **7** (was 145 on the 103-problem catalog) |
| Ability spread (θ) | **NOT RE-MEASURED** since D-009 |

**The Spearman figure is the one that matters, and it is the one that fell.** Codeforces
publishes its own difficulty rating, the model never sees it, and the recovered
difficulty parameter reproduces its ordering — that is external, non-circular evidence
that the model estimates difficulty rather than memorising the training matrix.

On the old 103-problem catalog it read **0.9170**. On the full corpus it reads **0.4864**,
and quoting the old number would be quoting a different experiment. The drop is not a
regression in the model: the catalog grew 103 → 11,284 while median observations per
problem fell 145 → 7, so most difficulty estimates are now built on very thin evidence.
Stratifying by evidence shows the model is fine where it can see — **0.6627** at ≥50
observations and **0.8730** at ≥1000.

**The operational consequence, per D-009: downstream code must gate on `n_observations`.**
A ranker that treats a β estimated from 3 observations as equal to one from 3,000 will
chase noise. `difficulty_beta_se_analytic` exists for exactly this.

### Choice of target, settled by measurement

The binary outcome the Rasch model predicts is a real design choice, so both candidates
were fitted rather than assumed. `make irt` defaults to `solved`; rerun with
`--target first_attempt_pass` to reproduce the second column.

**These figures predate D-009** and were measured on the 103-problem catalog. The
*conclusion* survives the rebuild — it is a comparison between two targets under
identical conditions — but the absolute numbers are not current and are kept only to
show the gap between the two columns.

| | `solved` (ever accepted) | `first_attempt_pass` |
|---|---|---|
| Base rate | 0.9141 | 0.6544 |
| Held-out log loss | **0.25092** | 0.57002 |
| vs global-mean baseline | **14.21 %** better | 11.33 % better |
| vs per-problem baseline | **4.66 %** better | 2.78 % better |
| Difficulty vs Codeforces, Spearman | **0.9170** | 0.8161 |

`first_attempt_pass` is the more discriminative target on paper — spec §4.3 calls it "the
strongest weakness signal" and its base rate is far from degenerate. It nevertheless loses
on **both** criteria: less improvement over baseline and materially worse external
validation. The reading is that a first-attempt failure carries a lot of noise that has
nothing to do with mastery — an off-by-one, a misread constraint, a wrong output format —
so it is a harder target without being a more *informative* one. `solved` stays the
default, now for a measured reason rather than an assumed one.

`first_attempt_pass_rate` remains a **feature** in the mastery vector regardless; this
finding is only about what the item response model should be fitted against.

Two honesty notes:

1. **The reported log loss is held out, not in-sample.** The Rasch model has one free
   parameter per learner, so in-sample loss falls whether or not it generalises. The gap
   (0.209 → 0.251) is the size of that effect.
2. **Hyperparameter selection was re-run after the rebuild and the answer reversed —
   see D-010.** On 103 problems, `lr=0.5` early-stopped at epoch 10 with unconverged item
   parameters (Spearman 0.846 vs 0.917), so `lr=0.05` was selected on log loss *subject
   to* beta convergence. On the full corpus `lr=0.5` converges at epoch 70 and wins on
   **both** criteria. More data changed the convergence regime, so the original objection
   no longer applies. This is why `features/irt_tune.py` states its own contract — rerun
   when the corpus changes — rather than recording a constant.

### Phase 2 acceptance gate (spec §4.4)

| Criterion | Required | Measured | Status |
|---|---|---|---|
| Rows processed | > 1,000,000 | 2,296,409 | **PASS** |
| Wall clock and rows/sec on stated cores | recorded | 248.5 s, 9,241 rows/s, 10 cores | **PASS** |
| Mastery vectors written | ≥ 10,000 learners | 117,453 | **PASS** |
| Job idempotent, reruns cleanly | yes | verified across two runs | **PASS** |

---

## Known limitations of the Phase 2 numbers

Stated here rather than buried, because they bound what the Phase 3 ranker can achieve.

1. ~~**Only 103 distinct problems.**~~ **RESOLVED by D-009.** The depth pass (1,000
   learner histories via `user.status`) lifted the observed catalog to **11,284 of
   11,311 — 99.8%**, so Recall@100 is a real measurement rather than an arithmetic
   identity. It was replaced by a different limitation, not eliminated: **evidence per
   problem is now thin** (median 7 observations), which is limitation 6 below.

2. **67 of 80 concepts carry direct evidence.** The other 13 are either foundational
   (Codeforces does not tag `variables_and_types`) or simply absent from the corpus.
   Foundational concepts are reachable through the prerequisite DAG, which is
   what the `prereq_min_mastery` and `co_failure_rate` columns are for, but their mastery
   is **inferred, not measured**, and should not be presented otherwise.

3. **Learner histories are shallow.** Median 7 concepts and ~8 problems per learner,
   because most learners appear in exactly one contest. The Rasch ability estimate is
   correspondingly noisy per learner even though it is well determined in aggregate —
   this is why `l2_theta` is a real prior rather than a formality.

4. **`median_time_to_accept_s` is zero at the median.** This is correct, not a bug: it
   measures elapsed time from first attempt to acceptance, and a problem solved on the
   first submission has zero elapsed time by construction. It is not a measure of time
   spent thinking, and must not be described as one.

5. **The extreme IRT residuals are single-observation noise.** `irt_n_problems` has median
   1 and mean 2.28, and every one of the most negative residuals comes from a learner with
   exactly one problem in that concept — one failure on one easy problem produces a
   residual near −0.98 that looks like a catastrophic weakness and is not. Phase 3 must
   either weight the residual by `irt_n_problems` or gate on a minimum, or the ranker will
   chase noise. The column is emitted unfiltered on purpose so the caller decides, but
   using it raw would be a mistake.

6. **Evidence per problem is thin, and this is the limitation D-009 bought.** Closing the
   catalog gap cost depth: median observations per problem fell from **145 to 7**. The
   1,000 deep learners touch nearly every problem on Codeforces, but thinly. So
   `difficulty_beta` is trustworthy only where evidence is thick — external Spearman
   **0.4864** overall against **0.8730** at ≥1000 observations.

   This is the same failure mode as limitation 5, one level up: limitation 5 is thin
   evidence per *learner-concept*, this is thin evidence per *problem*. Both are gates the
   ranker must respect, and `difficulty_beta_se_analytic` is the column for this one. Note
   the trap in gating on it: `irt.py:288-293` records that thinly-observed problems are
   systematically the **hard** ones (contest positions E–H), so filtering the catalog on
   `n_observations` would quietly bias evaluation toward easy problems. Gate inside
   candidate generation, or pass the count to the model as a feature — do not filter the
   corpus.
