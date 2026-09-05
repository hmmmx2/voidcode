"""GRPO's arithmetic, as pure functions, so it can be checked against TRL rather than trusted.

The plan says to write the loop rather than call `GRPOTrainer`, and then validate against it. That
only means something if the pieces are separable — a loop that computes advantages inside a training
step can only be checked by running a training step. These are functions over tensors.

WHAT GRPO ACTUALLY IS
---------------------
For each prompt, sample a **group** of G completions. Score them. The advantage of a completion is
how much better it was **than its own group**:

    A_i = (r_i - mean(r)) / (std(r) + eps)

There is no value network. The group *is* the baseline, which is the whole idea, and it is also the
failure mode: **if every completion in a group scores the same, std is zero and every advantage is
zero.** That group contributes no gradient. It is called a dead group, and on a 60-problem set with
a small policy it is the thing most likely to make training do nothing while the loss curve looks
perfectly reasonable.

So `dead_group_rate` is not diagnostics-as-nice-to-have. It is the number that says whether the run
is learning at all, and it belongs beside reward on every plot.

THE KL ESTIMATOR
----------------
GRPO regularises toward a reference policy. The k3 estimator is used rather than the naive
`logp - ref_logp` because k3 is **non-negative and lower variance**:

    k3 = exp(ref_logp - logp) - (ref_logp - logp) - 1

The naive difference is an unbiased estimate of the KL but can go negative on a sample, which makes
a "KL penalty" that occasionally pays the policy to move away. k3 cannot.
"""
from __future__ import annotations

import torch

EPS = 1e-4


def group_advantages(rewards: torch.Tensor, eps: float = EPS,
                     normalise: bool = True) -> torch.Tensor:
    """Advantages within each group. ``rewards`` is ``(n_groups, group_size)``.

    Standardised per group, not globally: the point of GRPO is that each prompt is its own
    baseline, so a hard prompt where everything scored 0.2 and an easy one where everything scored
    0.9 both contribute according to their internal spread rather than their absolute level.

    A group with zero spread yields exactly zero advantages, which is correct — it carries no
    information about which completion was better — and is what `dead_group_rate` counts.
    """
    if rewards.ndim != 2:
        raise ValueError(f"rewards must be (n_groups, group_size), got {tuple(rewards.shape)}")
    if rewards.shape[1] < 2:
        raise ValueError("a group of one has no within-group baseline; GRPO needs G >= 2")

    centred = rewards - rewards.mean(dim=1, keepdim=True)
    if not normalise:
        return centred
    # Population std (unbiased=False): the group is the whole population being compared, not a
    # sample from a larger one. Using the sample std would inflate advantages for small G.
    std = rewards.std(dim=1, keepdim=True, unbiased=False)
    return centred / (std + eps)


def dead_group_rate(rewards: torch.Tensor, tol: float = 1e-8) -> float:
    """Fraction of groups whose completions all scored the same, so contribute no gradient.

    Watch this beside reward. A reward curve rising while the dead-group rate approaches 1 means
    the policy is being trained by an ever-shrinking handful of prompts.
    """
    if rewards.ndim != 2:
        raise ValueError(f"rewards must be (n_groups, group_size), got {tuple(rewards.shape)}")
    spread = rewards.max(dim=1).values - rewards.min(dim=1).values
    return float((spread <= tol).float().mean())


def approx_kl(logp: torch.Tensor, ref_logp: torch.Tensor) -> torch.Tensor:
    """The k3 estimator: ``exp(d) - d - 1`` where ``d = ref_logp - logp``.

    Non-negative by construction, which the naive ``logp - ref_logp`` is not.
    """
    d = ref_logp - logp
    return torch.exp(d) - d - 1.0


def clipped_policy_loss(
    logp: torch.Tensor,
    old_logp: torch.Tensor,
    advantages: torch.Tensor,
    epsilon: float = 0.2,
    mask: torch.Tensor | None = None,
) -> tuple[torch.Tensor, dict]:
    """PPO's clipped surrogate, which GRPO reuses. Returns ``(loss, stats)``.

    Negated because optimisers minimise: maximising ``min(r*A, clip(r)*A)`` is minimising its
    negative. The clip is what stops a single batch moving the policy arbitrarily far when the
    ratio is large, and `clip_fraction` in the stats is how you tell whether it is binding.
    """
    ratio = torch.exp(logp - old_logp)
    unclipped = ratio * advantages
    clipped = torch.clamp(ratio, 1.0 - epsilon, 1.0 + epsilon) * advantages
    per_token = -torch.min(unclipped, clipped)

    if mask is None:
        loss = per_token.mean()
        clip_frac = (unclipped > clipped).float().mean()
    else:
        denom = mask.sum().clamp(min=1.0)
        loss = (per_token * mask).sum() / denom
        clip_frac = ((unclipped > clipped).float() * mask).sum() / denom

    return loss, {
        "ratio_mean": float(ratio.mean()),
        "ratio_max": float(ratio.max()),
        "clip_fraction": float(clip_frac),
    }


def grpo_loss(
    logp: torch.Tensor,
    old_logp: torch.Tensor,
    ref_logp: torch.Tensor,
    advantages: torch.Tensor,
    beta: float = 0.04,
    epsilon: float = 0.2,
    mask: torch.Tensor | None = None,
) -> tuple[torch.Tensor, dict]:
    """The full objective: clipped surrogate plus a KL penalty toward the reference policy."""
    policy_loss, stats = clipped_policy_loss(logp, old_logp, advantages, epsilon, mask)
    kl = approx_kl(logp, ref_logp)
    kl_term = kl.mean() if mask is None else (kl * mask).sum() / mask.sum().clamp(min=1.0)

    stats.update({"policy_loss": float(policy_loss), "kl": float(kl_term), "beta": beta})
    return policy_loss + beta * kl_term, stats
