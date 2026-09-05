# Ranking design

Required by spec §5.2, which asks for the label definition to be justified in writing. Most of this
already existed as the module docstring of `features/ranking.py`; it is lifted here rather than
rewritten, so there is one account and not two that can drift.

---

## The fact that shapes everything else: two disjoint data worlds

| | World A — research corpus | World B — the product |
|---|---|---|
| Store | `$VC_DATA/warehouse` (Parquet + Hive) | Postgres + `content/problems/*.yaml` |
| Scale | 2,296,409 rows, 11,284 problems, 117,453 learners | 123 problems, 9 users, 2 submissions |
| Concepts | 67 of the 80 **classic DSA** concepts | exactly the 64 **ML** concepts |

**The two concept sets are perfectly disjoint.** 80 concepts have zero platform problems, and only 7
of 203 prerequisite edges cross between the branches. A model fitted on World A has never seen a
feature value a World B problem can produce, so there is no transfer between them. This is a
constraint to plan around, not a bug to fix.

The consequence, stated once so it does not have to be re-argued:

- Every §5.2 acceptance number — NDCG, Recall@100, beats-two-baselines — is a **World A** result and
  must be labelled as an offline corpus measurement.
- Every §5.3 and §7 *product* number is **World B**, where 9 users and 2 submissions make honest
  measurement impossible.

Closing that gap is a content problem, not a modelling one: it needs ML learner telemetry at corpus
scale. No quantity of Codeforces data helps rank the 123 ML problems.

---

## The label definition is the modelling decision, not the model

An interviewer will ask why a first-attempt pass is *not* the top grade, so the reasoning is here:

| Grade | Condition | Reading |
|---|---|---|
| 3 | attempted and eventually passed after **≥ 2** attempts | productive struggle |
| 2 | passed on the first attempt | already knew it |
| 1 | attempted and abandoned | too hard, or badly presented |
| 0 | never attempted | no signal |

A problem the learner solved immediately taught them little — recommending more like it is
comfortable and useless. A problem they abandoned was probably beyond them. **The one that moved them
is the one they had to fight for**, which is why grade 3 sits above grade 2 and not below it.

**The risk this carries, and it should be stated:** optimising for struggle can drift toward
recommending problems that are merely frustrating. Grade 1 exists to separate the two — abandoned is
scored *below* an easy pass, so the objective cannot reach grade 3 simply by getting harder.

`tests/test_ranking.py` pins both orderings, because either one inverting is a silent change in what
every learner sees.

---

## Why the split must be temporal

A random split lets the model see a learner's later submissions while predicting their earlier ones,
which is future information about the same person. Every metric produced that way is inflated,
plausible, and nothing downstream reveals it.

`assert_no_leakage` therefore **raises** rather than warns, and there is a test that hands it a
deliberately shuffled split and requires the failure. `ranking/split.py` builds a separate
`warehouse_train/` from pre-cutoff data only, so features cannot accidentally be computed over the
evaluation period.

---

## Two feature decisions worth defending

**`mastery_known` is a separate column from `mastery`.** Encoding "never attempted" as `0.0` makes it
identical to "attempted and always failed" — opposite situations, one wanting introduction and the
other remediation. A single column cannot say which, so the model would learn whichever is commoner
in training.

**Evidence density is a feature, not a filter.** `irt_n_problems` and `n_observations` belong in the
feature vector rather than as a threshold on the training set. `docs/METRICS.md` limitation 6 records
why: thinly-observed problems are systematically the *hard* ones, so filtering on observation count
biases evaluation toward easy problems and flatters every number computed afterwards.

---

## NDCG@k returns 0.0, not 1.0, for an all-irrelevant list

A ranker that surfaces nothing useful has not scored perfectly. Returning 1.0 — which is what
dividing by an ideal DCG of zero invites — would let a model that only ever surfaces zero-grade
problems average well across learners.

---

## The two guards that must not be weakened

**`train_ranker` returns `None` below two learners or ten examples.** On this platform's real data it
does exactly that. Returning a model there would produce confident scores from nothing.

**`recommend` labels its output `ranked_by="mastery"` when no model ranked it.** Both paths return a
well-formed, plausible list and are indistinguishable at the API boundary; without the label, a
heuristic served as a model's output is a personalisation claim nobody measured.

