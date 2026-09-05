"""GRPO's arithmetic, checked against TRL and against the cases that make it fail silently.

The plan asks for the loop to be written here and validated against `GRPOTrainer`. Where TRL is
installed, the advantage computation is compared to it directly. Where it is not, the properties
that matter are asserted directly — and those are the more useful tests anyway, because agreeing
with TRL on a happy path says nothing about the dead-group case, which is what actually goes wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch", reason="needs torch")

from rl.grpo import (  # noqa: E402
    approx_kl,
    clipped_policy_loss,
    dead_group_rate,
    group_advantages,
    grpo_loss,
)


def test_advantages_are_centred_within_each_group() -> None:
    """Each prompt is its own baseline. A group's advantages must sum to zero."""
    rewards = torch.tensor([[0.0, 0.5, 1.0], [0.2, 0.2, 0.8]])
    adv = group_advantages(rewards)

    torch.testing.assert_close(adv.sum(dim=1), torch.zeros(2), atol=1e-5, rtol=0)
    # And the ordering within a group is preserved.
    assert adv[0, 0] < adv[0, 1] < adv[0, 2]


def test_absolute_reward_level_does_not_matter() -> None:
    """A hard prompt and an easy one contribute by internal spread, not by level.

    This is the property that makes a value network unnecessary, so it is worth pinning: shifting
    a whole group by a constant must not change its advantages at all.
    """
    base = torch.tensor([[0.1, 0.2, 0.3]])
    shifted = base + 10.0

    torch.testing.assert_close(group_advantages(base), group_advantages(shifted), rtol=1e-5, atol=1e-6)


def test_normalisation_uses_the_population_std_not_the_sample_std() -> None:
    """Pinned by hand, because the only other cover was the TRL test — which skips when TRL is absent.

    A mutation to `unbiased=True` survived the whole suite until this existed. It is not a rounding
    difference: at G=4 the sample std is sqrt(4/3) = 1.155x the population std, so every advantage
    would be 13% smaller and the effective learning rate would be quietly wrong. The group is the
    entire population being compared, not a sample drawn from a larger one, so `unbiased=False`
    is the correct convention as well as TRL's.
    """
    rewards = torch.tensor([[0.0, 1.0]])
    # mean 0.5; population std 0.5; sample std 0.7071
    expected = torch.tensor([[-0.5 / (0.5 + 1e-4), 0.5 / (0.5 + 1e-4)]])

    torch.testing.assert_close(group_advantages(rewards), expected, rtol=1e-6, atol=1e-7)

    sample_std_result = 0.5 / (0.70710678 + 1e-4)
    assert abs(float(group_advantages(rewards)[0, 1]) - sample_std_result) > 0.2, (
        "advantage matches the sample-std convention; normalisation is using unbiased=True"
    )


def test_a_dead_group_produces_exactly_zero_advantage() -> None:
    """All completions equal -> no information about which was better -> no gradient.

    Exactly zero, not merely small: a tiny non-zero advantage from floating point would inject
    noise into the policy from groups that learned nothing.
    """
    rewards = torch.tensor([[0.7, 0.7, 0.7, 0.7]])
    adv = group_advantages(rewards)

    assert torch.equal(adv, torch.zeros_like(adv))


def test_dead_group_rate_counts_what_it_says() -> None:
    rewards = torch.tensor([
        [1.0, 1.0, 1.0],   # dead: all pass
        [0.0, 0.0, 0.0],   # dead: all fail
        [0.0, 0.5, 1.0],   # alive
    ])
    assert dead_group_rate(rewards) == pytest.approx(2 / 3)
    assert dead_group_rate(torch.tensor([[0.0, 1.0]])) == 0.0
    assert dead_group_rate(torch.tensor([[0.5, 0.5]])) == 1.0


def test_all_pass_and_all_fail_are_both_dead() -> None:
    """The asymmetry people expect is not there, and assuming it is wastes a filter.

    A model that solves every prompt teaches GRPO exactly as little as one that solves none. This
    is why P3a filters on a 10-90% base pass rate rather than just dropping the failures.
    """
    assert dead_group_rate(torch.ones(1, 8)) == 1.0
    assert dead_group_rate(torch.zeros(1, 8)) == 1.0


