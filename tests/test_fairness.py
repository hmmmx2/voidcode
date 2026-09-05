"""Tests for the segment audit. Spec §8.3.

These cover the pure reporting logic, not the warehouse run. The thing worth defending is that a
gap gets FLAGGED when it is real and NOT flagged when the group is too small to support the claim —
an audit that cries wolf on a bucket of two is as useless as one that misses a real gap.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ranking import fairness  # noqa: E402
from ranking.fairness import (  # noqa: E402
    UNDERSERVED_THRESHOLD,
    audit,
    bootstrap_ci,
    depth_bucket,
)


def frame(pairs):
    return pd.DataFrame({"learner_id": [p[0] for p in pairs], "g": [p[1] for p in pairs]})


def test_a_real_gap_is_flagged():
    """A group well below the mean, with enough learners to say so."""
    ndcg = {f"a{i}": 0.30 for i in range(40)} | {f"b{i}": 0.10 for i in range(40)}
    groups = frame([(f"a{i}", "good") for i in range(40)] +
                   [(f"b{i}", "bad") for i in range(40)])
    out = audit(ndcg, groups, "g", overall_mean=0.20)
    bad = out[out.group == "bad"].iloc[0]
    assert bool(bad.underserved)
    assert bool(bad.ci_excludes_mean)
    assert bad.vs_mean < -UNDERSERVED_THRESHOLD


def test_noise_is_not_flagged():
    """Groups that differ only slightly must not trip the flag, or every audit reports a problem."""
    ndcg = {f"a{i}": 0.20 for i in range(40)} | {f"b{i}": 0.19 for i in range(40)}
    groups = frame([(f"a{i}", "one") for i in range(40)] +
                   [(f"b{i}", "two") for i in range(40)])
    out = audit(ndcg, groups, "g", overall_mean=0.195)
    assert not out.underserved.any()


def test_a_tiny_group_gets_a_flag_but_not_a_claim():
    """THE distinction the report rests on. A 3-learner group can easily sit 30% below the mean by
    chance; `underserved` fires on the point estimate as the spec asks, while `ci_excludes_mean`
    stays False so the row cannot be read as a demonstrated gap."""
    ndcg = {f"a{i}": 0.20 for i in range(60)} | {"t1": 0.05, "t2": 0.25, "t3": 0.06}
    groups = frame([(f"a{i}", "big") for i in range(60)] +
                   [("t1", "tiny"), ("t2", "tiny"), ("t3", "tiny")])
    out = audit(ndcg, groups, "g", overall_mean=0.20)
    tiny = out[out.group == "tiny"].iloc[0]
    assert tiny.learners == 3
    assert bool(tiny.underserved)
    assert not bool(tiny.ci_excludes_mean), "3 noisy learners must not read as a proven gap"


def test_an_interval_needs_at_least_three_learners():
    """Two learners have no usable interval; inventing one would give the least reliable buckets
    the most confident-looking output."""
    assert all(math.isnan(v) for v in bootstrap_ci([0.1, 0.2]))
    low, high = bootstrap_ci([0.1, 0.2, 0.3, 0.4, 0.5])
    assert low < high


def test_intervals_narrow_as_the_group_grows():
    small = bootstrap_ci([0.1, 0.3] * 3)
    large = bootstrap_ci([0.1, 0.3] * 60)
    assert (large[1] - large[0]) < (small[1] - small[0])


def test_depth_buckets_cover_every_count():
    """A learner falling through the bucketing would be dropped from the audit silently."""
    assert depth_bucket(1) == "1-5 (sparse)"
    assert depth_bucket(5) == "1-5 (sparse)"
    assert depth_bucket(6) == "6-20"
    assert depth_bucket(60) == "21-60"
    assert depth_bucket(61) == "61+"
    assert depth_bucket(10_000_000) == "61+"


def test_learners_without_a_score_are_skipped_not_counted_as_zero():
    """Scoring a missing learner as 0 would manufacture a gap in whichever group had gaps in
    coverage, which is the opposite of what an audit is for."""
    ndcg = {"a1": 0.2, "a2": 0.2}
    groups = frame([("a1", "g"), ("a2", "g"), ("missing", "g")])
    out = audit(ndcg, groups, "g", overall_mean=0.2)
    assert out.iloc[0].learners == 2
    assert out.iloc[0].ndcg_at_10 == 0.2


def test_output_is_sorted_worst_first():
    """The worst-served group is the point of the report and should not need looking for."""
    ndcg = {"a": 0.3, "b": 0.1, "c": 0.2}
    groups = frame([("a", "high"), ("b", "low"), ("c", "mid")])
    out = audit(ndcg, groups, "g", overall_mean=0.2)
    assert list(out.group) == ["low", "mid", "high"]


# ── the positive-count control ───────────────────────────────────────────────
# These exist because the raw depth gap is partly a task-difficulty confound: sparse learners have
# a median of 2 gradeable positives against 8 for the 21-60 bucket. A table that hid that would
# overstate the ranker's fault by roughly half.

def test_positive_strata_cover_every_count():
    seen = {fairness.positive_stratum(n) for n in range(0, 400)}
    assert seen == {label for _, _, label in fairness.POSITIVE_STRATA}


def test_positive_stratum_edges_are_inclusive():
    assert [fairness.positive_stratum(n) for n in (0, 1, 2, 3, 4, 8, 9, 10**6)] == [
        "1", "1", "2-3", "2-3", "4-8", "4-8", "9+", "9+"]


def _frames():
    depth = pd.DataFrame({"learner_id": list("abcd"),
                          "bucket": ["1-5 (sparse)", "1-5 (sparse)", "21-60", "61+"]})
    positives = pd.DataFrame({"learner_id": list("abcd"), "n_pos": [2, 3, 3, 1]})
    return depth, positives


def test_stratified_means_are_within_cell_not_across():
    """Expected values are arithmetic, not a second call to the code under test."""
    depth, positives = _frames()
    out = fairness.stratified({"a": 0.2, "b": 0.4, "c": 0.9, "d": 0.1}, depth, positives)
    assert out.loc["2-3", "1-5 (sparse)"] == "0.3000(n=2)"     # (0.2 + 0.4) / 2
    assert out.loc["2-3", "21-60"] == "0.9000(n=1)"
    assert out.loc["1", "61+"] == "0.1000(n=1)"


def test_every_cell_carries_its_sample_count():
    """A rate without its n is the specific thing this table exists to stop.

    The first run showed 0.0000 for one cell and 0.4438 for another; both were single learners,
    and both read as findings until the counts were attached.
    """
    depth, positives = _frames()
    out = fairness.stratified({"a": 0.2, "b": 0.4, "c": 0.9, "d": 0.1}, depth, positives)
    populated = [v for v in out.to_numpy().ravel() if v != "-"]
    assert populated, "table came back empty"
    assert all("(n=" in v for v in populated), populated


def test_empty_cells_are_dashes_not_zero():
    """Zero is a score a ranker can earn. No learners in the cell is not that, and averaging an
    absent cell to 0.0 would invent a gap where there is no measurement."""
    depth, positives = _frames()
    out = fairness.stratified({"a": 0.2, "b": 0.4, "c": 0.9, "d": 0.1}, depth, positives)
    assert out.loc["1", "1-5 (sparse)"] == "-"


def test_learners_missing_from_the_positives_frame_do_not_crash():
    depth, positives = _frames()
    out = fairness.stratified({"a": 0.2, "b": 0.4, "c": 0.9, "d": 0.1},
                              depth, positives.iloc[:2])
    assert out.loc["1", "21-60"].startswith("0.9000")   # n_pos fills to 0, landing in stratum "1"


# ── paired comparison of two rankers ─────────────────────────────────────────

def test_a_constant_shift_is_detected_as_improvement():
    before = {f"u{i}": 0.20 for i in range(40)}
    after = {f"u{i}": 0.30 for i in range(40)}      # +0.10 for every learner, zero variance
    out = fairness.paired_delta(before, after, {f"u{i}": "g" for i in range(40)})
    row = out[out.group == "ALL"].iloc[0]
    assert row.mean_delta == 0.1
    assert row.verdict == "improved"


def test_pure_noise_reports_no_effect():
    """The property that matters: a difference centred on zero must NOT be called a win.

    Signs alternate, so the mean is exactly 0 by construction and no bootstrap resample can put
    the whole interval on one side.
    """
    before = {f"u{i}": 0.20 for i in range(60)}
    after = {f"u{i}": 0.20 + (0.05 if i % 2 else -0.05) for i in range(60)}
    out = fairness.paired_delta(before, after, {f"u{i}": "g" for i in range(60)})
    assert out[out.group == "ALL"].iloc[0].verdict == "no effect"


def test_pairing_sees_what_group_means_hide():
    """Why this function exists rather than two means compared by eye.

    Every learner improves by 0.02, but they are spread from 0.05 to 0.65 — so the group means
    differ by far less than the spread, and an unpaired look reads as noise. Paired, it is exact.
    """
    before = {f"u{i}": 0.05 + i * 0.01 for i in range(60)}
    after = {k: v + 0.02 for k, v in before.items()}
    out = fairness.paired_delta(before, after, {f"u{i}": "g" for i in range(60)})
    row = out[out.group == "ALL"].iloc[0]
    assert row.mean_delta == 0.02
    assert row.ci_low > 0, "a uniform improvement must not be reported as no effect"


def test_groups_are_reported_separately_and_all_is_present():
    before = {f"u{i}": 0.2 for i in range(20)}
    after = {f"u{i}": 0.3 if i < 10 else 0.2 for i in range(20)}
    groups = {f"u{i}": ("sparse" if i < 10 else "deep") for i in range(20)}
    out = fairness.paired_delta(before, after, groups).set_index("group")
    assert out.loc["sparse"].verdict == "improved"
    assert out.loc["deep"].mean_delta == 0.0
    assert out.loc["ALL"].learners == 20


def test_a_group_too_small_to_bootstrap_is_named_not_dropped():
    before = {"a": 0.1, "b": 0.2, "c": 0.3, "d": 0.4}
    after = {"a": 0.2, "b": 0.3, "c": 0.4, "d": 0.5}
    out = fairness.paired_delta(before, after, {"a": "big", "b": "big", "c": "big", "d": "tiny"})
    tiny = out[out.group == "tiny"].iloc[0]
    assert tiny.verdict == "too few"          # silently dropping it would hide a subgroup
    assert math.isnan(tiny.mean_delta)


def test_learners_missing_from_one_run_are_excluded_not_treated_as_zero():
    """An unpaired learner has no difference. Scoring them 0 would dilute a real effect toward it."""
    before = {"a": 0.1, "b": 0.2, "c": 0.3, "d": 0.4, "e": 0.5}
    after = {k: v + 0.1 for k, v in before.items() if k != "e"}
    out = fairness.paired_delta(before, after, dict.fromkeys("abcde", "g"))
    row = out[out.group == "ALL"].iloc[0]
    assert row.learners == 4
    assert abs(row.mean_delta - 0.1) < 1e-9
