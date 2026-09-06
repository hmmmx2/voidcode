# VoidCode AI — reproducibility entry points.
#
# Run these INSIDE WSL2 Ubuntu. The repository lives on /mnt/c so it stays editable
# from Windows, but the JDK, virtualenv and all data live on the WSL ext4 filesystem
# (spec §2.6). `make setup` puts them there.
#
#   cd /mnt/c/Users/User/Documents/DUNE\ project/voidcode_ai
#   make setup && make features
#
# Targets for phases that are not built yet fail loudly with the reason. They do not
# silently succeed — spec §0 rule 2 requires NOT MEASURED over a fabricated number.

SHELL := /bin/bash

# Embedded Derby is single-writer: two Spark sessions cannot hold the metastore at
# once, and `make -j` across the Hive targets fails with "Another instance of Derby
# may have already booted the database" — which reads like a Spark bug and is not.
.NOTPARALLEL:
VC_HOME ?= $(HOME)/.voidcode
ENV     := source $(VC_HOME)/env.sh &&
CORES   ?= $(shell nproc)

.PHONY: help setup taxonomy ingest features irt irt-tune phase2 clean-warehouse \
        bench-nccl bench-train bench-cloud build-dataset rank-eval sandbox-test \
        loadtest experiment fairness evals sql-models sql-test recalibrate recalibrate-kfold export-calibration

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n",$$1,$$2}'

# ── setup ───────────────────────────────────────────────────────────────────
setup: ## install JDK + venv + pyspark into $HOME (no root required)
	bash setup_wsl_env.sh

# ── phase 2 ─────────────────────────────────────────────────────────────────
taxonomy: ## validate the concept DAG and print its shape
	$(ENV) python -m features.taxonomy

ingest: ## fetch >1M Codeforces submissions into the bronze landing zone
	$(ENV) python -m features.ingest.codeforces_fetch \
	  --target-rows 1200000 --max-pages 1 --max-contests 60

ingest-breadth: ## widen the catalog: many contests, few rows each (~13 min)
	$(ENV) python -m features.ingest.codeforces_fetch --mode contest \
	  --max-contests 300 --max-pages 1 --rows-per-contest 2000 \
	  --target-rows 100000000

ingest-depth-pilot: ## deepen 1000 learner histories, then MEASURE before scaling (~42 min)
	$(ENV) python -m features.ingest.codeforces_fetch --mode user --handles 1000

ingest-depth: ## deepen to HANDLES learners (set HANDLES=5000); resumable
	$(ENV) python -m features.ingest.codeforces_fetch --mode user \
	  --handles $${HANDLES:-5000}

export-taxonomy: ## materialise data/concepts.yaml as gold_concepts + prereq edges
	$(ENV) python -m features.spark_jobs.export_taxonomy

features: export-taxonomy ## Spark: bronze -> silver -> gold mastery vectors
	$(ENV) python -m features.spark_jobs.build_features --cores $(CORES)

features-train: ## rebuild features from PRE-CUTOFF data only (Phase 3 leakage fix)
	@test -n "$$CUTOFF" || { echo "set CUTOFF=<epoch seconds>; see ranking/split.py"; exit 1; }
	$(ENV) python -m features.spark_jobs.build_features --cores $(CORES) \
	  --max-created-at $$CUTOFF --out $${VC_WAREHOUSE_TRAIN:-$(HOME)/voidcode-data/warehouse_train}

irt: ## fit the Rasch model and emit per-concept residuals
	$(ENV) python -m features.irt

irt-tune: ## sweep Rasch hyperparameters on held-out log loss
	$(ENV) python -m features.irt_tune

phase2: taxonomy ingest features irt ## the whole Phase 2 pipeline, end to end

clean-warehouse: ## drop derived data, keep the bronze landing zone
	rm -rf $${VC_DATA:-$(HOME)/voidcode-data}/warehouse

# ── SQL / Hive layer (spec §4.1a) ───────────────────────────────────────────
hive-register: ## register the Parquet warehouse as external Hive tables
	$(ENV) python -m sql.register_tables --cores $(CORES)

sql-models: ## run the six analytical models and print their shape (spec 4.1a)
	$(ENV) python -m sql.run_models --cores $(CORES)

sql-test: ## run the models, then the sql/tests assertions over them (spec 4.1a)
	$(ENV) python -m sql.run_models --test --quiet --cores $(CORES)

