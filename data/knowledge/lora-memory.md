---
title: LoRA shrinks optimizer state, not the model
concept_id: peft_lora
source_name: Hu et al., LoRA (ICLR 2022)
source_url: https://arxiv.org/abs/2106.09685
published_at: 2021-06-17
---

LoRA freezes the pretrained weight matrix and learns a low-rank update B @ A, where
A is rank x d_in and B is d_out x rank.

The memory saving is often misdescribed. Frozen weights still occupy memory, so the model does not
shrink. What shrinks is gradient and optimizer state — under AdamW roughly 12 bytes per trainable
parameter against 2 bytes for a frozen bf16 weight. That is why a model too large to fine-tune
fully will fit with LoRA.

B is initialised to zero, so the adapted model is identical to the base at step zero, and the
adapter can be merged into the weights after training with no inference latency added.
