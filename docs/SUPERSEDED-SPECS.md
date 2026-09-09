# Two specs, and what became of each phase

`VOIDCODE_PLATFORM_SPEC.md` and `VOIDCODE_TRAINING_SPEC.md`, and the `VoidCode AI - Revised Plan`
(phases V0-V6) written against them, do not describe the **desktop application**. This document says
what happened to each of their phases, so the comparison does not have to be re-derived by audit. It
has been re-derived three times.

**No counts appear below.** `desktop/tests/content-census.test.ts` is the one place content counts
live, and it fails when they change. Prose restating a number the code owns is the specific failure
that made several of the corrections in this document necessary.

## The structural fact — REWRITTEN AFTER THE CONSOLIDATION

**This section used to say the opposite, and the change is the point.** It read: the specs live on
branch `feat/voidcode-platform`, `git merge-base` resolves to the initial commit, and the two lines
of history share nothing else — so nothing here was abandoned mid-flight, because HEAD forked before
that work existed.

That was true of the desktop-only repository. It is not true of this one. This tree is the
consolidation of both codebases: the platform half brought `apps/`, `features/`, `ranking/`, `sql/`,
`llm/` and a root `Makefile`; the RL half brought `rl/`, `reward/` and `training/`. The specs
themselves are committed here, at `docs/specs/VOIDCODE_PLATFORM_SPEC.md` and
`docs/specs/VOIDCODE_TRAINING_SPEC.md`.

So the question this document answers has changed shape. It is no longer "was any of this built?"
but "was it built **in the desktop application**?" — and for almost everything below the answer is
still no, for reasons that are decisions rather than gaps. The desktop app and the platform are two
programs in one repository, not one program half-finished.

Read the phase sections with that distinction in mind: *absent from `desktop/`* is the claim being
made, and it is a different claim from *absent from the repository*.

## Training spec: implemented, and not by the desktop app

| Spec deliverable | Where it is |
|---|---|
| `training/`, `rl/`, `reward/` | **Present**, from the RL half. GRPO ran; `docs/rl/RESULT.md` reports what it measured and `docs/rl/METRICS.md` is the ledger |
| root `Makefile`, `configs/ds_zero2.json` | `Makefile` present; no DeepSpeed config — that path was never taken |
| DeepSpeed, TorchTitan, DTensor, TransformerEngine, FP8, NCCL, SigLIP | Absent from code. GRPO and Triton are present; the rest of the spec's stack is not |
| Any of it inside `desktop/` | **Absent, and deliberately so** — the desktop app ships no trainer |

Two qualifications worth stating, because a keyword search alone would mislead:

**There is ML-adjacent Python in `scripts/`, and it is not a trainer.** `scripts/memory_audit/`
imports torch, peft, bitsandbytes and galore. Its own report is explicit about what it is —
`docs/MEMORY_AUDIT.md`: *"a memory instrument, not a trainer — it has no data loading, checkpointing,
evaluation, or LR schedule."* It is a completed VRAM-feasibility study, and it stands on its own.

**Where the spec's vocabulary appears inside `desktop/`, it is the product working.**
`desktop/src/main/content/interview-bank.ts` contains model answers about ZeRO-2 versus ZeRO-3
sharding. That is an interview-prep app teaching distributed training, not a partial implementation
of it. Grepping for `ZeRO` and concluding otherwise is the mistake this paragraph exists to prevent.

For what became of the fine-tune the spec was written to produce, see *"The fine-tune finished;
nothing downstream of it survives"* in `desktop/docs/DECISIONS.md`.

## Platform spec: partly implemented, in the platform half

`features/`, `ranking/`, `sql/` and the documents the spec names — `docs/METRICS.md`,
`docs/DESIGN.md`, `docs/RANKING_DESIGN.md`, `docs/KNOWLEDGE_ARCHITECTURE.md`, `docs/DATA_SOURCES.md`
— are all present, from the platform half. A two-stage recommender exists there.

