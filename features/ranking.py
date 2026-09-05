"""Stage two of the ranker: order candidates with LambdaMART.

`features/candidates.py` narrows the catalog; this orders what survives. Spec §5.2.

THE LABEL DEFINITION IS THE MODELLING DECISION, NOT THE MODEL
----------------------------------------------------------------
An interviewer will ask why a first-attempt pass is *not* the top grade, so the reasoning belongs
here rather than in a commit message:

    3  attempted and eventually passed after >= 2 attempts   productive struggle
    2  passed on the first attempt                           already knew it
    1  attempted and abandoned                               too hard, or badly presented
    0  never attempted                                       no signal

A problem the learner solved immediately taught them little — recommending more like it is
comfortable and useless. A problem they abandoned was probably beyond them. **The one that moved
them is the one they had to fight for**, which is why grade 3 sits above grade 2 and not below it.

The risk this carries, and it should be stated: optimising for struggle can drift toward
recommending problems that are merely frustrating. Grade 1 exists to separate the two — abandoned
is scored *below* an easy pass, so the objective cannot reach grade 3 by simply getting harder.

WHY THE SPLIT MUST BE TEMPORAL
---------------------------------
A random split lets the model see a learner's later submissions while predicting their earlier
ones, which is future information about the same person. Every metric produced that way is
inflated, plausibly, and nothing downstream reveals it. `assert_no_leakage` exists so that failure
is loud rather than discovered in production.

WHAT THIS CANNOT DO YET
--------------------------
With 9 users and 2 submissions there is nothing honest to evaluate on. The machinery is built and
tested; any NDCG from this platform's own data today would be noise wearing a decimal point. Spec
§7.1 sanctions simulated learners *labelled as simulated*, and `evaluate` takes a `simulated` flag
that is carried into the result so a number cannot lose its provenance on the way to a slide.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime

#: Graded relevance. See the module docstring for why 3 > 2.
GRADE_STRUGGLED_THEN_PASSED = 3
GRADE_PASSED_FIRST_TRY = 2
GRADE_ABANDONED = 1
GRADE_UNSEEN = 0

FEATURE_NAMES = (
    "mastery",              # learner's score for this problem's concept, 0 if unknown
    "mastery_known",        # 1 if the learner has attempted this concept at all
    "attempts_on_concept",
    "first_attempt_rate",
    "difficulty",           # 0 easy, 1 medium, 2 hard
    "n_concepts",           # how broadly the problem is tagged
    "from_weak_concept",    # candidate source flags — why it surfaced
    "from_prerequisite",
    "from_coverage_gap",
    # Both named by spec §5.2, both absent until the evaluation harness showed why they matter.
    #
    # `ranking/eval.py` measured a popularity-only baseline beating this model 8.7x on NDCG@10, and
    # the reason was structural: pre-cutoff attempt count predicts what a learner does next with
    # Spearman 0.606, and 56.7% of subsequent engagement lands on the 100 most-attempted problems.
    # The model was competing against a signal it had never been given.
    #
    # `log1p` of the count, not the count: attempt counts span four orders of magnitude, and a tree
    # splitting on the raw value spends depth separating 40,000 from 39,000 rather than 3 from 300.
    "catalog_popularity",
    # Days since the learner last touched this concept, capped. Distinguishes a concept they were
    # working on last week from one abandoned a year ago — identical to a mastery score alone.
    "concept_recency_days",
)

#: This tuple and `build_features`' return MUST stay the same length. LightGBM raises
#: "Length of feature_name(9) and num_feature(11) don't match" when they drift, which is a good
#: error to get — but the first edit adding these two names missed this tuple entirely and the
#: mismatch only surfaced at train time.


@dataclass(frozen=True)
class LabelledExample:
    user_id: str
    problem_slug: str
    grade: int
    features: tuple[float, ...]
    at: datetime


def grade_for(attempts: int, passed: bool) -> int:
    """Graded relevance from a learner's history with one problem."""
    if not attempts:
        return GRADE_UNSEEN
    if not passed:
        return GRADE_ABANDONED
    return GRADE_PASSED_FIRST_TRY if attempts == 1 else GRADE_STRUGGLED_THEN_PASSED


#: Ceiling for `concept_recency_days`. Beyond a year the difference between 400 and 900 days carries
#: no information a ranker can use, and leaving it uncapped lets one ancient attempt dominate a split.
MAX_RECENCY_DAYS = 365.0


def build_features(*, mastery: float | None, attempts_on_concept: int,
                   first_attempt_rate: float | None, difficulty: str,
                   n_concepts: int, sources: Sequence[str],
                   catalog_popularity: float = 0.0,
                   concept_recency_days: float | None = None) -> tuple[float, ...]:
    """One feature row.

    `catalog_popularity` and `concept_recency_days` DEFAULT, so `features/recommend.py` keeps working
    without them. That is a deliberate trade rather than an oversight: the product path has 123
    problems and 2 submissions, so a popularity count there is noise, and defaulting is honest where
    inventing a value would not be. A model trained WITH these features and served against defaults
    would score every candidate as unpopular and never-touched — so `recommend()` must pass them
    before any model trained on them is deployed.

    `mastery_known` is separate from `mastery` on purpose. Encoding "never attempted" as 0.0 makes
    it indistinguishable from "attempted and always failed", which are opposite situations — one
    wants introducing, the other wants remediating. A single column cannot say which, and the model
    would learn whichever is commoner in the training set.
    """
    difficulty_ord = {"easy": 0.0, "medium": 1.0, "hard": 2.0}.get(difficulty, 1.0)
    src = set(sources)
    return (
        float(mastery) if mastery is not None else 0.0,
        0.0 if mastery is None else 1.0,
        float(attempts_on_concept),
        float(first_attempt_rate) if first_attempt_rate is not None else 0.0,
        difficulty_ord,
        float(n_concepts),
        1.0 if "weak_concept" in src else 0.0,
        1.0 if "prerequisite" in src else 0.0,
        1.0 if "coverage_gap" in src else 0.0,
        float(catalog_popularity),
        # An unseen concept has no recency. Encoding that as 0 would say "touched today", which is
        # the opposite of the truth — so it takes the cap, the furthest-away value.
        MAX_RECENCY_DAYS if concept_recency_days is None
        else min(float(concept_recency_days), MAX_RECENCY_DAYS),
    )