Weakening either to produce a number is the failure the metrics ledger exists to prevent. The field
travels through the API and into the UI copy, so the product cannot claim personalisation it does not
have.

---

## What the model is actually doing

`docs/RANKING_ANALYSIS.md` ablates every feature and measures how much of a learner's list is theirs
alone. Two results that change what may be claimed:

- **`catalog_popularity` is load-bearing.** Removing it collapses NDCG@10 from 0.2584 to 0.0367.
  Alone it scores 0.0611 — the baseline — so the result is an interaction, not one feature.
- **45% of any learner's top-10 is shared with any other learner.** No two learners get an identical
  list, but 48 problems serve 40 learners' top-10s. "Recommended for you" is defensible;
  "personalised learning path" overstates a list that is nearly half common core.

## What has not been measured

`make rank-eval` exits non-zero and that is honest. In order:

1. **`eval_cohort_size` is 20,537 learners** — measured, and it settles a planning question.

   `ranking/split.py` defines the cohort as learners with ≥ 3 pre-cutoff *and* ≥ 3 post-cutoff
   problems. The cutoff falls at the 80th percentile of first-attempt time (2026-07-15), giving
   1,056,303 training pairs and 264,079 evaluation pairs, with a median of 6 post-cutoff problems per
   cohort learner.

   The concern was that this might come back in the hundreds, in which case every NDCG would need
   bootstrap confidence intervals over learners rather than a point estimate. At 20,537 a point
   estimate is defensible — the standard error on a per-learner mean over that many learners is
   small. **Report CIs anyway** where a comparison is close: the cost is a few seconds of resampling,
   and the difference between "beats the baseline" and "beats the baseline by more than noise" is the
   whole claim.

   Note this cohort is **World A only**. It says nothing about the product's 9 users.
2. **Baselines and NDCG@5 now exist** — `ranking/eval.py`. Measured, 60 learners against the full
   11,272-problem catalogue:

   | ranker | NDCG@5 | NDCG@10 | 95% CI | Recall@100 |
   |---|---|---|---|---|
   | LambdaMART | 0.0060 | **0.0059** | [0.0011, 0.0112] | 0.124 |
   | difficulty-sorted | 0.0000 | 0.0000 | — | 0.009 |
   | difficulty-sorted, well-observed | 0.0000 | 0.0000 | — | 0.026 |
   | popularity | 0.1647 | **0.1757** | [0.1346, 0.2194] | 0.715 |

3. **§5.4 IS NOT MET: the model loses to the popularity baseline by 30×.** Reported as measured. This
   document predicted the possibility before the harness existed, and the prediction is the reason
   the result is trustworthy — nothing was tuned after seeing it.

   **The reason is diagnosable, and it is the missing feature.** Popularity predicts what a learner
   attempts next extremely well on this corpus, measured:

   - Spearman(pre-cutoff `n_observations`, post-cutoff engagements) = **0.606**
   - the 100 most-observed problems absorb **56.7%** of all post-cutoff engagement

   The baseline is made entirely of that signal. The model does not have it: §5.2 names recency and
   catalogue popularity as features and neither is in the nine. So this is not "LambdaMART is
   unsuitable" — it is a model competing against a signal it was never given.

   Adding those two features is the next step, and it now has evidence behind it rather than being a
   checklist item. What it must **not** become is a search for a configuration that wins.

4. **The difficulty baselines score exactly zero, and that is a finding about the IRT fit.** The ten
   lowest-beta problems have 1-7 observations each against a catalogue median of 7 — a problem solved
   by one person gets an extreme easy beta because the fit has almost no evidence. Restricting to
   well-observed problems triples Recall@100 (0.009 → 0.026) and still leaves NDCG at zero. Sorting
   ascending by β ranks by estimation artefact at the top of the list.

5. **A stable sort inflated the first result by 94%.** See `docs/METRICS.md`. `numpy`'s
   `argsort(kind="stable")` resolves ties by row order, and with a model emitting 12 distinct scores
   over 11,272 candidates that meant parquet order decided the ranking: 0.3142 in row order, 0.0200
   shuffled. `rank_with_random_tiebreak` now makes a tie worth nothing, which is what a tie is worth.
