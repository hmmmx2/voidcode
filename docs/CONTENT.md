# Content — coverage, workflow, and what is verified

Every number here is computed from `content/problems/*.yaml` through `features/content.load_raw()`.
None of it is typed by hand, because the last three content figures that were typed by hand — "not
started", "the database holds 77", "all 15 test cases are visible" — were all wrong at the same time.

**Measured 2026-08-16. 200 items.**

---

## 1. What exists

| `source_kind` | count | graded by |
|---|---|---|
| `problem` | 119 | 87 by tests, 32 by rubric |
| `interview_problem` | 38 | tests |
| `interview_question` | 40 | model answer + red flags, no execution |
| `paper` | 3 | — |

**125 items are executable** (`reference_solution` + `test_cases` + `code_templates`), carrying
**699 test cases** — 421 hidden, 258 visible.

## 2. Coverage by area

An item may carry more than one category (66 do), so these sum to more than 200.

| area | items | ≥40 | easy | medium | hard | executable | rubric | prose |
|---|---|---|---|---|---|---|---|---|
| DL | 59 | **PASS** | 9 | 37 | 13 | 41 | 0 | 18 |
| LLM | 58 | **PASS** | 7 | 38 | 13 | 38 | 4 | 16 |
| CUDA | 44 | **PASS** | 4 | 19 | 21 | 20 | 11 | 13 |
| ML | 39 | **FAIL** by 1 | 4 | 23 | 12 | 27 | 2 | 10 |
| Systems | 35 | **FAIL** | **0** | 26 | 9 | 22 | 13 | 0 |
| VLM | 24 | **FAIL** | 2 | 12 | 10 | 9 | 9 | 6 |

`PyTorch` (10) and `TensorFlow` (2) are cross-cutting tags, not advertised areas, and are not gated.

**A count is not coverage.** CUDA clears 40 and is hard-heavy (21 hard against 4 easy); Systems
clears neither the count nor the difficulty spread, having **no easy items at all**. A learner
entering Systems meets a medium problem as their first contact with the area.

## 3. Coverage by concept

The join that ranking, prerequisites and course assembly actually read.

| | ML-side concepts (65) |
|---|---|
| carrying ≥2 items | **53** |
| carrying exactly 1 | **12** |
| carrying none | **0** |

The twelve on one item — the precise authoring backlog for the ≥2 rule:

`activations` · `attention_masking` · `convolutions` · `einsum_notation` · `gradient_clipping` ·
`initialization` · `moe_routing` · `rlhf_grpo` · `tensor_parallel` · `transformer_block` ·
`triton_basics` · `zero_sharding`

**79 of the 80 DSA-side concepts carry zero items**, and that is expected rather than a gap: the
taxonomy kept its classical-algorithms half when the curriculum became ML. They are not advertised
and are not gated. If they are never going to be authored against, they should be removed from
`data/concepts.yaml` rather than left looking like a 40% coverage hole.

## 4. What is verified, and what is not

| check | scope | where |
|---|---|---|
| Every reference solution reproduces its expected outputs | **125 items, 699 cases** | CI, `ml-tree` job |
| The shipped catalogue satisfies the loader contract | 200 items | CI, `ml-tree` job |
| Concept ids resolve; prerequisite graph is acyclic | 145 concepts | CI, `python -m features.taxonomy` |
| No banned import reaches Judge0 | all executable fields | `features/content.py`, at load |
| No hidden `expected_output` in client-side content | slug-keyed web content | `tests/test_catalog_coverage.py` |

**Not verified, and the honest list matters more than the verified one:**

- **Reference solutions run on the local interpreter, not in Judge0.** The sandbox needs a live
  service (`sandbox/adversarial.py`, `make sandbox-test`). The banned-imports rule exists precisely
  because the local runner is more permissive than the grader.
- **Rubric items (32) have no automatic verification at all.** Weights summing to 1.0 is checked;
  whether a criterion is *correct* is not.
- **`interview_question` model answers (40) are unverified prose.**
- **94 items carry `review_needed: true`, and 91 carry `inferred_concepts: true`.** Concept tags were
  machine-inferred and flagged for a review that has not happened. Every figure in §3 inherits that
  uncertainty — a concept "carrying two items" may be carrying two mis-tagged ones.
- **Mutation testing covers one item.** `scripts/authoring/mutation_check.py` is hardcoded to
  `clip-contrastive-loss`. Verification proves the expected outputs follow from the reference; only
  mutation testing shows a wrong solution would actually fail.