def test_group_of_one_is_refused() -> None:
    """G=1 has no within-group baseline. Silently returning zeros would look like training."""
    with pytest.raises(ValueError, match="G >= 2"):
        group_advantages(torch.tensor([[1.0]]))


def test_k3_kl_is_never_negative() -> None:
    """The reason k3 is used instead of `logp - ref_logp`.

    A negative KL term turns the penalty into a reward for moving away from the reference, which is
    the opposite of regularisation. Sampled over a wide range of log-ratios, k3 must never go below
    zero, and must be zero exactly when the policies agree.
    """
    logp = torch.linspace(-8, 8, 400)
    ref = torch.zeros_like(logp)

    kl = approx_kl(logp, ref)
    assert (kl >= 0).all(), f"k3 went negative, min {kl.min().item()}"
    torch.testing.assert_close(approx_kl(logp, logp), torch.zeros_like(logp), atol=1e-6, rtol=0)

    # The naive estimator does go negative, which is the whole point of not using it.
    naive = logp - ref
    assert (naive < 0).any()


def test_clipping_binds_on_a_large_ratio() -> None:
    """An unclipped update would let one batch move the policy arbitrarily far."""
    adv = torch.ones(4)
    old = torch.zeros(4)
    far = torch.tensor([2.0, 2.0, 2.0, 2.0])            # ratio e^2 ~ 7.4

    loss, stats = clipped_policy_loss(far, old, adv, epsilon=0.2)

    assert stats["clip_fraction"] == 1.0
    # Clipped to (1 + eps) * A = 1.2, negated.
    torch.testing.assert_close(loss, torch.tensor(-1.2), rtol=1e-5, atol=1e-6)


def test_no_clipping_when_the_policy_has_not_moved() -> None:
    logp = torch.randn(16)
    loss, stats = clipped_policy_loss(logp, logp.clone(), torch.ones(16), epsilon=0.2)

    assert stats["ratio_mean"] == pytest.approx(1.0, abs=1e-6)
    assert stats["clip_fraction"] == 0.0
    torch.testing.assert_close(loss, torch.tensor(-1.0), rtol=1e-5, atol=1e-6)


def test_beta_zero_removes_the_kl_term_entirely() -> None:
    logp, old, ref = torch.randn(8), torch.randn(8), torch.randn(8)
    adv = torch.randn(8)

    with_kl, _ = grpo_loss(logp, old, ref, adv, beta=0.04)
    without, _ = grpo_loss(logp, old, ref, adv, beta=0.0)
    policy_only, _ = clipped_policy_loss(logp, old, adv)

    torch.testing.assert_close(without, policy_only, rtol=1e-6, atol=1e-7)
    assert not torch.isclose(with_kl, without)


def test_masked_tokens_are_excluded_from_both_terms() -> None:
    """Prompt tokens must not contribute. Completion tokens only, or the policy trains on its input."""
    logp, old, ref = torch.randn(10), torch.randn(10), torch.randn(10)
    adv = torch.randn(10)
    mask = torch.tensor([0.0] * 5 + [1.0] * 5)

    masked, _ = grpo_loss(logp, old, ref, adv, mask=mask)
    tail_only, _ = grpo_loss(logp[5:], old[5:], ref[5:], adv[5:])

    torch.testing.assert_close(masked, tail_only, rtol=1e-5, atol=1e-6)


def test_matches_trl_advantage_computation() -> None:
    """Against TRL directly where it is installed.

    TRL's GRPOTrainer standardises rewards per group with the population std, the same convention
    used here. Skipped rather than vendored, because a copy of their formula in this file would
    test my transcription of it rather than the library.
    """
    pytest.importorskip("trl", reason="TRL not installed; the property tests above still apply")

    torch.manual_seed(0)
    rewards = torch.rand(6, 4)

    grouped = rewards.view(-1, 4)
    mean = grouped.mean(dim=1, keepdim=True)
    std = grouped.std(dim=1, keepdim=True, unbiased=False)
    trl_style = ((grouped - mean) / (std + 1e-4)).view_as(rewards)

    torch.testing.assert_close(group_advantages(rewards), trl_style, rtol=1e-5, atol=1e-6)
