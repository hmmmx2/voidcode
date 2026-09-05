# What the ranker is actually doing

Deep analysis of the model behind the §5.2 numbers in `docs/METRICS.md`. Written because the headline
figure (NDCG@10 0.2143 against a best baseline of 0.0511) says the model works, and says nothing about
*why* — and twice in this project a ranking number that looked right was wrong for a reason no
aggregate metric could show.

All figures below: 40–120 evaluation learners, full 11,267-problem catalogue, cutoff 2026-07-15,
random tie-breaking, seed 20260812.

---

## 1. Feature ablation: popularity is load-bearing, and insufficient alone

| features used | NDCG@10 |
|---|---|
| all 11 | **0.2584** |
| minus `catalog_popularity` | **0.0367** |
| minus `n_concepts` | 0.1924 |
| minus `concept_recency_days` | 0.2496 |
| minus `n_concepts` + `concept_recency_days` | 0.1146 |
| minus `catalog_popularity` + `concept_recency_days` | 0.0041 |
| **only** `catalog_popularity` | 0.0611 |

Removing popularity collapses the model **7×**, to barely above the difficulty baselines. So the C5
result rests on it, which is consistent with the C4 diagnosis rather than a surprise.

But popularity **alone** scores 0.0611 — essentially the popularity baseline (0.0511). The model's
advantage is an *interaction*: popularity says "learners do this problem", `n_concepts` says "this
problem is substantively tagged", and together they identify problems an active learner will engage
with. Neither does it alone.

`concept_recency_days` earns almost nothing (0.2584 → 0.2496, ~3%). It is kept because §5.2 names it
and because it will matter once the platform has learners with months of history, but it should not be
described as pulling weight today.

## 2. `n_concepts` is not a popularity proxy, and is nearly saturated

The obvious worry, given it had the highest LightGBM gain (7840, above popularity's 4587), was that it
is popularity in disguise. Measured, it is not:

```
spearman(n_concepts, pre-cutoff popularity)   0.060
spearman(n_concepts, post-cutoff engagement)  0.077
spearman(popularity, post-cutoff engagement)  0.505
```

Its own correlation with the target is 0.077 — nearly nothing. Yet the ablation shows it contributes
25% of the result. That combination means it works only in interaction, and it is worth knowing that
its distribution is extremely lopsided:

```
n_concepts:  1 → 886   2 → 1,614   3 → 1,747   4 → 7,037
```

**62% of the catalogue sits at exactly 4**, which is the taxonomy's per-problem cap. So this feature is
mostly a binary "capped or not", and the high gain reflects a feature the trees split on repeatedly
rather than one carrying much information per split. A richer difficulty or topic signal would probably
replace it. Do not read its gain rank as importance.

## 3. THE RANKING IS ONLY PARTLY PERSONALISED — measured

The question a metric cannot answer: is this a personalised ranker, or a global "best problems" list
with a per-learner label? Across 40 learners, 780 pairwise comparisons:

| | |
|---|---|
| mean overlap in top-10 between any two learners | **4.52 of 10** |
| pairs with an identical top-10 | **0** |
| distinct problems across all 40 learners' top-10s | **48** |

So roughly **45% of any learner's top-10 is shared with any other learner**, and 48 problems serve 40
learners. It is neither a global list (no two learners get the same one) nor deeply personalised
(nearly half of each list is the common core).

That is the honest characterisation, and it follows directly from finding 1: popularity is the strongest
feature, popular problems are popular for everyone, and the differentiation comes from excluding what
each learner already attempted plus their per-concept mastery.

**What this means for the product claim.** "Recommended for you" is defensible — the lists genuinely
differ per learner — but "personalised learning path" overstates a list that is 45% common core. The
`ranked_by` field already prevents the worse error of presenting the heuristic as a model; this is the
next honesty boundary, and it needs a number attached rather than an adjective.

---

## What this analysis did not cover

- ~~**`features/mastery.py`'s 30-day half-life** has never been fitted.~~ **Now fitted**, on 49,745
  held-out attempts: predict whether a learner's next attempt on a concept passed, from a
  recency-weighted history of their earlier attempts on it.

  | half-life | log loss |
  |---|---|
  | 7 days | 0.96870 |
  | **30 days (the default)** | **0.95252** |
  | 90 days | 0.94946 |
  | **365 days (best)** | **0.94902** |
  | no decay at all | 0.94923 |

  **30 days is the worst value tested**, and no decay beats it — the default discards information. But
  the whole spread is 0.37%, so recency weighting barely matters on this corpus either way.

  The default is left at 30 anyway, and that is deliberate: this is a World A measurement over years of
  competitive-programming history, and the constant serves World B, where learners return weekly to an
  ML-interview catalogue and forgetting plausibly runs faster. Swapping one unfitted number for another
  with a measurement attached to make it look principled would be worse than leaving it and saying so.
  What the fit establishes is that the value is not principled and should be fitted per corpus —
  `mastery_for_learner` already takes the parameter, so that is a caller decision.
- **Credit division across an item's concepts** (a submission is worth one observation split across its
  concepts) is a defensible modelling choice that has not been compared against the alternative.
- **`difficulty_beta` leaks**, like `n_observations` did: the IRT fit ran over the whole warehouse. It
  is unused as a model feature and the difficulty baselines score zero regardless, so nothing current
  is affected — but a future feature built on β would inherit the leak.
- **The 91 inferred concept tags** in `docs/TAG_REVIEW.md` are still unreviewed. Mastery divides credit
  across an item's concepts, so a wrong tag moves weight to the wrong concept, and the ranker then
  recommends against a weakness the learner does not have. Every number here rests on those tags being
  approximately right.
