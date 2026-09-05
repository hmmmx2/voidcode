"""The one assertion that proves packing is correct: it must equal not packing.

`packing.py` names the trap in its own docstring — emitting `cu_seqlens` while forgetting to reset
`position_ids` "trains without error and degrades quality in a way no loss curve reveals". Neither
half of that fix can be verified by inspecting the packed arrays, because both halves produce
arrays that *look* right.

So: run k documents through a model as one packed sequence, run the same k documents through the
same model as k padded rows, and require the **loss and every gradient to agree**. If attention
leaks across a document boundary, or if positions run 0..N across the buffer instead of restarting
per document, the two disagree. This is the whole test, and it is exact rather than approximate —
float64, sum reduction, and a tolerance set for accumulated rounding, not for hidden differences.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch", reason="the numerics oracle needs torch")

from training.collate import block_diagonal_mask, packed_inputs, padded_inputs  # noqa: E402
from training.numerics.reference import TinyConfig, deterministic_model  # noqa: E402
from training.packing import pack  # noqa: E402

# Deliberately uneven lengths: equal-length documents would let an off-by-one in position handling
# cancel out, and a single document would not exercise the boundary at all.
DOC_LENGTHS = [7, 5, 3, 9, 4]
CAPACITY = 32


def corpus(seed: int = 11) -> tuple[list[np.ndarray], list[np.ndarray]]:
    rng = np.random.default_rng(seed)
    docs = [rng.integers(1, 64, size=n, dtype=np.int64) for n in DOC_LENGTHS]
    # Mask the first two tokens of each document, as a prompt would be. Uniform-True masks would
    # hide a labels-alignment bug, since every position would contribute either way.
    masks = [np.arange(n) >= 2 for n in DOC_LENGTHS]
    return docs, masks


def grads_of(model, inputs) -> dict[str, torch.Tensor]:
    model.zero_grad(set_to_none=True)
    _, loss = model(inputs["input_ids"], inputs["position_ids"], inputs["mask"], inputs["labels"])
    loss.backward()
    return loss.detach().clone(), {n: p.grad.detach().clone() for n, p in model.named_parameters()}


def test_packed_and_unpacked_agree_exactly() -> None:
    docs, masks = corpus()
    batches = pack(docs, masks, capacity=CAPACITY)
    assert len(batches) == 1, "this fixture is meant to land in one bin; adjust CAPACITY if not"

    model = deterministic_model(seed=3, cfg=TinyConfig())

    packed_loss, packed_grads = grads_of(model, packed_inputs(batches[0]))
    padded_loss, padded_grads = grads_of(model, padded_inputs(docs, masks))

    # Sum reduction on both sides, and the same tokens contribute on both — so this is equality,
    # not a normalisation coincidence.
    torch.testing.assert_close(packed_loss, padded_loss, rtol=1e-10, atol=1e-10)

    assert packed_grads.keys() == padded_grads.keys()
    for name in packed_grads:
        torch.testing.assert_close(
            packed_grads[name], padded_grads[name], rtol=1e-9, atol=1e-9,
            msg=lambda s, n=name: f"gradient mismatch in {n}\n{s}",
        )


def test_the_check_fails_when_attention_leaks_across_documents() -> None:
    """Prove the test can fail. A causal-only mask is exactly the bug it is meant to catch."""
    docs, masks = corpus()
    batch = pack(docs, masks, capacity=CAPACITY)[0]
    model = deterministic_model(seed=3, cfg=TinyConfig())

    inputs = packed_inputs(batch)
    n = inputs["input_ids"].shape[1]
    # Drop the same-document condition, keep causal: documents now see their predecessors.
    leaky = torch.where(torch.tril(torch.ones(n, n, dtype=torch.bool)), 0.0, float("-inf"))
    inputs["mask"] = leaky.to(torch.float64)[None, None, :, :]

    leaked_loss, _ = grads_of(model, inputs)
    correct_loss, _ = grads_of(model, packed_inputs(batch))

    assert not torch.isclose(leaked_loss, correct_loss, rtol=1e-6), (
        "a mask that leaks across documents produced the same loss as a correct one — "
        "the equivalence test above would not catch the bug it exists for"
    )


# ── what the position_ids reset actually buys, measured rather than assumed ───────────────────
#
# `packing.py` says the mask and the position reset are both "required". Measurement says that is
# true of the mask and **not** true of the reset under RoPE. RoPE is a *relative* encoding: the
# score between i and j depends only on (i - j). Once the block-diagonal mask stops attention
# crossing a document boundary, the offset a document happens to start at is unobservable —
# running 0..N and a uniform +1000 shift both give a bit-identical loss.
#
# The reset is still right to do: required for absolute encodings, defence in depth if the mask is
# ever wrong, and under RoPE scaling a short document landing near the context limit sits in a
# rotation regime it would never meet at inference. But "required for correctness here" was too
# strong, so both halves are now pinned by tests that say which is which.


def test_rope_makes_a_documents_starting_offset_invisible() -> None:
    """Relative encoding + correct mask: only *within*-document offsets can matter."""
    docs, masks = corpus()
    batch = pack(docs, masks, capacity=CAPACITY)[0]
    model = deterministic_model(seed=3, cfg=TinyConfig(pos_encoding="rope"))

    correct, _ = grads_of(model, packed_inputs(batch))

    for label, positions in [
        ("running 0..N", torch.arange(batch.n_tokens, dtype=torch.int64)[None, :]),
        ("every document shifted +1000", packed_inputs(batch)["position_ids"] + 1000),
    ]:
        inputs = packed_inputs(batch)
        inputs["position_ids"] = positions
        loss, _ = grads_of(model, inputs)
        torch.testing.assert_close(
            loss, correct, rtol=1e-12, atol=1e-12,
            msg=lambda s, lbl=label: f"{lbl} changed the loss; RoPE should make it invisible\n{s}",
        )

    # A permutation *inside* a document is a real change. Without this the assertions above would
    # also pass on a model that ignored position_ids entirely.
    inputs = packed_inputs(batch)
    scrambled = inputs["position_ids"].clone()
    scrambled[0, :7] = torch.tensor([3, 1, 0, 6, 2, 5, 4])
    inputs["position_ids"] = scrambled
    scrambled_loss, _ = grads_of(model, inputs)
    assert not torch.isclose(scrambled_loss, correct, rtol=1e-6), (
        "scrambling positions within a document changed nothing — the model ignores position_ids "
        "and every assertion above is vacuous"
    )


def test_position_reset_is_required_for_absolute_encodings() -> None:
    """Swap RoPE for a learned absolute embedding and the reset becomes load-bearing.

    Same corpus, same mask, same everything else — the encoding is the only difference, which is
    what makes this the control for the test above rather than a separate anecdote.
    """
    docs, masks = corpus()
    batch = pack(docs, masks, capacity=CAPACITY)[0]
    model = deterministic_model(seed=3, cfg=TinyConfig(pos_encoding="learned"))

    correct, _ = grads_of(model, packed_inputs(batch))

    inputs = packed_inputs(batch)
    inputs["position_ids"] = torch.arange(batch.n_tokens, dtype=torch.int64)[None, :]
    running, _ = grads_of(model, inputs)

    assert not torch.isclose(running, correct, rtol=1e-6), (
        "with an absolute position embedding, positions running 0..N must differ from "
        "per-document positions — if they do not, the embedding is not being applied"
    )


def test_mask_matches_the_packing_module_oracle() -> None:
    """`PackedBatch.attention_mask_4d` is documented as the reference. Agree with it."""
    docs, masks = corpus()
    batch = pack(docs, masks, capacity=CAPACITY)[0]

    ours = block_diagonal_mask(torch.from_numpy(batch.doc_ids.astype(np.int64))[None, :])
    theirs = torch.from_numpy(batch.attention_mask_4d())

    assert torch.equal(ours[0, 0] == 0.0, theirs)


def test_padding_is_never_attended_to() -> None:
    """If a padded column were visible, the comparison would measure padding, not packing."""
    docs, masks = corpus()
    inputs = padded_inputs(docs, masks)

    for row, length in enumerate(DOC_LENGTHS):
        visible = inputs["mask"][row, 0] == 0.0
        assert not visible[:, length:].any(), f"row {row} can attend to padding"
        # And every real token can still see itself, or the mask is simply broken.
        assert visible[torch.arange(length), torch.arange(length)].all()
