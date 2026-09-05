"""PPO tests, written to pin the things that differ from GRPO.

The shared surrogate is already covered by `test_grpo.py`. What is untested elsewhere, and what
would silently train in the wrong direction if wrong, is GAE: the episode-boundary handling, the
value target, and the fact that PPO normalises across the batch where GRPO normalises within a
group.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rl.ppo import gae_advantages, normalise_advantages, ppo_loss, value_loss


def test_gae_with_a_perfect_value_function_gives_zero_advantage() -> None:
    """If the critic already predicts the return exactly, there is nothing to learn from."""
    rewards = torch.tensor([0.0, 0.0, 1.0])
    values = torch.tensor([1.0, 1.0, 1.0])        # undiscounted: every state is worth the 1.0
    dones = torch.tensor([0.0, 0.0, 1.0])
    adv, ret = gae_advantages(rewards, values, dones, gamma=1.0, lam=0.95)
    assert torch.allclose(adv, torch.zeros(3), atol=1e-6)
    assert torch.allclose(ret, values, atol=1e-6)  # returns collapse to the value estimate


def test_terminal_reward_propagates_back_to_earlier_tokens() -> None:
    """The whole point for this workload: one reward at the end must credit the tokens before it.

    GRPO gives every token in a completion the same advantage. GAE does not, and if the reward
    failed to propagate the early tokens would get no gradient at all.
    """
    rewards = torch.tensor([0.0, 0.0, 1.0])
    values = torch.zeros(3)
    dones = torch.tensor([0.0, 0.0, 1.0])
    adv, _ = gae_advantages(rewards, values, dones, gamma=1.0, lam=1.0)
    assert adv[0] > 0 and adv[1] > 0
    # With lam=1 and no discount, every token sees the full terminal reward.
    assert torch.allclose(adv, torch.ones(3), atol=1e-6)


def test_done_stops_the_bootstrap_across_an_episode_boundary() -> None:
    """The regression that matters. Without `dones`, one completion's value leaks into another's
    credit — and with terminal-only rewards that leaked value is the only signal there is."""
    rewards = torch.tensor([1.0, 0.0])
    values = torch.tensor([0.0, 99.0])            # the next episode is enormously valuable

    # lam=0, i.e. one-step TD. **Not lam=1**: at lam=1 GAE reduces to the Monte-Carlo return minus
    # the value, which by construction does not depend on intermediate values, so the bootstrap
    # cancels and both cases return 1.0. A first version of this test used lam=1 and could not
    # detect the very leak it was written for.
    ends = gae_advantages(rewards, values, torch.tensor([1.0, 1.0]), gamma=1.0, lam=0.0)[0]
    leaks = gae_advantages(rewards, values, torch.tensor([0.0, 1.0]), gamma=1.0, lam=0.0)[0]
    assert torch.allclose(ends[0], torch.tensor(1.0), atol=1e-6)   # cut: reward only
    assert leaks[0] > 50.0                                          # not cut: 99 bleeds in


def test_returns_are_always_advantages_plus_values() -> None:
    """The value head's target must match the advantage it was computed against. A mismatch here
    trains quietly in the wrong direction, which is why the function returns both."""
    torch.manual_seed(0)
    rewards, values = torch.randn(6), torch.randn(6)
    dones = torch.tensor([0.0, 0.0, 1.0, 0.0, 0.0, 1.0])
    adv, ret = gae_advantages(rewards, values, dones)
    assert torch.allclose(ret, adv + values, atol=1e-6)


def test_ppo_normalises_across_the_batch_not_within_groups() -> None:
    """PPO's normalisation is batch-wide; GRPO's is per group. Blurring the two would make the
    comparison between the arms meaningless."""
    adv = torch.tensor([[1.0, 2.0], [100.0, 200.0]])
    out = normalise_advantages(adv)
    assert abs(float(out.mean())) < 1e-6            # whole batch centred...
    assert abs(float(out[0].mean())) > 0.1          # ...but each row is NOT, unlike GRPO


def test_shape_mismatch_is_refused_rather_than_broadcast() -> None:
    with pytest.raises(ValueError, match="must all match"):
        gae_advantages(torch.zeros(4), torch.zeros(3), torch.zeros(4))


def test_clipped_value_loss_is_pessimistic() -> None:
    """Takes the larger of clipped and unclipped, so one step cannot move the critic so far that
    the advantages computed against it go stale."""
    values, returns, old = torch.tensor([5.0]), torch.tensor([0.0]), torch.tensor([0.0])
    clipped = value_loss(values, returns, old, clip=0.2)
    plain = value_loss(values, returns, None, None)

    # Pessimistic means it takes the LARGER of the two errors, so here it keeps the unclipped 25.0
    # rather than the clipped (0 + 0.2 - 0)^2 = 0.04. Asserting 0.04 would have been asserting that
    # clipping lets the critic off, which is the opposite of what it is for.
    assert float(plain) == pytest.approx(25.0, abs=1e-6)
    assert float(clipped) == pytest.approx(25.0, abs=1e-6)

    # Where clipping actually bites: the unclipped error is the SMALLER one, so the clipped term
    # wins and the loss is raised rather than lowered.
    v2, r2, o2 = torch.tensor([0.1]), torch.tensor([0.0]), torch.tensor([-5.0])
    assert float(value_loss(v2, r2, o2, clip=0.2)) > float(value_loss(v2, r2, None, None))


def test_ppo_loss_runs_and_reports_both_components() -> None:
    torch.manual_seed(0)
    n = 8
    logp = torch.randn(n, requires_grad=True)
    total, stats = ppo_loss(logp, logp.detach(), torch.randn(n), torch.randn(n),
                            torch.randn(n), torch.randn(n))
    total.backward()
    assert logp.grad is not None
    assert "policy_loss" in stats and "value_loss" in stats and "kl" in stats


def test_zero_advantage_still_trains_the_critic() -> None:
    """The structural difference from GRPO. A GRPO group with no spread contributes nothing at all;
    PPO with zero advantage still has a value loss, so the sample is not wasted."""
    n = 4
    logp = torch.zeros(n, requires_grad=True)
    total, stats = ppo_loss(logp, logp.detach(), torch.zeros(n), torch.zeros(n),
                            torch.full((n,), 0.5), torch.ones(n))
    total.backward()
    assert stats["value_loss"] > 0.0
    assert float(total) != 0.0
