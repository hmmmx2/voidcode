"""Sharded checkpoint save/resume, via `torch.distributed.checkpoint`.

Sharded rather than "rank 0 gathers everything and calls torch.save", because gathering a
full-parameter 7.6B model onto one rank to write it is the thing that makes checkpointing a memory
event as well as an I/O one -- and under ZeRO-3 or FSDP2 `FULL_SHARD` no rank holds the full model
to begin with.

WHAT MUST SURVIVE, AND WHY EACH ONE
-----------------------------------
  model      -- obvious.
  optimizer  -- momentum and second moments. Restoring weights without optimizer state produces a
                curve that recovers over a few dozen steps and looks like normal noise, which is
                the failure mode that ships.
  step       -- the batch is a pure function of (seed, step), so this single integer *is* the
                dataloader state. See `trainer.py`: that is the reason it was built that way.

There is deliberately no RNG state here. Nothing in the training path consumes global RNG -- the
corpus is seeded per step and the model has no dropout -- so saving it would imply a guarantee this
code does not actually depend on. If dropout is ever added, this comment stops being true and the
resume test starts failing, which is the correct order of events.
"""
from __future__ import annotations

import json
from pathlib import Path

import torch
import torch.distributed as dist
import torch.distributed.checkpoint as dcp
from torch.distributed.checkpoint.state_dict import (
    StateDictOptions,
    get_state_dict,
    set_state_dict,
)

#: Written beside the shards. `dcp` handles tensors; the step counter is a plain int and round-trips
#: more legibly as JSON than as a 0-d tensor nobody can read with `cat`.
META = "meta.json"


def _options() -> StateDictOptions:
    # CPU offload keeps the save from needing a second copy of the model in VRAM, which is the
    # whole point of checkpointing being cheap enough to do often.
    return StateDictOptions(full_state_dict=False, cpu_offload=True)


def save(state, path: str | Path) -> Path:
    """Write model + optimizer shards and the step counter."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)

    model_sd, optim_sd = get_state_dict(state.model, state.optimizer, options=_options())
    dcp.save({"model": model_sd, "optimizer": optim_sd}, checkpoint_id=str(path))

    # One writer, after the shards are down: a meta file that exists is the signal the checkpoint
    # is complete. A reader that finds shards but no meta knows it caught a half-written one.
    if not dist.is_initialized() or dist.get_rank() == 0:
        (path / META).write_text(json.dumps({"step": state.step}), encoding="utf-8")
    if dist.is_initialized():
        dist.barrier()
    return path


def load(state, path: str | Path) -> int:
    """Restore in place and return the step to resume at."""
    path = Path(path)
    meta_file = path / META
    if not meta_file.exists():
        raise FileNotFoundError(
            f"{meta_file} is missing. Either nothing was saved here, or the process died between "
            f"writing the shards and writing the meta -- in which case this checkpoint is "
            f"incomplete and resuming from it would silently rewind the optimizer."
        )

    model_sd, optim_sd = get_state_dict(state.model, state.optimizer, options=_options())
    payload = {"model": model_sd, "optimizer": optim_sd}
    dcp.load(payload, checkpoint_id=str(path))
    set_state_dict(
        state.model,
        state.optimizer,
        model_state_dict=payload["model"],
        optim_state_dict=payload["optimizer"],
        options=_options(),
    )

    state.step = json.loads(meta_file.read_text(encoding="utf-8"))["step"]
    return state.step


def is_complete(path: str | Path) -> bool:
    """Whether a checkpoint directory holds a finished checkpoint rather than a corpse."""
    return (Path(path) / META).exists()


def latest(root: str | Path) -> Path | None:
    """The newest *complete* checkpoint under `root`, or None.

    Ignores incomplete ones rather than failing on them, because a crash mid-save is exactly the
    situation this whole module exists for: the run should fall back to the last good checkpoint,
    not refuse to start.
    """
    root = Path(root)
    if not root.is_dir():
        return None
    candidates = [d for d in root.iterdir() if d.is_dir() and is_complete(d)]
    if not candidates:
        return None
    return max(candidates, key=lambda d: json.loads((d / META).read_text(encoding="utf-8"))["step"])
