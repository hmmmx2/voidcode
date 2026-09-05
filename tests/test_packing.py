"""Contracts for multipack packing.

These assert the two properties that silently degrade a fine-tune when violated:
positions restart per document, and no token can attend across a document boundary.
"""
from __future__ import annotations

import numpy as np
import pytest

from training.packing import (
    IGNORE_INDEX,
    first_fit_decreasing,
    pack,
    packing_efficiency,
)


def make_docs(lengths, seed=0):
    rng = np.random.default_rng(seed)
    docs = [rng.integers(10, 1000, size=n, dtype=np.int64) for n in lengths]
    # First 30% of each document is prompt: masked out of the loss.
    masks = [np.arange(n) >= int(n * 0.3) for n in lengths]
    return docs, masks


class TestFirstFitDecreasing:
    def test_respects_capacity(self):
        lengths = [30, 40, 50, 60, 70, 15, 25]
        for b in first_fit_decreasing(lengths, capacity=100):
            assert sum(lengths[i] for i in b) <= 100

    def test_every_document_placed_exactly_once(self):
        lengths = [11, 22, 33, 44, 55, 66]
        placed = [i for b in first_fit_decreasing(lengths, 100) for i in b]
        assert sorted(placed) == list(range(len(lengths)))

    def test_oversized_document_gets_own_bin(self):
        # Truncation is a curation decision; the packer must not silently drop it.
        bins = first_fit_decreasing([150, 10, 20], capacity=100)
        assert [0] in bins

    def test_rejects_invalid_input(self):
        with pytest.raises(ValueError):
            first_fit_decreasing([10], capacity=0)
        with pytest.raises(ValueError):
            first_fit_decreasing([0, 10], capacity=100)


class TestPack:
    def test_position_ids_restart_per_document(self):
        """The half of the fix that is most often forgotten."""
        docs, masks = make_docs([20, 30, 25])
        for batch in pack(docs, masks, capacity=100):
            for d in range(batch.n_docs):
                lo, hi = batch.cu_seqlens[d], batch.cu_seqlens[d + 1]
                seg = batch.position_ids[lo:hi]
                assert seg[0] == 0, "positions must restart at 0 for each document"
                assert np.array_equal(seg, np.arange(hi - lo))

    def test_no_attention_across_document_boundary(self):
        """The property that makes packing correct rather than merely fast."""
        docs, masks = make_docs([15, 20, 10])
        for batch in pack(docs, masks, capacity=100):
            mask = batch.attention_mask_4d()
            for d in range(batch.n_docs):
                lo, hi = batch.cu_seqlens[d], batch.cu_seqlens[d + 1]
                # Nothing inside this document may attend outside it.
                assert not mask[lo:hi, :lo].any()
                assert not mask[lo:hi, hi:].any()

    def test_mask_is_causal_within_document(self):
        docs, masks = make_docs([12])
        batch = pack(docs, masks, capacity=100)[0]
        m = batch.attention_mask_4d()
        assert not np.triu(m, k=1).any(), "no token may attend to a future token"
        assert m.diagonal().all(), "every token attends to itself"

    def test_cu_seqlens_well_formed(self):
        docs, masks = make_docs([20, 30, 25, 15])
        for batch in pack(docs, masks, capacity=100):
            cu = batch.cu_seqlens
            assert cu[0] == 0
            assert cu[-1] == batch.n_tokens
            assert np.all(np.diff(cu) > 0), "boundaries must be strictly increasing"

    def test_prompt_tokens_excluded_from_loss(self):
        docs, masks = make_docs([40])
        batch = pack(docs, masks, capacity=100)[0]
        expected_masked = int(40 * 0.3)
        assert (batch.labels == IGNORE_INDEX).sum() == expected_masked

    def test_labels_match_inputs_where_unmasked(self):
        docs, masks = make_docs([30, 20])
        for batch in pack(docs, masks, capacity=100):
            keep = batch.labels != IGNORE_INDEX
            assert np.array_equal(batch.labels[keep], batch.input_ids[keep])

    def test_all_tokens_preserved(self):
        lengths = [20, 35, 15, 40]
        docs, masks = make_docs(lengths)
        packed = pack(docs, masks, capacity=100)
        assert sum(b.n_tokens for b in packed) == sum(lengths)

    def test_rejects_mismatched_masks(self):
        docs, masks = make_docs([10, 20])
        with pytest.raises(ValueError):
            pack(docs, masks[:1], capacity=100)
        with pytest.raises(ValueError):
            pack(docs, [np.ones(5, dtype=bool), masks[1]], capacity=100)


class TestEfficiency:
    def test_reports_gain_on_skewed_lengths(self):
        # Length-skewed instruct data: the case packing exists for.
        rng = np.random.default_rng(0)
        lengths = rng.integers(50, 600, size=500).tolist()
        stats = packing_efficiency(lengths, capacity=2048)
        assert stats["sequences_packed"] < stats["sequences_naive"]
        assert stats["utilisation_packed"] > stats["utilisation_naive"]
        assert stats["speedup"] > 3.0

    def test_no_false_gain_when_documents_already_fill(self):
        stats = packing_efficiency([2048] * 10, capacity=2048)
        assert stats["speedup"] == 1.0
