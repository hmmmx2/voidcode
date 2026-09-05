"""Multipack sequence packing with block-diagonal attention.

Blueprint §3.6. Instruct corpora are length-skewed — median length is typically far below
`max_seq_length`, so naive padding wastes 30-50% of every batch. Packing recovers that as
throughput.

The correctness trap: concatenating documents into one sequence lets document B attend to
document A and teaches the model cross-document continuation. Two things address it.

  1. Block-diagonal attention, expressed as `cu_seqlens` for FlashAttention-2 varlen.
     Without it the mask is causal over the whole buffer, which is wrong.
  2. position_ids RESET at every document boundary. A packed sequence is not one
     document of length 4096; it is k documents whose positions restart at 0.

**Only the first is required for correctness, and this file used to claim both were.**
`tests/test_packing_equivalence.py` measures it: packed and unpacked gradients agree exactly,
and they still agree when position_ids run 0..N across the buffer, or when every document is
shifted by +1000. RoPE is a *relative* encoding -- the score between i and j depends only on
(i - j) -- so once the mask stops attention crossing a boundary, the offset a document starts
at is unobservable. Removing the mask changes the loss; removing the reset does not.

Reset anyway, for three reasons that are not "the gradients are wrong":
  - absolute or learned position embeddings *do* observe the offset, and the same test asserts
    that on a learned-embedding model;
  - it is defence in depth for the case where the mask is wrong, which is the failure that
    actually matters;
  - under RoPE scaling, a short document landing near the context limit sits in a rotation
    regime it would never meet at inference.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

IGNORE_INDEX = -100


@dataclass
class PackedBatch:
    """One packed sequence. Field names match FlashAttention-2 varlen conventions."""

    input_ids: np.ndarray        # (total_tokens,)
    labels: np.ndarray           # (total_tokens,) IGNORE_INDEX where masked
    position_ids: np.ndarray     # (total_tokens,) restarts at 0 per document
    cu_seqlens: np.ndarray       # (n_docs + 1,) int32 cumulative boundaries
    doc_ids: np.ndarray          # (total_tokens,) source document index, for debugging

    @property
    def n_docs(self) -> int:
        return len(self.cu_seqlens) - 1

    @property
    def n_tokens(self) -> int:
        return len(self.input_ids)

    def attention_mask_4d(self) -> np.ndarray:
        """Materialise the block-diagonal causal mask. Reference and test oracle only.

        Never call this in a training loop — it is O(n^2) in sequence length and exists
        so the FlashAttention varlen path can be checked against something explicit.
        """
        n = self.n_tokens
        same_doc = self.doc_ids[:, None] == self.doc_ids[None, :]
        causal = np.tril(np.ones((n, n), dtype=bool))
        return same_doc & causal


def first_fit_decreasing(lengths: list[int], capacity: int) -> list[list[int]]:
    """Bin-pack document indices into sequences of at most `capacity` tokens.

    First-fit-decreasing, not optimal (bin packing is NP-hard) but within ~11/9 of it and
    O(n log n). At corpus scale the difference from an exact solver is noise against the
    30-50% recovered from padding.

    Documents longer than `capacity` are returned in their own bin; truncation is a
    curation decision and does not belong in the packer.
    """
    if capacity <= 0:
        raise ValueError(f"capacity must be positive, got {capacity}")

    order = sorted(range(len(lengths)), key=lambda i: lengths[i], reverse=True)
    bins: list[list[int]] = []
    remaining: list[int] = []

    for idx in order:
        length = lengths[idx]
        if length <= 0:
            raise ValueError(f"document {idx} has non-positive length {length}")
        if length >= capacity:
            bins.append([idx])
            remaining.append(0)
            continue
        for b, space in enumerate(remaining):
            if space >= length:
                bins[b].append(idx)
                remaining[b] = space - length
                break
        else:
            bins.append([idx])
            remaining.append(capacity - length)
    return bins


def pack(documents: list[np.ndarray], label_masks: list[np.ndarray],
         capacity: int) -> list[PackedBatch]:
    """Pack tokenised documents into block-diagonal sequences.

    `documents[i]` is the token ids; `label_masks[i]` is True where the token should
    contribute to the loss. Prompt tokens are False — a code model trained on its own
    prompts learns to reproduce instructions.
    """
    if len(documents) != len(label_masks):
        raise ValueError(
            f"documents and label_masks differ: {len(documents)} vs {len(label_masks)}")
    for i, (d, m) in enumerate(zip(documents, label_masks, strict=True)):
        if len(d) != len(m):
            raise ValueError(f"document {i}: {len(d)} tokens but {len(m)} mask entries")

    lengths = [len(d) for d in documents]
    out: list[PackedBatch] = []

    for bin_indices in first_fit_decreasing(lengths, capacity):
        ids, labels, positions, docs = [], [], [], []
        cu = [0]
        for slot, doc_idx in enumerate(bin_indices):
            tokens = documents[doc_idx]
            mask = label_masks[doc_idx]
            ids.append(tokens)
            labels.append(np.where(mask, tokens, IGNORE_INDEX))
            # Restart positions per document — the half of the fix that gets forgotten.
            positions.append(np.arange(len(tokens), dtype=np.int32))
            docs.append(np.full(len(tokens), slot, dtype=np.int32))
            cu.append(cu[-1] + len(tokens))

        out.append(PackedBatch(
            input_ids=np.concatenate(ids),
            labels=np.concatenate(labels),
            position_ids=np.concatenate(positions),
            cu_seqlens=np.asarray(cu, dtype=np.int32),
            doc_ids=np.concatenate(docs),
        ))
    return out


def packing_efficiency(lengths: list[int], capacity: int) -> dict:
    """Report what packing bought, so the claim is measured rather than assumed."""
    bins = first_fit_decreasing(lengths, capacity)
    total_tokens = sum(lengths)
    padded_naive = len(lengths) * capacity
    packed_capacity = len(bins) * capacity
    return {
        "documents": len(lengths),
        "sequences_naive": len(lengths),
        "sequences_packed": len(bins),
        "utilisation_naive": round(total_tokens / padded_naive, 4),
        "utilisation_packed": round(total_tokens / packed_capacity, 4),
        "speedup": round(padded_naive / packed_capacity, 3),
        "median_doc_len": int(np.median(lengths)),
        "capacity": capacity,
    }
