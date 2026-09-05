"""A small, exactly reproducible training loop — the thing `MemoryGuard` and `packing` plug into.

Both of those modules were written, tested, CI-gated, and **never called by anything**. Porting
them into this repo without wiring them in would have repeated that exactly, so this is the caller.

THE ONE DESIGN DECISION THAT MATTERS
------------------------------------
**The batch at step k is derived from (seed, k) and nothing else.** Not from a stateful iterator,
not from a sampler that advances as it is consumed.

That is what makes resume-after-a-crash provable rather than hopeful. With a stateful iterator, a
run that resumes at step 12 gets the same data only if the iterator's RNG was checkpointed and
restored perfectly; miss it and the loss curve diverges in a way that looks like a training bug
rather than a checkpoint bug. With step-indexed batching there is no iterator state to lose, so
"resumed at 12" and "never stopped" are the same computation by construction.

It also happens to be what elastic training needs: a run must not depend on how many times it was
restarted, or on how many ranks were alive when it was.

Everything here is CPU-first on purpose. The loop is small enough to be exact in float64, so the
fault-tolerance guarantee can be *asserted* here for free rather than debugged later on a metered
pod. Swapping in a real model and CUDA changes the scale, not the control flow.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch

from .collate import packed_inputs
from .memory_guard import MemoryGuard
from .numerics.reference import TinyCausalLM, TinyConfig
from .packing import pack, packing_efficiency


@dataclass
class TrainConfig:
    steps: int = 12
    lr: float = 0.05
    momentum: float = 0.9
    seed: int = 0
    capacity: int = 64
    docs_per_step: int = 6
    min_doc_len: int = 3
    max_doc_len: int = 12
    prompt_tokens: int = 2
    dtype: torch.dtype = torch.float64
    model: TinyConfig = field(default_factory=TinyConfig)


def batch_for_step(cfg: TrainConfig, step: int) -> list:
    """The corpus for one step, a pure function of (seed, step).

    Seeded per step rather than per run. Two processes that have never spoken, at different points
    in their lives, produce the same batch for the same step -- which is the property the resume
    test rests on.
    """
    rng = np.random.default_rng([cfg.seed, step])
    lengths = rng.integers(cfg.min_doc_len, cfg.max_doc_len + 1, size=cfg.docs_per_step)
    docs = [rng.integers(1, cfg.model.vocab_size, size=int(n), dtype=np.int64) for n in lengths]
    # Prompt tokens carry no loss: a code model trained on its own prompts learns to reproduce
    # instructions rather than answer them.
    masks = [np.arange(len(d)) >= cfg.prompt_tokens for d in docs]
    return pack(docs, masks, capacity=cfg.capacity)


@dataclass
class TrainState:
    model: TinyCausalLM
    optimizer: torch.optim.Optimizer
    step: int = 0

    def state_dict(self) -> dict:
        return {
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "step": self.step,
        }

    def load_state_dict(self, payload: dict) -> None:
        self.model.load_state_dict(payload["model"])
        self.optimizer.load_state_dict(payload["optimizer"])
        self.step = payload["step"]


def build_state(cfg: TrainConfig) -> TrainState:
    torch.manual_seed(cfg.seed)
    model = TinyCausalLM(cfg.model).to(cfg.dtype)
    # **Momentum, deliberately.** Plain SGD has no optimizer state, which would make the resume
    # test look strong while proving only that weights round-trip -- the checkpoint could drop
    # optimizer state entirely and the curve would still match. Momentum is stateful enough to
    # make that failure visible and deterministic enough to keep the assertion exact.
    # `test_resume_needs_the_optimizer_state_too` is the proof that it is visible.
    return TrainState(
        model=model,
        optimizer=torch.optim.SGD(model.parameters(), lr=cfg.lr, momentum=cfg.momentum),
    )


def train(
    state: TrainState,
    cfg: TrainConfig,
    until: int | None = None,
    guard: MemoryGuard | None = None,
    on_step=None,
) -> list[float]:
    """Run from `state.step` to `until`, returning the loss at each step.

    `guard` is a real `MemoryGuard`; on CPU it constructs disabled and every stage is a no-op, so
    the training code needs no branching and the GPU path is not a separate, untested code path.
    """
    guard = guard or MemoryGuard.for_current_device()
    target = cfg.steps if until is None else until
    losses: list[float] = []

    while state.step < target:
        batches = batch_for_step(cfg, state.step)
        step_loss = 0.0
        n_tokens = 0

        for batch in batches:
            inputs = packed_inputs(batch, dtype=cfg.dtype)

            with guard.stage("forward"):
                _, loss = state.model(
                    inputs["input_ids"], inputs["position_ids"], inputs["mask"], inputs["labels"]
                )
            with guard.stage("backward"):
                loss.backward()

            step_loss += float(loss.detach())
            n_tokens += int((inputs["labels"] != -100).sum())

        with guard.stage("optimizer"):
            state.optimizer.step()
            state.optimizer.zero_grad(set_to_none=True)

        guard.check(state.step)

        # Per-token, so the number is comparable across steps whose packing differed.
        mean_loss = step_loss / max(n_tokens, 1)
        losses.append(mean_loss)

        # Advance *before* the callback, so that inside it `state.step` is already the step this
        # run should resume at. A checkpoint written from the callback is then correct with no
        # arithmetic at the call site -- and "off by one on resume" is a bug that reproduces as a
        # single repeated training step, which is invisible in a loss curve.
        completed, state.step = state.step, state.step + 1
        if on_step is not None:
            on_step(completed, mean_loss)

    return losses


def efficiency_report(cfg: TrainConfig, steps: int = 50) -> dict:
    """What packing bought on this corpus, measured rather than asserted."""
    lengths = [len(d) for s in range(steps) for b in batch_for_step(cfg, s)
               for d in np.split(b.input_ids, b.cu_seqlens[1:-1])]
    return packing_efficiency(lengths, cfg.capacity)