# ── phase 1 — training spec property, see docs/OPEN_QUESTIONS.md Q-011 ──────
bench-nccl: ## BLOCKED: needs 2 GPUs; this machine has 1
	@echo "BLOCKED: all_reduce_perf -g 2 requires two CUDA devices."
	@echo "Measured on this host: 1x RTX 5060 Ti (15.93 GiB). See docs/DECISIONS.md D-002."
	@exit 1

bench-train: ## BLOCKED: full-parameter 7.6B does not fit on 15.93 GiB
	@echo "BLOCKED: see docs/OPEN_QUESTIONS.md Q-001. Phase 1 moves to rented cloud GPUs."
	@exit 1

bench-cloud: ## Route C scaling curve on rented Linux — not yet provisioned
	@echo "NOT RUN: cloud instance not provisioned. Budget ceiling still unanswered (Q-008)."
	@exit 1

build-dataset: ## Phase 1 instruction dataset — not built (Phase 1 blocked)
	@echo "NOT BUILT: Phase 1 is blocked on Q-001."
	@exit 1

# ── phases 3-4 — built and measured ─────────────────────────────────────────
#
# These were a single `exit 1` stub reading "belongs to a phase that has not started".
# That block outlived its truth: docs/METRICS.md cites these commands as the way to
# reproduce numbers already in the ledger, and a ledger whose commands do not exist is
# the same "written but never run" failure this project keeps finding. Every target
# below runs and every one produced a row in METRICS.md.

rank-eval: ## LambdaMART vs difficulty and popularity baselines (spec 5.2)
	$(ENV) python -m ranking.eval --learners 120

sandbox-test: ## adversarial probes against the live Judge0 (spec 6.1, MANDATORY)
	$(ENV) python -m sandbox.adversarial

loadtest: ## read-path latency and throughput against a running API (spec 6.2)
	$(ENV) python deploy/loadtest.py --users 100 --seconds 30

experiment: ## bucketing, sequential testing, guardrails, interleaving (spec 7.1)
	$(ENV) python -m experiments.run

fairness: ## NDCG@10 per segment and per history depth; flags >15% below mean (spec 8.3)
	$(ENV) python -m ranking.fairness --learners $${FAIRNESS_LEARNERS:-700}

data-quality: ## pandera contracts over the gold tables (spec 8.1)
	$(ENV) python -m quality.contracts

evals: ## score the tutor across all five gold modes (V6). --score for offline, no GPU
	$(ENV) python scripts/run_evals.py $${EVAL_ARGS:---score llm/data/eval_responses.json}

calibration: ## is sigmoid(theta - beta) actually a probability? (spec 4.3b)
	$(ENV) python -m analysis.calibration

recalibrate: ## isotonic/Platt correction on a three-way split (spec 4.3b)
	$(ENV) python -m analysis.recalibrate

recalibrate-kfold: ## the same, out-of-fold over ALL rows -- the honest curve (spec 4.3b)
	$(ENV) python -m analysis.recalibrate_kfold --folds 5

export-calibration: ## freeze the isotonic map into apps/api/data for the API to load
	$(ENV) python -m features.export_calibration --write

bootstrap: ## cluster-bootstrap SEs for problem difficulty (spec 4.3b)
	$(ENV) python -m features.irt_bootstrap --replicates 200

segment: ## k-means + GMM learner segments with ARI stability (spec 4.3a)
	$(ENV) python -m features.segment

mine: ## concept co-failure association rules (spec 4.3a)
	$(ENV) python -m features.mine --write-review

course: ## assemble a prerequisite-ordered course for one learner (spec 5.3)
	@test -n "$$USER_ID" || { echo "set USER_ID=<platform user uuid>"; exit 1; }
	$(ENV) python -m ranking.course_builder --user $$USER_ID

backfill-catalog: ## recover the 906 problems problemset.problems never returned
	$(ENV) python -m features.backfill_catalog --write

