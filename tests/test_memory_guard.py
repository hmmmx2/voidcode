"""Contracts for the VRAM guard.

Runs on CPU. The guard is constructed with an explicit synthetic capacity so the two
failure modes can be exercised without the target hardware, which is the point — a guard
you can only test on the machine it protects is a guard you never test.
"""
from __future__ import annotations

import pytest

from training.memory_guard import (
    GIB,
    HostMemorySpill,
    MemoryBudgetExceeded,
    MemoryGuard,
    StagePeak,
)

#: 48 GiB — the figure every rented card in the plan shares (A40, and the L40S it replaced),
#: the guard is tested against it rather than against whichever one is rented today.
CARD_CAPACITY = 48 * GIB


def guard_with(peaks: dict[str, float], fraction: float = 0.92) -> MemoryGuard:
    """A guard populated with synthetic per-stage peaks, in GiB."""
    g = MemoryGuard(capacity_bytes=CARD_CAPACITY, fraction=fraction, enabled=True)
    for name, gib in peaks.items():
        reserved = int(gib * GIB)
        g.stages[name] = StagePeak(name, allocated=int(reserved * 0.95),
                                   reserved=reserved)
        if reserved > g.worst_reserved:
            g.worst_reserved, g.worst_stage = reserved, name
    return g


class TestBudget:
    def test_passes_within_budget(self):
        # ZeRO-2 + 8-bit AdamW no master: 33.4 GiB peak on a 48 GiB card.
        guard_with({"forward": 20.0, "backward": 33.4, "optimizer": 28.0}).check(step=1)

    def test_raises_above_budget(self):
        g = guard_with({"backward": 45.0})          # 45 > 0.92 * 48 = 44.16
        with pytest.raises(MemoryBudgetExceeded) as e:
            g.check(step=7)
        assert "step 7" in str(e.value)
        assert "backward" in str(e.value)

    def test_budget_boundary_is_inclusive(self):
        guard_with({"backward": 44.16}).check()      # exactly at budget: allowed
        with pytest.raises(MemoryBudgetExceeded):
            guard_with({"backward": 44.17}).check()

    def test_fraction_controls_headroom(self):
        # 46 GiB fits at 0.99 but not at the default 0.92 — headroom is a policy choice.
        guard_with({"backward": 46.0}, fraction=0.99).check()
        with pytest.raises(MemoryBudgetExceeded):
            guard_with({"backward": 46.0}, fraction=0.92).check()


class TestHostSpill:
    def test_spill_raises_the_specific_error(self):
        """Reserved above physical capacity means the driver is paging to host RAM."""
        g = guard_with({"backward": 60.0})
        with pytest.raises(HostMemorySpill) as e:
            g.check(step=3)
        msg = str(e.value)
        assert "HOST RAM SPILL" in msg
        assert "silently degraded" in msg

    def test_spill_is_distinguishable_from_budget_breach(self):
        # Both are MemoryBudgetExceeded, but only one is a spill — callers branch on it.
        assert issubclass(HostMemorySpill, MemoryBudgetExceeded)
        with pytest.raises(HostMemorySpill):
            guard_with({"backward": 60.0}).check()
        with pytest.raises(MemoryBudgetExceeded) as e:
            guard_with({"backward": 45.0}).check()
        assert not isinstance(e.value, HostMemorySpill)

    def test_the_observed_wsl2_case(self):
        """28.77 GiB reserved on a 16 GiB card — the case that motivated this module."""
        g = MemoryGuard(capacity_bytes=16 * GIB, enabled=True)
        g.stages["backward"] = StagePeak("backward", int(28.5 * GIB), int(28.77 * GIB))
        g.worst_reserved, g.worst_stage = int(28.77 * GIB), "backward"
        with pytest.raises(HostMemorySpill):
            g.check()


class TestDisabled:
    def test_never_raises_without_cuda(self):
        """CPU/CI: constructing disabled means training code needs no branching."""
        g = MemoryGuard(capacity_bytes=0, enabled=False)
        with g.stage("forward"):
            pass
        g.check(step=1)                              # must not raise

    def test_report_shape_is_identical_with_and_without_cuda(self):
        """Stages are still named, with zero values.

        Deliberate: downstream MLflow logging gets the same keys on a CPU CI runner as
        on the training box, so dashboards do not acquire holes depending on where the
        job ran.
        """
        g = MemoryGuard(capacity_bytes=0, enabled=False)
        with g.stage("forward"):
            pass
        with g.stage("backward"):
            pass
        assert set(g.summary()) == {"forward", "backward"}
        assert all(v == 0.0 for v in g.summary().values())


class TestReporting:
    def test_report_shape(self):
        g = guard_with({"load": 14.2, "forward": 20.0, "backward": 33.4})
        r = g.report()
        assert r["peak_stage"] == "backward"
        assert r["peak_reserved_gib"] == pytest.approx(33.4, abs=0.01)
        assert r["headroom_gib"] == pytest.approx(48 - 33.4, abs=0.01)
        assert set(r["stages"]) == {"load", "forward", "backward"}

    def test_stage_attribution_is_per_stage_not_cumulative(self):
        """Load, forward, backward and optimizer are four different failure points."""
        g = guard_with({"load": 14.2, "backward": 33.4})
        assert g.summary()["load"] == pytest.approx(14.2, abs=0.01)
        assert g.summary()["backward"] == pytest.approx(33.4, abs=0.01)
