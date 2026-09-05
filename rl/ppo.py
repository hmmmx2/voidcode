"""PPO, as the comparison arm to GRPO.

`VOIDCODE_TRAINING_SPEC.md` §4.6 asks for this explicitly: the target job description names both,
and "a measured comparison of sample efficiency, memory, and wall clock between the two is a better
artifact than either alone."

WHAT ACTUALLY DIFFERS FROM GRPO, AND WHAT DOES NOT
----------------------------------------------------
The clipped surrogate is *identical*, so `rl.grpo.clipped_policy_loss` is reused rather than
copied. Reimplementing it here would let the two arms drift and turn a comparison of algorithms
into a comparison of two spellings of the same objective.

The whole difference is where the baseline comes from:

    GRPO   baseline = the mean reward of the group. No value network. Needs G completions per
           prompt, and a group with no spread carries no signal at all (a "dead group").
    PPO    baseline = a learned value function. One completion per prompt is enough, but you now
           carry a value head, its parameters, its optimizer state, and its own loss.

That is the real trade and it is what the comparison should report. GRPO buys memory by spending
samples; PPO buys samples by spending memory.

GAE, AND WHY THE TERMINAL-STATE HANDLING MATTERS HERE
-------------------------------------------------------
Rewards in this setting are **terminal only** — a completion is graded once it exists, so every
intermediate token has reward zero. That makes GAE degenerate to a discounted, bootstrapped
credit assignment over the token sequence, which is the point: it distributes a single end-of-
sequence reward back across the tokens that produced it, where GRPO gives every token in a
completion the same advantage.

`dones` therefore matters. Bootstrapping across a completion boundary would leak the value of one
sample into another's credit, and with terminal-only rewards that is the *only* signal there is.
"""
from __future__ import annotations

import torch

from .grpo import EPS, approx_kl, clipped_policy_loss


def gae_advantages(rewards: torch.Tensor, values: torch.Tensor, dones: torch.Tensor,
                   gamma: float = 1.0, lam: float = 0.95) -> tuple[torch.Tensor, torch.Tensor]:
    """Generalised advantage estimation. Returns (advantages, returns), both shaped like `rewards`.

    ``rewards``, ``values`` and ``dones`` are ``(T,)`` over one trajectory, or ``(B, T)`` over a
    batch of equal-length ones. ``dones[t]`` is 1.0 where the episode ends at ``t``.

    **gamma defaults to 1.0, not 0.99.** A completion is a few hundred tokens with a single reward
    at the end; discounting would systematically starve the early tokens of credit for a decision
    they are largely responsible for. Undiscounted is the right default for terminal-only rewards
    over short horizons, and it is exposed so the choice can be tested rather than assumed.

    Returns are ``advantages + values``, which is the standard target for the value head. Computing
    them here rather than at the call site keeps the two consistent by construction — a mismatch
    between the advantage and the value target is a bug that trains quietly in the wrong direction.
    """
    if rewards.shape != values.shape or rewards.shape != dones.shape:
        raise ValueError(
            f"rewards {tuple(rewards.shape)}, values {tuple(values.shape)} and dones "
            f"{tuple(dones.shape)} must all match")

    advantages = torch.zeros_like(rewards)
    running = torch.zeros_like(rewards[..., 0])
    for t in range(rewards.shape[-1] - 1, -1, -1):
        not_done = 1.0 - dones[..., t]
        next_value = values[..., t + 1] if t + 1 < values.shape[-1] else torch.zeros_like(running)
        # delta is the one-step TD error; `not_done` cuts the bootstrap at an episode boundary so
        # one completion's value never leaks into another's credit.
        delta = rewards[..., t] + gamma * next_value * not_done - values[..., t]
        running = delta + gamma * lam * not_done * running
        advantages[..., t] = running
    return advantages, advantages + values


def normalise_advantages(advantages: torch.Tensor, eps: float = EPS) -> torch.Tensor:
    """Standardise over the whole batch — the PPO convention, and NOT what GRPO does.

    GRPO standardises *within each group*, because each prompt is its own baseline. PPO has a value
    function for that job, so its normalisation is a variance-reduction step across the batch. The
    distinction is easy to blur when the two live in one repository, and blurring it would make the
    comparison meaningless.
    """
    flat = advantages.reshape(-1)
    return (advantages - flat.mean()) / (flat.std(unbiased=False) + eps)


def value_loss(values: torch.Tensor, returns: torch.Tensor, old_values: torch.Tensor | None = None,
               clip: float | None = 0.2) -> torch.Tensor:
    """Clipped value loss. Falls back to plain MSE when `old_values` or `clip` is absent.

    The clipped form takes the *larger* of the clipped and unclipped errors, which is deliberately
    pessimistic: it stops a single optimizer step from moving the value estimate so far that the
    advantages computed against it become stale.
    """
    unclipped = (values - returns) ** 2
    if old_values is None or clip is None:
        return unclipped.mean()
    clipped = (old_values + (values - old_values).clamp(-clip, clip) - returns) ** 2
    return torch.max(unclipped, clipped).mean()


def ppo_loss(logp: torch.Tensor, old_logp: torch.Tensor, ref_logp: torch.Tensor,
             advantages: torch.Tensor, values: torch.Tensor, returns: torch.Tensor,
             old_values: torch.Tensor | None = None, beta: float = 0.04,
             epsilon: float = 0.2, vf_coef: float = 0.5, entropy: torch.Tensor | None = None,
             ent_coef: float = 0.0, mask: torch.Tensor | None = None) -> tuple[torch.Tensor, dict]:
    """The full PPO objective: clipped surrogate + value loss + KL penalty - entropy bonus.

    The surrogate and the KL term are `rl.grpo`'s, unchanged, so the only difference between the
    two arms in this repository is the baseline. That is the comparison the spec asked for.
    """
    policy, stats = clipped_policy_loss(logp, old_logp, advantages, epsilon, mask)
    vloss = value_loss(values, returns, old_values, epsilon)
    kl = approx_kl(logp, ref_logp)
    kl_term = kl.mean() if mask is None else (kl * mask).sum() / mask.sum().clamp(min=1.0)

    total = policy + vf_coef * vloss + beta * kl_term
    if entropy is not None and ent_coef:
        total = total - ent_coef * entropy.mean()

    stats.update({
        "policy_loss": float(policy), "value_loss": float(vloss), "kl": float(kl_term),
        "beta": beta, "vf_coef": vf_coef,
        "entropy": float(entropy.mean()) if entropy is not None else None,
    })
    return total, stats
