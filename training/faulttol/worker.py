"""A training process designed to be killed.

Run as a subprocess by `kill_test.py`. It resumes from the newest complete checkpoint under
`--dir`, trains to `--steps`, checkpoints after every step, and appends one JSON line per completed
step to `--log`.

The log line is written **after** the checkpoint and flushed immediately, and that ordering is the
contract: a line for step k means a complete checkpoint for step k exists on disk. Reversed, a
process killed in the gap would leave a log claiming progress it cannot resume from -- which is
precisely the bug this whole module exists to rule out, so it would be a poor thing to build into
the test harness.

Killed externally rather than exiting on its own. `os._exit` skips finally blocks but still runs in
a process that chose to stop; a real node failure does not ask. The harness watches the log and
sends a genuine terminate.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from ..trainer import TrainConfig, build_state, train
from . import checkpoint as ck


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True, help="checkpoint root")
    parser.add_argument("--log", required=True, help="jsonl, one line per completed step")
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--slow", type=float, default=0.0, help="seconds to linger per step")
    args = parser.parse_args(argv)

    cfg = TrainConfig(steps=args.steps, seed=args.seed)
    state = build_state(cfg)

    root = Path(args.dir)
    resume_from = ck.latest(root)
    if resume_from is not None:
        ck.load(state, resume_from)

    log = Path(args.log)
    log.parent.mkdir(parents=True, exist_ok=True)

    def record(step: int, loss: float) -> None:
        # `state.step` is already the resume point -- `train` advances it before calling back.
        ck.save(state, root / f"step{state.step}")
        with log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"step": step, "loss": loss}) + "\n")
            handle.flush()
        if args.slow:
            time.sleep(args.slow)

    train(state, cfg, on_step=record)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