# ── the NOT BUILT stubs are gone ────────────────────────────────────────────
#
# This section held failing stubs for `experiment` and `fairness`. Both are built and both produce
# rows in docs/METRICS.md, so the stubs went with them.
#
# Removing one of these is a two-step edit and the first attempt got it wrong BOTH times: adding the
# real target while leaving the stub in place gives make a DUPLICATE target, and the later
# definition silently wins. The symptom is a target that still prints NOT IMPLEMENTED after you
# just implemented it. `grep -c '^name:' Makefile` should return 1 for every target here.
#
# The remaining `exit 1` targets above (bench-nccl, bench-train, bench-cloud, build-dataset) are
# hardware-blocked rather than unbuilt, and they stay: a target that prints nothing and exits 0
# reads as a feature that works.

# ══════════════════════════════════════════════════════════════════════════════
# RL TRAINING STACK (merged from voidcode-training during consolidation)
#
# Every target here is prefixed `rl-`. That is not decoration: the two Makefiles
# both defined `help` and `bench-nccl`, and this file's own warning above is that
# a duplicate target makes the LATER definition silently win. The prefix makes a
# collision impossible rather than unlikely.
#
# These do NOT need the Spark/JDK env from `make setup`, so they call $(PY)
# directly rather than going through $(ENV).
# ══════════════════════════════════════════════════════════════════════════════

PY ?= python
BASE_MODEL ?= Qwen/Qwen2.5-Coder-1.5B-Instruct
EVAL_GROUP ?= 8

.PHONY: rl-test rl-mutate rl-faulttest rl-probe rl-eval rl-kernel-bench \
        rl-fp8-bench rl-bench-parallel rl-bench-scaling

# ── built ───────────────────────────────────────────────────────────────────
rl-test: ## RL stack test suite (CPU only, no GPU needed)
	$(PY) -m pytest tests/ -q -k "grpo or ppo or by_tests or limits or faulttol or packing or kernels or rmsnorm or differential or platform_probe"

rl-mutate: ## break the grader on purpose; 10/10 mutants must be killed
	$(PY) tests/mutate_grader.py

rl-faulttest: ## kill a training process mid-run; the resumed curve must match
	$(PY) -m training.faulttol.kill_test

# SPEC is required rather than defaulted, because every number this emits is only
# interpretable against the pod that produced it — Community and Secure Cloud
# report the same device name to nvidia-smi.
rl-probe: ## P0 platform probe. SPEC=a40_x2_secure make rl-probe
	@if [ "$(SPEC)" = "UNSET" ] || [ -z "$(SPEC)" ]; then \
	  echo "SPEC is required, e.g.  SPEC=a40_x2_community make rl-probe"; \
	  echo "It is recorded with the numbers; Community and Secure look identical to nvidia-smi."; \
	  exit 2; \
	fi
	$(PY) -m training.platform_probe --spec $(SPEC) --out docs/rl/probe-$(SPEC).json --nccl-tests $${NCCL_TESTS:-./nccl-tests}

# ── not built (each exits non-zero and names the phase that owns it) ─────────
rl-bench-parallel: ## NOT BUILT: P2b — needs a40 x2 and the route chosen from P0's busbw
	@echo "NOT BUILT: P2b. Needs a40 x2 and the route chosen from P0's busbw."; exit 1

rl-bench-scaling: ## NOT BUILT: P2c — a curve needs three points, so needs a40 x4
	@echo "NOT BUILT: P2c. Needs a40 x4 — a curve needs three points."; exit 1

rl-eval: ## P3 held-out pass@1, base vs post-RL. POLICY=<dir> adds the post-RL arm
	$(PY) scripts/rl_eval.py --eval-set data/catalogue.json --arm base=$(BASE_MODEL) $(if $(POLICY),--arm post=$(POLICY),) --group $(EVAL_GROUP) --out docs/rl/rl-eval$(if $(POLICY),,-base-only).json
	@if [ -z "$(POLICY)" ]; then echo ""; echo "NOTE: base arm only. Pass POLICY=<dir> for the post-RL arm, e.g. make rl-eval POLICY=/workspace/policy-step200"; echo "A post-RL checkpoint requires train_grpo.py to have been run with --save-to."; fi

rl-kernel-bench: ## NOT BUILT: P4a
	@echo "NOT BUILT: P4a."; exit 1

rl-fp8-bench: ## NOT BUILT: P4b — requires Ada or Blackwell; the A40 is Ampere (cc 8.6)
	@echo "NOT BUILT: P4b. Requires Ada or Blackwell — runs on the LOCAL card; the A40 is Ampere (cc 8.6)."; exit 1
