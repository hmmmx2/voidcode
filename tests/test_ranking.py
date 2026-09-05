"""The ranker. The label definition and the temporal split are where the invalidating errors are.

A leaky split produces numbers that are inflated, plausible, and unfalsifiable downstream. A wrong
label definition produces a model that optimises for the wrong thing while every metric looks fine.
Neither is caught by the model training successfully.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features.ranking import (
    FEATURE_NAMES,
    GRADE_ABANDONED,
    GRADE_PASSED_FIRST_TRY,
    GRADE_STRUGGLED_THEN_PASSED,
    GRADE_UNSEEN,
    LabelledExample,
    assert_no_leakage,
    build_features,
    evaluate,
    grade_for,
    ndcg_at_k,
    temporal_split,
    train_ranker,
)

T0 = datetime(2026, 1, 1)

#: Positions of the two features added in C5. Named, so a reordering of FEATURE_NAMES fails these
#: tests loudly instead of silently asserting about the wrong column.
FEATURE_INDEX_POPULARITY = 9
FEATURE_INDEX_RECENCY = 10


def ex(user: str, slug: str, grade: int, days: int) -> LabelledExample:
    # Width derived from FEATURE_NAMES, not hardcoded. It was `(0.0,) * 9`, and adding two features
    # made every training test fail with LightGBM's feature-count error instead of testing anything.
    return LabelledExample(user, slug, grade, (0.0,) * len(FEATURE_NAMES),
                           T0 + timedelta(days=days))


def test_productive_struggle_outranks_an_easy_pass() -> None:
    """The modelling decision an interviewer will ask about. A problem solved immediately taught
    the learner little; the one they had to fight for is the one that moved them."""
    assert grade_for(attempts=3, passed=True) == GRADE_STRUGGLED_THEN_PASSED
    assert grade_for(attempts=1, passed=True) == GRADE_PASSED_FIRST_TRY
    assert GRADE_STRUGGLED_THEN_PASSED > GRADE_PASSED_FIRST_TRY


def test_abandoned_scores_below_an_easy_pass() -> None:
    """The guard against optimising for frustration. If abandoned outranked an easy pass, the
    objective could reach a high grade simply by getting harder."""
    assert grade_for(attempts=4, passed=False) == GRADE_ABANDONED
    assert GRADE_ABANDONED < GRADE_PASSED_FIRST_TRY


def test_never_attempted_is_zero() -> None:
    assert grade_for(attempts=0, passed=False) == GRADE_UNSEEN


def test_unknown_mastery_is_distinguishable_from_zero_mastery() -> None:
    """Encoding 'never attempted' as 0.0 makes it identical to 'attempted and always failed' —
    opposite situations, one wanting introduction and the other remediation. One column cannot say
    which, so the model would learn whichever is commoner."""
    unknown = build_features(mastery=None, attempts_on_concept=0, first_attempt_rate=None,
                             difficulty="medium", n_concepts=2, sources=[])
    failed = build_features(mastery=0.0, attempts_on_concept=5, first_attempt_rate=0.0,
                            difficulty="medium", n_concepts=2, sources=[])
    assert unknown != failed
    assert unknown[1] == 0.0 and failed[1] == 1.0      # mastery_known


def test_candidate_sources_reach_the_features() -> None:
    f = build_features(mastery=0.5, attempts_on_concept=3, first_attempt_rate=0.5,
                       difficulty="hard", n_concepts=1, sources=["prerequisite"])
    assert f[7] == 1.0 and f[6] == 0.0


def test_temporal_split_puts_the_future_in_test() -> None:
    rows = [ex("u1", "a", 3, 0), ex("u1", "b", 2, 10), ex("u1", "c", 1, 20)]
    train, test = temporal_split(rows, T0 + timedelta(days=15))
    assert [e.problem_slug for e in train] == ["a", "b"]
    assert [e.problem_slug for e in test] == ["c"]


def test_leakage_raises_rather_than_warns() -> None:
    """A leaked split inflates every metric plausibly, and nothing downstream reveals it."""
    cutoff = T0 + timedelta(days=15)
    with pytest.raises(ValueError, match="predate the cutoff"):
        assert_no_leakage(train=[ex("u1", "a", 3, 0)], test=[ex("u1", "b", 2, 5)], cutoff=cutoff)


def test_a_random_split_would_be_caught() -> None:
    """The specific mistake: shuffling rows across the cutoff. This is the test spec 5.2 asks for."""
    cutoff = T0 + timedelta(days=15)
    rows = [ex("u1", f"p{i}", 2, i * 5) for i in range(6)]
    shuffled_train, shuffled_test = rows[::2], rows[1::2]     # a random, not temporal, split
    with pytest.raises(ValueError):
        assert_no_leakage(shuffled_train, shuffled_test, cutoff)


def test_ndcg_rewards_correct_ordering() -> None:
    assert ndcg_at_k([3, 2, 1, 0]) == pytest.approx(1.0)
    assert ndcg_at_k([0, 1, 2, 3]) < ndcg_at_k([3, 2, 1, 0])


def test_ndcg_is_zero_when_nothing_is_relevant() -> None:
    """Not 1.0. A ranker surfacing only irrelevant problems has not scored perfectly, and 1.0
    would let it average well."""
    assert ndcg_at_k([0, 0, 0]) == 0.0


def test_evaluation_carries_the_simulated_flag() -> None:
    """A simulated number that loses its provenance is how a platform ends up claiming
    personalisation it never measured."""
    result = evaluate({"u1": [(0.9, 3), (0.1, 0)]}, simulated=True)
    assert result.simulated
    assert "SIMULATED" in result.summary()


def test_evaluation_compares_against_baselines() -> None:
    scored = {"u1": [(0.9, 3), (0.5, 2), (0.1, 0)]}
    worse = {"u1": [(0.1, 3), (0.5, 2), (0.9, 0)]}
    result = evaluate(scored, simulated=True, baselines={"reversed": worse})
    assert result.ndcg_at_10 > result.baselines["reversed"]


def test_training_refuses_data_too_thin_to_rank() -> None:
    """Two learners is not a ranking problem. Returning a model here would produce confident
    scores from nothing, which is worse than returning none."""
    assert train_ranker([ex("u1", "a", 3, 0)]) is None


def test_training_fits_when_there_is_enough() -> None:
    rows = [ex(f"u{u}", f"p{p}", (u + p) % 4, p) for u in range(4) for p in range(6)]
    model = train_ranker(rows, num_boost_round=5)
    assert model is not None


def test_feature_names_and_vector_stay_the_same_length() -> None:
    """LightGBM raises when they drift, but only at train time.

    The first edit adding `catalog_popularity` and `concept_recency_days` updated `build_features`
    and missed `FEATURE_NAMES`, so the vector had 11 columns and the names 9. That is a two-second
    check here and a confusing training failure otherwise.
    """
    from features.ranking import FEATURE_NAMES

    vector = build_features(mastery=None, attempts_on_concept=0, first_attempt_rate=None,
                            difficulty="medium", n_concepts=1, sources=[])
    assert len(FEATURE_NAMES) == len(vector)


def test_an_unseen_concept_gets_the_furthest_recency_not_zero() -> None:
    """Encoding "never touched" as 0 days would say "touched today" — the opposite of the truth, and
    exactly the confusion `mastery_known` exists to avoid on the mastery column."""
    from features.ranking import MAX_RECENCY_DAYS

    unseen = build_features(mastery=None, attempts_on_concept=0, first_attempt_rate=None,
                            difficulty="medium", n_concepts=1, sources=[])
    assert unseen[FEATURE_INDEX_RECENCY] == MAX_RECENCY_DAYS


def test_recency_is_capped() -> None:
    """Uncapped, one ancient attempt dominates a tree split for no information gain."""
    from features.ranking import MAX_RECENCY_DAYS

    ancient = build_features(mastery=0.5, attempts_on_concept=1, first_attempt_rate=0.5,
                             difficulty="medium", n_concepts=1, sources=["weak_concept"],
                             concept_recency_days=9999)
    assert ancient[FEATURE_INDEX_RECENCY] == MAX_RECENCY_DAYS


def test_popularity_defaults_to_zero_so_the_product_path_still_works() -> None:
    """`features/recommend.py` does not pass these. Defaulting is honest where inventing a value
    would not be — but a model TRAINED on them and served against defaults would score every
    candidate as unpopular and never-touched, which is why ranking.py says so explicitly."""
    default = build_features(mastery=None, attempts_on_concept=0, first_attempt_rate=None,
                             difficulty="medium", n_concepts=1, sources=[])
    assert default[FEATURE_INDEX_POPULARITY] == 0.0
