"""Turn packed numpy batches into model inputs, both the packed way and the naive way.

`packing.py` produces the pieces; this turns them into tensors a model consumes. It carries the
naive padded path too, because the only convincing evidence that packing is correct is that it
agrees with *not* packing -- and that comparison needs both sides built by code someone will
actually run, not one side written inside a test and never used again.

TWO ATTENTION PATHS, ON PURPOSE
-------------------------------
  varlen  -- ``cu_seqlens`` straight to FlashAttention-2. What training uses. Needs a GPU.
  mask    -- an explicit additive (n x n) block-diagonal mask. O(n^2) and CPU-friendly.

The mask path is not a fallback, it is the oracle. It is slow enough to be unusable at
`max_seq_length` and exact enough to prove the fast path right, which is the correct division of
labour between the two.
"""
from __future__ import annotations

import numpy as np
import torch

from .packing import IGNORE_INDEX, PackedBatch

NEG_INF = float("-inf")


def block_diagonal_mask(doc_ids: torch.Tensor, dtype: torch.dtype = torch.float64) -> torch.Tensor:
    """Additive mask: 0 where a token may attend, -inf where it may not.

    Two conditions, and dropping either is a real bug rather than a slow path:

      same document  -- without it, document B attends to document A and the model learns
                        cross-document continuation. This is the failure packing exists to avoid.
      causal         -- without it, every position sees the future.

    Additive rather than boolean so that a fully-masked row would produce NaN immediately instead
    of quietly softmaxing over positions it was not allowed to see.
    """
    if doc_ids.ndim != 2:
        raise ValueError(f"doc_ids must be (batch, seq), got shape {tuple(doc_ids.shape)}")

    same_doc = doc_ids[:, :, None] == doc_ids[:, None, :]
    causal = torch.tril(torch.ones(doc_ids.shape[1], doc_ids.shape[1], dtype=torch.bool))
    allowed = same_doc & causal
    return torch.where(allowed, 0.0, NEG_INF).to(dtype)[:, None, :, :]


def packed_inputs(batch: PackedBatch, dtype: torch.dtype = torch.float64) -> dict[str, torch.Tensor]:
    """One `PackedBatch` as a batch of size 1. Keeps `cu_seqlens` for the varlen path."""
    return {
        "input_ids": torch.from_numpy(batch.input_ids.astype(np.int64))[None, :],
        "labels": torch.from_numpy(batch.labels.astype(np.int64))[None, :],
        "position_ids": torch.from_numpy(batch.position_ids.astype(np.int64))[None, :],
        "mask": block_diagonal_mask(torch.from_numpy(batch.doc_ids.astype(np.int64))[None, :], dtype),
        "cu_seqlens": torch.from_numpy(batch.cu_seqlens.astype(np.int32)),
    }


def padded_inputs(
    documents: list[np.ndarray],
    label_masks: list[np.ndarray],
    dtype: torch.dtype = torch.float64,
) -> dict[str, torch.Tensor]:
    """The naive path: one document per row, right-padded, plain causal mask.

    This is what packing replaces, and what it must agree with. Padding is masked out of both
    attention and the loss, so the padding token id is arbitrary -- 0 is used and never read.
    """
    if len(documents) != len(label_masks):
        raise ValueError(f"documents and label_masks differ: {len(documents)} vs {len(label_masks)}")

    width = max(len(d) for d in documents)
    n = len(documents)

    input_ids = torch.zeros(n, width, dtype=torch.int64)
    labels = torch.full((n, width), IGNORE_INDEX, dtype=torch.int64)
    position_ids = torch.zeros(n, width, dtype=torch.int64)
    real = torch.zeros(n, width, dtype=torch.bool)

    for row, (doc, keep) in enumerate(zip(documents, label_masks, strict=True)):
        length = len(doc)
        input_ids[row, :length] = torch.from_numpy(doc.astype(np.int64))
        labels[row, :length] = torch.from_numpy(np.where(keep, doc, IGNORE_INDEX).astype(np.int64))
        position_ids[row, :length] = torch.arange(length, dtype=torch.int64)
        real[row, :length] = True

    causal = torch.tril(torch.ones(width, width, dtype=torch.bool))
    # A padded column must never be attended to, or the padded rows and the packed sequence would
    # compute different things and the comparison would be measuring padding, not packing.
    allowed = causal[None, :, :] & real[:, None, :]
    mask = torch.where(allowed, 0.0, NEG_INF).to(dtype)[:, None, :, :]

    return {"input_ids": input_ids, "labels": labels, "position_ids": position_ids, "mask": mask}
