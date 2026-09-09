# Two specs that describe a different branch

`VOIDCODE_PLATFORM_SPEC.md` and `VOIDCODE_TRAINING_SPEC.md`, and the `VoidCode AI — Revised Plan`
(phases V0–V6) written against them, do not describe this application. This document says what
happened to each of their phases, so the comparison does not have to be re-derived by audit. It has
been re-derived three times.

**No counts appear below.** `desktop/tests/content-census.test.ts` is the one place content counts
live, and it fails when they change. Prose restating a number the code owns is the specific failure
that made several of the corrections in this document necessary.

## The structural fact

The specs live on branch **`feat/voidcode-platform`**. `git merge-base feat/voidcode-platform HEAD`
resolves to the **initial commit** — the two lines of history share nothing else.

```
fd46035 (initial commit)
├── feat/voidcode-platform   apps/ llm/ features/ sql/ ranking/ train/ Makefile docker-compose
└── … HEAD                   desktop/  (Electron + Next static export)
```

So nothing here was deleted or abandoned mid-flight. HEAD forked before that work existed, and the
two never merged. The specs, and `docs/KNOWLEDGE_ARCHITECTURE.md` which they cite, exist only on that
branch.

That also means the Revised Plan's opening findings — a catalogue of five easy DSA problems, a
taxonomy at a hard cap, all test cases visible to the client — are observations about **that** branch.
None of them describes this one.

## Training spec: not implemented here

| Spec deliverable | State |
|---|---|
| `training/parallel|faulttol|numerics|kernels|precision|moe|multimodal/`, `rl/`, `configs/ds_zero2.json`, root `Makefile` | Absent — no such directories |
| `docs/TRAINING_METRICS.md`, `RL_FINDINGS.md`, `REPRODUCTIONS.md`, `CONTRIBUTIONS.md` | Absent |
| DeepSpeed, TorchTitan, `torchrun`, DTensor, GRPO, PPO, Triton, TransformerEngine, FP8, NCCL, SigLIP | Absent from code |

Two qualifications worth stating, because a keyword search alone would mislead:

**There is ML-adjacent Python, and it is not a trainer.** `scripts/memory_audit/` imports torch,
peft, bitsandbytes and galore. Its own report is explicit about what it is —
`docs/MEMORY_AUDIT.md`: *"a memory instrument, not a trainer — it has no data loading, checkpointing,
evaluation, or LR schedule."* It is a completed VRAM-feasibility study, and it stands on its own.

**Where the spec's vocabulary does appear, it is the product working.** `desktop/src/main/content/interview-bank.ts`
contains model answers about ZeRO-2 versus ZeRO-3 sharding. That is an interview-prep app teaching
distributed training, not a partial implementation of it. Grepping for `ZeRO` and concluding
otherwise is the mistake this paragraph exists to prevent.

For what became of the fine-tune the spec was written to produce, see *"The fine-tune finished;
nothing downstream of it survives"* in `desktop/docs/DECISIONS.md`.

## Platform spec: not implemented here

No `.sql`, `.yaml`, `.R` or `Makefile` exists in the tree. Absent from code: pyspark, `SparkSession`,
Parquet, Delta, Hive, metastore, LightGBM, LambdaMART, NDCG, FP-Growth, k-means, silhouette, gVisor,
Kata, seccomp, Kubernetes, Helm, KEDA, Prometheus, Grafana, Great Expectations, Pandera, Thompson
sampling, CodeNet, pgvector. Along with every document it names — `METRICS.md`, `BULLETS.md`,
`DESIGN.md`, `RANKING_DESIGN.md`, `RISK_REGISTER.md`, `MODEL_CARD.md`, `STAKEHOLDER_BRIEF.md`,
`ARCHITECTURE.md`, `DATA_SOURCES.md`.

Postgres is not merely absent but explicitly rejected: `docs/desktop-app-spec.md` records that
*"FastAPI/Postgres/Judge0 are dropped rather than bundled"*, and `desktop/renderer/src/lib/api/client.ts`
carries the reasoning — bundling that stack meant roughly a 3 GB installer plus two database servers
to run an offline application.

## The Revised Plan, phase by phase

### V0 — two premises are wrong, one item is done thoroughly, one was outstanding

**"Raise the concept cap from 80."** There is no 80. `desktop/src/main/content/taxonomy.ts` sets
`MAX_CONCEPTS` to a ceiling far above any hand-authored taxonomy, and its comment is clear that this
is a corruption check — *"a truncated or half-written file is the thing they catch"* — not a quality
bar. On the platform branch, `features/taxonomy.py` reads `MIN_CONCEPTS, MAX_CONCEPTS = 40, 300`. **80
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

**"Commit the specs."** Not done here, and this document is the deliberate alternative. Committing
them verbatim would add two documents asserting a plan the code contradicts, which is the failure
mode the whole D9 pass was spent undoing. They remain on `feat/voidcode-platform`.

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

There is no Pydantic field to unblock, because there is no Python API. The narrowing was in the
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

### V6 — training and RL: not implemented

See the training spec section. Its stated prerequisites are also not met on this branch, and one of
them is now answered in the negative.

## What this means

The specs are not a backlog. Where they describe infrastructure this application does not need — a
Spark pipeline for one local user, a learned ranker with no cross-user data, a GPU sandbox for
content graded by numerical comparison — they were superseded by decisions recorded at the files that
made them. Where they describe something real, it either shipped in a different form or is recorded
as a gap in `desktop/docs/DECISIONS.md`.

The work on `feat/voidcode-platform` is not deleted and is not worthless. It is a separate line of
history, and the honest description of it is portfolio work rather than a component of this product.