def temporal_split(examples: Sequence[LabelledExample], cutoff: datetime
                   ) -> tuple[list[LabelledExample], list[LabelledExample]]:
    """Train on everything before `cutoff`, evaluate on everything at or after it."""
    train = [e for e in examples if e.at < cutoff]
    test = [e for e in examples if e.at >= cutoff]
    return train, test


def assert_no_leakage(train: Iterable[LabelledExample], test: Iterable[LabelledExample],
                      cutoff: datetime) -> None:
    """Raise if any evaluation row predates the cutoff, or any training row does not.

    A random split lets the model see a learner's later behaviour while predicting their earlier
    behaviour. Every metric produced that way is inflated and plausible, and nothing downstream
    reveals it — which is why this raises rather than warns.
    """
    early = [e.problem_slug for e in test if e.at < cutoff]
    if early:
        raise ValueError(
            f"{len(early)} evaluation rows predate the cutoff (e.g. {early[:3]}). A temporal split "
            "that leaks invalidates every number computed from it.")
    late = [e.problem_slug for e in train if e.at >= cutoff]
    if late:
        raise ValueError(f"{len(late)} training rows are at or after the cutoff (e.g. {late[:3]})")


def dcg(grades: Sequence[int], k: int) -> float:
    import math

    return sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(grades[:k]))


def ndcg_at_k(ranked_grades: Sequence[int], k: int = 10) -> float:
    """NDCG@k for one learner's ranked list. 0.0 when there is nothing relevant to find.

    Zero rather than 1.0 for an all-irrelevant list: a ranker that orders nothing useful has not
    scored perfectly, and returning 1.0 would let a model that surfaces only zero-grade problems
    average well.
    """
    ideal = dcg(sorted(ranked_grades, reverse=True), k)
    return (dcg(ranked_grades, k) / ideal) if ideal > 0 else 0.0


@dataclass
class Evaluation:
    ndcg_at_10: float
    n_learners: int
    n_examples: int
    #: Carried into the result rather than left to the caller to remember. A simulated number that
    #: loses its provenance between here and a slide is how a platform ends up claiming
    #: personalisation it has never measured.
    simulated: bool
    baselines: dict[str, float] = field(default_factory=dict)

    def summary(self) -> str:
        tag = "  [SIMULATED LEARNERS — not a measurement of real users]" if self.simulated else ""
        lines = [f"NDCG@10 {self.ndcg_at_10:.4f} over {self.n_learners} learners"
                 f" / {self.n_examples} examples{tag}"]
        for name, value in sorted(self.baselines.items()):
            delta = self.ndcg_at_10 - value
            lines.append(f"  vs {name:22s} {value:.4f}  ({delta:+.4f})")
        return "\n".join(lines)


def evaluate(scored: Mapping[str, Sequence[tuple[float, int]]], *, simulated: bool,
             baselines: Mapping[str, Mapping[str, Sequence[tuple[float, int]]]] | None = None,
             k: int = 10) -> Evaluation:
    """`scored` maps learner -> [(score, grade)]. Sorted here, so callers cannot forget to."""
    def mean_ndcg(per_learner: Mapping[str, Sequence[tuple[float, int]]]) -> float:
        if not per_learner:
            return 0.0
        scores = []
        for rows in per_learner.values():
            ordered = [g for _, g in sorted(rows, key=lambda r: -r[0])]
            scores.append(ndcg_at_k(ordered, k))
        return sum(scores) / len(scores)

    return Evaluation(
        ndcg_at_10=mean_ndcg(scored),
        n_learners=len(scored),
        n_examples=sum(len(v) for v in scored.values()),
        simulated=simulated,
        baselines={name: mean_ndcg(rows) for name, rows in (baselines or {}).items()},
    )


def train_ranker(train: Sequence[LabelledExample], *, num_boost_round: int = 100):
    """Fit LambdaMART. Groups are learners, which is what makes it a ranking objective.

    Returns None when there is too little data to fit anything meaningful, rather than returning a
    model that will produce confident scores from nothing. Two learners is not a ranking problem.
    """
    import lightgbm as lgb
    import numpy as np

    by_user: dict[str, list[LabelledExample]] = {}
    for e in train:
        by_user.setdefault(e.user_id, []).append(e)
    if len(by_user) < 2 or len(train) < 10:
        return None

    ordered = [e for user in sorted(by_user) for e in by_user[user]]
    x = np.array([e.features for e in ordered], dtype=float)
    y = np.array([e.grade for e in ordered], dtype=int)
    group = [len(by_user[user]) for user in sorted(by_user)]

    dataset = lgb.Dataset(x, label=y, group=group, feature_name=list(FEATURE_NAMES))
    return lgb.train(
        {"objective": "lambdarank", "metric": "ndcg", "ndcg_eval_at": [10],
         "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 5, "verbose": -1},
        dataset, num_boost_round=num_boost_round)
