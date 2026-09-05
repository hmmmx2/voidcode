"""Tests for the experimentation layer. Spec §7.1/§7.2.

The load-bearing test is `test_peeking_does_not_inflate_false_positives`. Everything else in this
module is machinery; that one is the claim the machinery exists to support, and it is checked by
simulation rather than asserted from the maths.
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from experiments import bucketing, interleaving, sequential  # noqa: E402
from experiments.registry import Experiment, required_sample_size  # noqa: E402

# ── bucketing ────────────────────────────────────────────────────────────────

def test_assignment_is_stable_across_processes():
    """The reason this uses sha256 and not hash(). Python salts str hashing per process, so a
    hash()-based bucketer reassigns everyone on restart, mixing the arms and diluting the measured
    effect by an unknown amount while still looking like a clean 50/50 split.

    These literals were computed once; if they ever change, assignment is no longer portable and
    every in-flight experiment is invalid.
    """
    assert bucketing.bucket_of("learner-00001", "experiment:x") == 3466
    assert bucketing.assign("learner-00001", "experiment:x",
                            {"control": 0.5, "treatment": 0.5}) == "control"


def test_same_learner_always_gets_the_same_variant():
    split = {"control": 0.5, "treatment": 0.5}
    first = [bucketing.assign(f"u{i}", "salt", split) for i in range(500)]
    again = [bucketing.assign(f"u{i}", "salt", split) for i in range(500)]
    assert first == again


def test_different_experiments_decorrelate():
    """Without a per-experiment salt the same learners share an arm in every experiment, so a
    learner-level fluke recurs and looks like replication."""
    split = {"control": 0.5, "treatment": 0.5}
    a = [bucketing.assign(f"u{i}", "experiment:one", split) for i in range(2000)]
    b = [bucketing.assign(f"u{i}", "experiment:two", split) for i in range(2000)]
    agreement = sum(x == y for x, y in zip(a, b, strict=True)) / len(a)
    assert 0.42 < agreement < 0.58, f"assignments correlate across experiments: {agreement}"


def test_traffic_split_is_respected():
    split = {"control": 0.9, "treatment": 0.1}
    counts = {"control": 0, "treatment": 0}
    for i in range(20000):
        counts[bucketing.assign(f"u{i}", "s", split)] += 1
    assert 0.08 < counts["treatment"] / 20000 < 0.12


def test_assignment_does_not_depend_on_dict_order():
    """Re-declaring the same config with keys in a different order must not reassign anyone."""
    a = bucketing.assign("u1", "s", {"control": 0.5, "treatment": 0.5})
    b = bucketing.assign("u1", "s", {"treatment": 0.5, "control": 0.5})
    assert a == b


def test_a_split_that_does_not_sum_to_one_is_refused():
    with pytest.raises(ValueError, match="sum to 1"):
        bucketing.assign("u1", "s", {"control": 0.5, "treatment": 0.4})


# ── the claim the module rests on ────────────────────────────────────────────

def test_peeking_does_not_inflate_false_positives():
    """THE test. Under no true effect, peek after every batch and stop the moment the interval
    excludes zero. A fixed-horizon 95% interval used this way approaches a 100% false positive rate;
    an always-valid confidence sequence must stay at or under alpha.

    Simulated rather than argued, because the guarantee is the entire reason this module is not just
    a t-test in a loop.
    """
    import math

    def run(decide, seed=11, trials=300, peeks=40, batch=25):
        rng = random.Random(seed)
        fired = 0
        for _ in range(trials):
            s_c = s_t = n = 0
            for _ in range(peeks):
                # 25 INDEPENDENT trials per peek. The first version of this test drew one Bernoulli
                # and multiplied by 25, which is not the same process at all -- it let a single coin
                # flip move an arm by 25 successes and reported a false positive rate of 1.000
                # against a confidence sequence that was in fact correct.
                s_c += sum(rng.random() < 0.30 for _ in range(batch))
                s_t += sum(rng.random() < 0.30 for _ in range(batch))   # identical arms
                n += batch
                if decide(s_c, s_t, n):
                    fired += 1
                    break
        return fired / trials

    alpha = 0.05
    always_valid = run(lambda c, t, n: sequential.confidence_sequence(
        c, n, t, n, alpha=alpha).excludes_zero)

    def naive(c, t, n):
        """A fixed-horizon 95% z-interval, checked at every peek — the thing this replaces."""
        p_c, p_t = c / n, t / n
        se = math.sqrt(p_c * (1 - p_c) / n + p_t * (1 - p_t) / n) or 1e-12
        return abs(p_t - p_c) > 1.96 * se

    fixed_horizon = run(naive)

    assert always_valid <= alpha, (
        f"confidence sequence is not valid: {always_valid:.3f} > alpha {alpha}")
    # The contrast is the point. Without it a sequence that never fires would pass the line above,
    # and being trivially conservative is not the same as being correct.
    assert fixed_horizon > alpha * 2, (
        f"the naive test should be badly inflated under peeking, got {fixed_horizon:.3f}")


def test_the_interval_covers_a_real_effect():
    """Validity is worthless without power: an interval that never excludes zero is trivially
    valid. This checks the sequence actually detects an effect that is there."""
    rng = random.Random(3)
    n = 20000
    s_c = sum(rng.random() < 0.30 for _ in range(n))
    s_t = sum(rng.random() < 0.38 for _ in range(n))
    ci = sequential.confidence_sequence(s_c, n, s_t, n)
    assert ci.excludes_zero and ci.verdict == "treatment better"
    assert ci.lower < 0.08 < ci.upper, f"interval {ci} misses the true effect of 0.08"


def test_no_data_licenses_nothing():
    ci = sequential.confidence_sequence(0, 0, 0, 0)
    assert ci.verdict == "inconclusive"


def test_a_degenerate_arm_does_not_produce_a_confident_verdict():
    """Every outcome identical gives zero sample variance, which without a floor yields a
    zero-width interval and a confident answer from no information."""
    ci = sequential.confidence_sequence(0, 30, 30, 30)
    assert ci.upper > ci.lower


# ── guardrails ───────────────────────────────────────────────────────────────

def test_guardrail_fires_on_a_real_regression_and_not_on_noise():
    assert sequential.guardrail_breached(0.20, 0.32, tolerance=0.05) is True
    assert sequential.guardrail_breached(0.20, 0.203, tolerance=0.05) is False
    # Direction matters: for a metric where lower is worse, a drop is the breach.
    assert sequential.guardrail_breached(0.50, 0.40, tolerance=0.05, higher_is_worse=False) is True


# ── power ────────────────────────────────────────────────────────────────────

def test_smaller_effects_need_more_learners():
    assert required_sample_size(0.30, 0.10) < required_sample_size(0.30, 0.05)
    assert required_sample_size(0.30, 0.05) < required_sample_size(0.30, 0.02)


def test_the_platform_cannot_run_this_experiment():
    """9 users against a four-figure requirement. The point of the calculator is to say so in
    advance rather than to discover it in an underpowered result."""
    exp = Experiment(key="k", hypothesis="h", variants={"control": 0.5, "treatment": 0.5})
    ok, why = exp.feasible_with(9)
    assert ok is False and "NOT FEASIBLE" in why


def test_an_experiment_needs_a_control():
    with pytest.raises(ValueError, match="control"):
        Experiment(key="k", hypothesis="h", variants={"a": 0.5, "b": 0.5})


def test_the_primary_metric_cannot_also_be_a_guardrail():
    with pytest.raises(ValueError, match="both the primary metric and a guardrail"):
        Experiment(key="k", hypothesis="h", variants={"control": 0.5, "t": 0.5},
                   primary_metric="error_rate", guardrails=("error_rate",))


# ── interleaving ─────────────────────────────────────────────────────────────

def test_neither_ranker_systematically_owns_the_top_slot():
    """Without the per-round coin flip, ranker A always fills position 1, which collects the most
    engagement regardless of quality — the measurement becomes one of argument order."""
    rng = random.Random(7)
    owners = []
    for _ in range(600):
        il = interleaving.team_draft([f"a{i}" for i in range(10)],
                                     [f"b{i}" for i in range(10)], rng=rng)
        owners.append(il.credit[il.items[0]])
    share = owners.count("A") / len(owners)
    assert 0.42 < share < 0.58, f"top slot is not fairly allocated: A gets {share:.2f}"


def test_credit_is_attributed_to_the_placing_ranker():
    il = interleaving.team_draft(["x", "y"], ["p", "q"], length=4,
                                 rng=random.Random(0), name_a="A", name_b="B")
    wins = il.attribute({il.items[0]})
    assert sum(wins.values()) == 1
    assert set(wins) <= {"A", "B"}


def test_engagement_outside_the_list_is_ignored():
    """A learner can reach a problem by search or a direct link; that belongs to neither ranker."""
    il = interleaving.team_draft(["x"], ["p"], length=2, rng=random.Random(0))
    assert il.attribute({"something-else"}) == {}


def test_interleaving_detects_the_better_ranker():
    rng = random.Random(5)
    sessions = []
    for _ in range(300):
        a = [f"p{i}" for i in rng.sample(range(40), 10)]
        b = [f"p{i}" for i in rng.sample(range(40), 10)]
        engaged = {x for x in b[:4] if rng.random() < 0.6}   # B is genuinely better
        sessions.append((a, b, engaged))
    out = interleaving.compare(sessions, name_a="A", name_b="B")
    assert out["wins_B"] > out["wins_A"]


def test_no_decisive_session_reports_none_not_a_dead_heat():
    """"No preference measured" and "measured a tie" are different claims; only one is supported by
    zero observations."""
    sessions = [(["a"], ["b"], set()) for _ in range(10)]
    out = interleaving.compare(sessions)
    assert out["win_rate_a"] is None
