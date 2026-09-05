---
title: GRPO removes the value network by normalising within a group
concept_id: rlhf_grpo
source_name: Shao et al., DeepSeekMath
source_url: https://arxiv.org/abs/2402.03300
published_at: 2024-02-05
---

PPO estimates an advantage using a learned value network, which is a second model of comparable
size to train and hold in memory. GRPO samples a group of completions for the same prompt and uses
the group's own reward mean and standard deviation as the baseline, so the advantage is available
without a critic.

That works when the reward is verifiable and cheap, which is why it suits code and mathematics: unit
tests or an answer check give a reward per completion with no reward model to train or calibrate.

The characteristic failure is a dead group. If every completion in a group scores identically the
advantage is zero for all of them and the gradient vanishes, so a prompt that is uniformly too easy
or too hard contributes nothing. The dead-group rate is therefore a required diagnostic, and a reward
curve reported without it is uninterpretable.
