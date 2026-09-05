---
title: CLIP learns a shared space with a symmetric contrastive loss
concept_id: contrastive_pretraining
source_name: Radford et al., Learning Transferable Visual Models (CLIP)
source_url: https://arxiv.org/abs/2103.00020
published_at: 2021-02-26
---

CLIP trains an image encoder and a text encoder so that matching pairs are close and
non-matching pairs are far apart, using the other items in the batch as negatives. The loss is
symmetric: image-to-text and text-to-image cross-entropy over the similarity matrix.

Because the negatives come from the batch, the loss quality depends on batch size, and the batch must
be gathered across data-parallel ranks to compute the softmax denominator. Memory grows with the
square of the global batch, which is why very large batches are both necessary and expensive.

The resulting shared space enables zero-shot classification by embedding class names as text and
ranking them against an image. It also exhibits a modality gap: image and text embeddings occupy
separate cones rather than intermingling, so absolute cosine values are not comparable across
modalities.
