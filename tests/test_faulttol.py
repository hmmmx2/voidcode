"""Fault tolerance: a resumed run must compute what an uninterrupted run computes.

"It restarted" is not the property, and neither is "the loss went down again". A resume that
loses optimizer state recovers over a few dozen steps and draws a curve that looks entirely
normal — that is the failure mode that ships. So these assert equality, and then assert that
equality is not free by breaking each ingredient in turn and requiring divergence.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytest.importorskip("torch", reason="the trainer needs torch")

from training.faulttol import checkpoint as ck
from training.faulttol.kill_test import run as kill_and_resume
from training.trainer import TrainConfig, build_state, train

CFG = TrainConfig(steps=8, seed=5)


def curve_with_restart(tmp_path, break_it=None) -> tuple[list[float], list[float]]:
    """Reference curve, and the curve of a run that saved at step 4 and resumed from disk."""
    reference = train(build_state(CFG), CFG)

    a = build_state(CFG)
    first = train(a, CFG, until=4)
    ck.save(a, tmp_path / "step4")

    b = build_state(CFG)
    ck.load(b, tmp_path / "step4")
    if break_it is not None:
        break_it(b)
    return reference, first + train(b, CFG)


def test_a_clean_save_and_resume_is_exact(tmp_path) -> None:
    reference, resumed = curve_with_restart(tmp_path)

    assert len(reference) == len(resumed) == CFG.steps
    for step, (want, got) in enumerate(zip(reference, resumed, strict=True)):
        assert abs(want - got) < 1e-12, f"step {step}: {want!r} != {got!r}"


def test_resume_needs_the_optimizer_state_too(tmp_path) -> None:
    """Drop momentum buffers and the curve must move.

    Without this, the test above would pass just as happily on a checkpoint that saved only
    weights — which is why `build_state` uses SGD *with momentum* rather than plain SGD.
    """
    reference, resumed = curve_with_restart(tmp_path, break_it=lambda s: s.optimizer.state.clear())

    assert any(abs(w - g) > 1e-9 for w, g in zip(reference, resumed, strict=True)), (
        "clearing the optimizer state changed nothing — the optimizer is stateless and the "
        "resume test proves only that weights round-trip"
    )


def test_resume_needs_the_step(tmp_path) -> None:
    """The step counter *is* the dataloader state, because the batch is a function of (seed, step)."""
    reference, resumed = curve_with_restart(tmp_path, break_it=lambda s: setattr(s, "step", 0))

    assert any(abs(w - g) > 1e-9 for w, g in zip(reference, resumed, strict=True)), (
        "resuming from the wrong step produced the same curve — the batch does not depend on "
        "the step and the whole step-indexed design is doing nothing"
    )


def test_an_incomplete_checkpoint_is_refused(tmp_path) -> None:
    """Shards written, meta missing: killed mid-save. Resuming would silently rewind."""
    state = build_state(CFG)
    train(state, CFG, until=3)
    ck.save(state, tmp_path / "step3")
    (tmp_path / "step3" / ck.META).unlink()

    assert not ck.is_complete(tmp_path / "step3")
    with pytest.raises(FileNotFoundError, match="incomplete"):
        ck.load(build_state(CFG), tmp_path / "step3")


def test_latest_skips_the_corpse_and_finds_the_last_good_one(tmp_path) -> None:
    """A crash mid-save is the situation this module exists for; it must not block startup."""
    state = build_state(CFG)
    train(state, CFG, until=2)
    ck.save(state, tmp_path / "step2")
    train(state, CFG, until=5)
    ck.save(state, tmp_path / "step5")
    (tmp_path / "step5" / ck.META).unlink()          # step5 died mid-write

    found = ck.latest(tmp_path)
    assert found is not None and found.name == "step2"
    assert ck.latest(tmp_path / "nothing-here") is None


@pytest.mark.slow
def test_killing_the_process_does_not_change_the_curve(tmp_path) -> None:
    """The real thing: a separate process, terminated externally, then resumed from disk.

    Slower than the in-process tests because it spawns three interpreters, and worth it — an
    in-process 'crash' cannot demonstrate that nothing survived in memory that shouldn't have.
    """
    result = kill_and_resume(tmp_path, steps=6, kill_after=3, seed=5, slow=0.05)

    assert result["killed_after_step"] is not None, "the victim was never actually killed"
    assert result["identical"], f"curve diverged after resume: {result['mismatches']}"
    assert set(result["resumed"]) == set(range(6))