Still absent from the whole repository: pyspark, `SparkSession`, Parquet, Delta, Hive, metastore,
FP-Growth, gVisor, Kata, seccomp, Kubernetes, Helm, KEDA, Prometheus, Grafana, Great Expectations,
Pandera, Thompson sampling, CodeNet, pgvector — along with `docs/RISK_REGISTER.md`, and a `serving/`
or `configs/` directory.

**Absent from `desktop/`, which is the claim this document is really making:** all of it. The
desktop app has no Spark pipeline, no learned ranker, no Postgres. Postgres is not merely absent
there but explicitly rejected: `docs/desktop-app-spec.md` records that *"FastAPI/Postgres/Judge0 are
dropped rather than bundled"*, and `desktop/renderer/src/lib/api/client.ts` carries the reasoning —
bundling that stack meant roughly a 3 GB installer plus two database servers to run an offline
application. The platform half runs exactly that stack, on a server, which is why it can.

## The Revised Plan, phase by phase

### V0 — two premises are wrong, one item is done thoroughly, one was outstanding

**"Raise the concept cap from 80."** There is no 80. `desktop/src/main/content/taxonomy.ts` sets
`MAX_CONCEPTS` to a ceiling far above any hand-authored taxonomy, and its comment is clear that this
is a corruption check — *"a truncated or half-written file is the thing they catch"* — not a quality
bar. In the platform half, `features/taxonomy.py` reads `MIN_CONCEPTS, MAX_CONCEPTS = 40, 300`. **80
was never the value on either branch**, so this item has nothing to action.

**"Make test cases hidden."** Done, and in three independent layers rather than one:

- `desktop/src/main/content/problems.ts` — the catalogue projection drops the reference entirely and
  redacts `args` on hidden cases.
- `desktop/src/main/content/detail.ts` — the workspace payload omits hidden cases altogether and
  sends only a count. Its header: *"sending one would hand over the answer key to a client the user
  can read."* The interview path goes further and returns a null expected output for **every** case,
  visible ones included.
- `desktop/src/main/exec/grader.ts` — a hidden case returns pass/fail and timing, never expected or
  actual. Its comment: *"Leaking `expected` here would hand over the answer key one failing
  submission at a time."*

It is also policed structurally: `desktop/renderer/src/lib/curriculum.ts` and
`desktop/tests/curriculum-parity.test.ts` both state that the renderer must not import the real
catalogue, because that would pull hidden cases into the client bundle.

**"Commit the specs."** Now done, by the consolidation rather than by choice — they are at
`docs/specs/VOIDCODE_PLATFORM_SPEC.md` and `docs/specs/VOIDCODE_TRAINING_SPEC.md`. The original
objection stands and is why this document still exists: two committed documents asserting a plan the
desktop app contradicts is exactly the failure the D9 pass was spent undoing, and the only thing that
keeps them from reading as a backlog is a document saying what happened to each phase. That is this
one. Their own instruction text still points at `docs/OPEN_QUESTIONS.md`, which since the
consolidation is a different file — the spec-review questions moved to `docs/specs/OPEN_QUESTIONS.md`
and the spec bodies were left unedited rather than retouched.

**"Answer the artifact question."** Was outstanding; now recorded in `desktop/docs/DECISIONS.md`.

### V1 — content: done differently

Not one file per item. `desktop/src/main/content/` is a set of large authored literals, and
`concepts.ts` gives the reason: *"the content files are large authored literals where adding a field
to 52 entries is a wide diff for no behavioural gain."*

There *is* a single loader — `problems.ts` builds one map over both catalogues, and `getProblem` is
the one lookup. The catalogue query is deliberately separate so interview workspaces do not appear in
the syllabus.

The renderer does hold a mirror of the problem order, deliberately, for the bundle reason above — and
it is test-guarded because **it had already drifted twice**: once losing entries so the total read
low, once permuting them so a route opened the wrong problem. `curriculum-parity.test.ts` exists
because of those two incidents.

