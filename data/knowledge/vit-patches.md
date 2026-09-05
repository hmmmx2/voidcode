---
title: A vision transformer is a transformer over image patches
concept_id: vision_transformer
source_name: Dosovitskiy et al., An Image is Worth 16x16 Words
source_url: https://arxiv.org/abs/2010.11929
published_at: 2020-10-22
---

A ViT cuts an image into fixed-size patches, projects each to an embedding, adds a position
embedding, and runs a standard transformer encoder. A 224x224 image at patch size 16 gives 196
tokens; at patch size 14 it gives 256.

Token count scales with the square of the resolution divided by the patch size, and attention scales
with the square of the token count, so resolution is expensive twice over. This is the arithmetic
behind every high-resolution VLM tiling scheme.

Unlike a convolution, a ViT has no built-in locality or translation bias, so it needs more data or
stronger augmentation to reach comparable accuracy. Position embeddings are learned per patch grid,
which is why changing input resolution requires interpolating them rather than simply resizing the
image.
