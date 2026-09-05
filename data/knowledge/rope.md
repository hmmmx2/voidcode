---
title: Rotary position embeddings encode relative position
concept_id: positional_encoding
source_name: Su et al., RoFormer (2021)
source_url: https://arxiv.org/abs/2104.09864
published_at: 2021-04-20
---

RoPE rotates query and key vectors by an angle proportional to absolute position.
Because the attention score depends on the product of a query and a key, the absolute rotations
cancel and only the difference in position remains.

That makes it a relative encoding implemented through absolute rotations, with no learned position
parameters and no additive bias term.

One practical consequence: with a correct block-diagonal attention mask, packing several documents
into one sequence does not require resetting position ids per document. The offsets cancel in the
same way, so the model sees the same relative distances it would in an unpacked batch.