**One V1 criticism no longer applies.** Teaching templates are not compiled into the client bundle;
they are delivered at runtime in the problem payload (`detail.ts`).

### V2 — retrieval: done, lexical rather than vector

`desktop/src/main/content/reference-search.ts` — term overlap with IDF weighting and a concept-graph
boost. No pgvector, no Postgres, no embedding model.

The corpus satisfies what V2 actually asked for: every document carries a `source` and an `asOf` date,
and `reference.ts` is careful that the date is *"of the claim, not of the file"*. The tutor's answers
are grounded from it by `grounding.ts`, which injects rather than exposing a tool — because the tutor
surface binds zero tools, and that is load-bearing.

The reason for rejecting embeddings is recorded at the file that made the call: the corpus is small
enough that lexical scoring suffices, and routing grounding through a local embedding model would
make citations depend on a model the user may not have installed — failing silently when they do not.
`reference-search.ts` also names the condition under which that trade flips, and points at the
machinery already available for it.

### V3 — vision: done

There is no Pydantic field to unblock in the desktop app, because it has no Python API — the FastAPI
half in `apps/api` is a separate program the desktop does not call. The narrowing was in the
renderer, and `desktop/tests/tutor-images.test.ts` records it: *"`chat:open` has admitted image
blocks all along… the renderer was the single thing narrowing content to a string on the way
through."*

Media types are a closed union in `desktop/src/main/inference/types.ts`; per-provider shaping is in
`normalise.ts`; and `images.ts` validates magic bytes rather than trusting a declared type. The spec's
own advice was followed on the rest — no screenshot OCR, and image-derived content treated as
untrusted.

### V4 — ranking: done, and the spec's approach rejected by name

`desktop/src/main/content/selection.ts`: *"There is no learned ranker here and there should not be:
one user, no cross-user data, no IRT. More to the point, a score a learner cannot argue with is a
score they cannot act on."*

What ships instead is explainable priority bands where the reason produces the score, ordered by the
prerequisite graph's topological sort. No Spark, no IRT, no LambdaMART, no NDCG. The Revised Plan's
own analysis supports this: it identified that the Spark and IRT pipeline joined to no platform user
and that ranking was blocked on cold start, not on the ranker.

### V5 — GPU sandbox: descoped, exactly as the Revised Plan recommends

Submissions execute in Pyodide inside an Electron `utilityProcess`. `desktop/src/main/exec/sandbox.ts`
is precise about where the boundary is: *"What makes this a real sandbox is Pyodide, not this file:
WASM linear memory, no sockets, no host filesystem."* Its own process, so a hard timeout is a kill.

There is no CUDA execution path, and the import allowlist is honest about its own status —
`desktop/src/main/exec/runtime/bootstrap.py` calls it *"a pedagogical constraint, not a security
boundary."*

### V6 — training and RL: implemented in the RL half, absent from the desktop app

This section used to read "not implemented", which was true of the desktop-only repository and is
not true here. GRPO ran on a rented A40; `docs/rl/RESULT.md` states what it measured, including the
part that did not work — an in-domain gain that did not transfer. `rl/`, `reward/` and `training/`
are in this tree.

None of it is in `desktop/`, and none of it is reachable from the desktop app, which talks to a local
model through `desktop/src/main/inference/`. The two are connected by an artefact, not by code.

## What this means

The specs are not a backlog. Where they describe infrastructure this application does not need — a
Spark pipeline for one local user, a learned ranker with no cross-user data, a GPU sandbox for
content graded by numerical comparison — they were superseded by decisions recorded at the files that
made them. Where they describe something real, it either shipped in a different form or is recorded
as a gap in `desktop/docs/DECISIONS.md`.

The platform and RL work is not deleted and is not worthless — it is in this repository, it runs, and
`docs/rl/RESULT.md` reports what it produced. What it is not is part of the desktop application. One
tree holding two programs is the accurate description; a single product half-built is not.
