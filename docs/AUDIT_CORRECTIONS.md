# Corrections to `KNOWLEDGE_ARCHITECTURE.md` and the Revised Plan

**The Revised Plan says: "Where this document and the older specs disagree, this one wins, because
it was written against the code and they were not."** That reasoning is sound and it now applies to
*this* file: the plan and the audit beneath it describe a repository that has since moved on. Every
correction below was verified against the code on 2026-08-09, and each one changes what V0 and V1
are for.

This matters because the plan asks for **~200 authored items over four to eight weeks** on the
strength of premises that no longer hold. Three of them are wrong.

---

## C-1 — The concept cap is not 80

**Plan says:** *"`features/taxonomy.py` sets `MAX_CONCEPTS = 80` and the taxonomy holds exactly 80.
Adding one ML concept raises `TaxonomyError`. Raise the cap, and treat the current value as a bug."*

**Actually:** `features/taxonomy.py:37` reads `MIN_CONCEPTS, MAX_CONCEPTS = 40, 300`, and
`data/concepts.yaml` held **88** concepts before this session — already above the cap the plan says
is blocking. V0's first item was done before it was written down.

## C-2 — Test cases are already hidden

**Plan says:** *"All fifteen test cases are visible to the client → no held-out grading signal.
Every evaluation number and every reward signal in both specs is invalid until fixed."*

**Actually:**

- `apps/api/src/models/problem.py:143` — `TestCase.is_hidden` is a real column.
- `apps/api/scripts/interview_problems.py` sets it per case: a couple `False` as worked examples,
  the rest `True`. That is precisely the shape V0 asks for.
- `apps/api/src/routers/execution.py:72-77` — client-supplied `test_cases` was **removed**; a stale
  client sending them now gets a loud 422. The comment there records why: an empty list used to be
  graded as a pass, because `passed == len(test_cases)` is vacuously true.
- `execution.py:377` logs the hidden count per submission.
- No API response schema exposes test cases at all.

**Consequence:** the sentence *"no evaluation number and no reward signal from this platform means
anything"* no longer applies. It was true of an earlier state of the code.

## C-3 — ML content exists, and there is a lot of it

**Plan says:** *"Zero ML, DL, LLM, VLM, or CUDA content exists. Catalog is five easy DSA problems."*
This is the premise behind V1 being "the blocker" and behind the ~200-item estimate.

**Actually, 91 distinct authored items exist**, and they are ML, not DSA:

| source | items |
|---|---|
| `interview_problems.py` / `interview_content.py` | 38 (`iq-` prefixed) |
| `problem_content.py` | 8 |
| `problem_content_gpu.py` | 4 |
| `paper_content.py` | 3 |
| `merge_authored.py` | 1 |

Subjects, from the slugs: `flashattention`, `coalescing-transaction-count`, `kv-cache`,
`occupancy`, `arithmetic-intensity-roofline`, `activation-memory-budget`,
`attention-vs-ffn-crossover`, `vit`, `patch`-embedding, `modality`, `bpe`, `subword`, `logsumexp`,
`fp16`, `batchnorm`, `sgd`, `warmup`, `kl`, `pipeline`, `bias-variance-decomposition`,
`bayes-optimal-threshold`, `perplexity`, `eigenvalues`, `iou`, `resampling`.

That spans **all five** of V1's target areas — Python for ML, LLM architecture, VLM, CUDA and
kernels, ML systems design.

**Consequence:** V1's remaining authoring is roughly **110 items, not 200**, and the areas already
covered need auditing for depth rather than authoring from nothing.

---

## What is genuinely still missing

Verified, not assumed:

1. **`data/concepts.yaml` had no ML concepts** — the one audit finding that held. Fixed this
   session: 64 added across seven categories, 144 total, DAG acyclic, with seven prerequisite edges
   crossing back into the DSA foundations so course assembly can order a path from beginner to ML.
2. **Content is spread across five `*_content.py` scripts.** This is the duplication V1 says to
   collapse into one file per item behind a single loader. It is real, and it is why the item count
   was hard to establish — no single place knows how many problems exist.
3. **Nothing verifies coverage per area.** No test asserts the catalog spans the five areas at the
   volumes V1 targets, so drift is invisible.
4. **The taxonomy was untested** until this session, despite its own header claiming otherwise.

## How to avoid inheriting stale premises again

The audit was written once and then trusted. Three of its load-bearing claims decayed silently
because nothing re-checked them, and a four-to-eight-week plan was built on top.

**Make the claims executable.** A test that asserts "N problems exist, spanning these five areas,
with hidden cases present" fails when it stops being true, which is the only kind of documentation
that cannot go stale unnoticed. That is a few hours and it retires this entire class of error.