## 5. Authoring workflow

Two writers exist. **Prefer `scripts/authoring/build_item.py`**: it computes expected values by
executing the reference, requires declared mutants to fail, and requires at least one independently
derived check value. `scripts/new_item.py` scaffolds without any of that.

Rules, in the order they bite:

1. **The reference solution executes and reproduces every expected output.** CI, not review.
2. **Standard library only.** Judge0's `python:3` image ships nothing else; enforced at load.
3. **At least one hidden case**, or there is no held-out grading signal for that item.
4. **Concept ids must resolve** against `data/concepts.yaml`, at most 4 per item. A typo silently
   drops the item out of ranking and course assembly.
5. **Hidden values never appear in client-side content.** The API filters and redacts them; the
   bundle does not, and one hidden answer reached a browser this way.
6. **Author the hints with the question, never afterwards.** A ladder written later drifts toward
   describing the solution the author already has in mind.

## 6. Open: the marketing demo describes a workspace that does not exist

`components/marketing/demo/demo-content.ts` and `demo-script.ts` author a scripted tutor session for
"Scaled Dot-Product Attention". The catalogue contains that problem —
`content/problems/scaled-dot-product-attention.yaml`, `order_index: 5` — and the two disagree on
every field that matters:

| | the demo | the real item |
|---|---|---|
| signature | `scaled_dot_product_attention(Q, K, V, mask=None) -> Tensor` | `Solution.attention(self, Q, K, V, causal)` |
| shapes | torch tensors `(batch, heads, seq, d_k)` | 2-D Python lists |
| masking | optional additive `mask` | boolean `causal` flag |
| constraints | "No `torch.nn.functional.scaled_dot_product_attention`" | "Standard library only — no numpy, no torch" |
| tests | shape `(2,8,16,64)`, rows sum to 1 | three numeric cases, e.g. `[[1.660477, 2.660477]]` |

A visitor who signs up after the demo meets a different product. `FeatureRows.tsx` then re-forks the
demo's tutor message and the two copies have already drifted from each other — same
`tokenCount: 331`, three textual differences.

Fixing it is a design change to the marketing page, not a copy edit, so the files now carry an
accurate note instead of the expired one that claimed the catalogue had no ML content.

**Already fixed:** the same section promised "four languages". All 125 executable items ship exactly
one Python template, `verify_problems.py` fails an item that ships anything else, and the workspace's
language dropdown derives from the fetched templates — so it has only ever offered Python.

## 7. The hint ladder

Rungs 0 and 1 are validated at load by `features/ladder.py`; an item whose early rungs contain the
fix does not load. This is the mechanism the disclosure gate needs, moved to authoring time — the
tutor selects a rung instead of composing one.

**96 of 119 migrated. 23 refused and left unchanged, each with the span that failed.** Rung 3 is
deliberately unauthored: it is the fix, and writing 119 of those is authoring rather than migration.
An absent rung is not a violation.

| | |
|---|---|
| items with a validated ladder | **96** |
| refused, need rung 0 or 1 rewritten by hand | **23** |
| carrying `hints: []` or no hints at all | 81 |

The refusals are the answer one rung too early:

- `"Rounding up on each axis is (n + tile - 1) // tile, not n // tile."` — rung 1
- `"cos = dot(a,b) / (|a| * |b|)."` — rung 0
- `"log_softmax(x)_i = x_i - max - log(sum(exp(x_j - max)))."` — rung 0

`hints` and `hint_ladder` may not disagree, enforced at load. `hints` is the ORM column the API
serves and the ladder is loader-only, so nothing downstream would notice them diverging — the
learner would read one while the tutor selected from the other.

> **Two things about the count, both worth knowing before quoting it.**
>
> The eval harness's `disclosure_level` **cannot** be reused here. Run over the same 119 it passes
> all of them and scores 118 at level 0 — it looks for line references and "your loop bound"
> phrasing, which is what a debug reply about submitted code contains and a conceptual hint never
> does. It would have shipped as "validated".
>
> The pass count moved every time the validator was fixed: **97 → 100 → 99 → 96**. Two defects were
> found by tests rather than by reading the patterns — a decimal at the end of a sentence was not a
> literal, and only zero-argument calls counted as code, so `"Subtract max(logits) instead of the
> raw value"` passed as a rung 0. A count taken before a validator stops having bugs measures the
> validator.
