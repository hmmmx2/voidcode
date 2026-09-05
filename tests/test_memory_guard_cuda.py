"""`MemoryGuard` against a real CUDA device — the path it was written for and never ran on.

`tests/test_memory_guard.py` constructs the guard with a synthetic capacity and hand-filled stage
peaks, which tests the arithmetic and the exception types. It cannot test the part that actually
matters: whether `torch.cuda.max_memory_reserved` and `reset_peak_memory_stats` behave the way the
guard assumes when real tensors are allocated and freed.

That gap is not academic. The guard exists because of a **WDDM** observation recorded in its own
docstring — a backward pass reaching 28.77 GiB on a 16 GiB card without raising OOM, because the
driver silently spilled to host RAM. The machine these tests run on is that configuration. So this
is the first time the module meets its own subject.

Budgets here are synthetic and small on purpose. Provoking a genuine 16 GiB host spill would test
the driver rather than the guard, and would risk the machine to learn something a deliberate
opt-in experiment can find out more safely (see `scripts/probe_wddm_spill.py`).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch", reason="needs torch")

from training.memory_guard import (  # noqa: E402
    GIB,
    HostMemorySpill,
    MemoryBudgetExceeded,
    MemoryGuard,
)

pytestmark = pytest.mark.skipif(
    not torch.cuda.is_available(), reason="no CUDA device; the synthetic-capacity tests cover the arithmetic"
)

MIB = 1024**2


@pytest.fixture(autouse=True)
def clean_device():
    """Each test starts from a known allocator state, or peaks leak between them."""
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    yield
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()


def test_for_current_device_reads_the_real_card() -> None:
    """The classmethod's CUDA branch — previously only its CPU fallback was exercised."""
    guard = MemoryGuard.for_current_device(fraction=0.9)

    assert guard.enabled is True
    props = torch.cuda.get_device_properties(torch.cuda.current_device())
    assert guard.capacity_bytes == props.total_memory
    assert guard.budget_bytes == int(props.total_memory * 0.9)
    # Sanity against the thing the plan actually depends on.
    assert guard.capacity_bytes > 4 * GIB


def test_a_stage_records_a_real_allocation() -> None:
    guard = MemoryGuard(capacity_bytes=8 * GIB, fraction=0.95, enabled=True)

    with guard.stage("forward"):
        block = torch.empty(64 * MIB // 4, dtype=torch.float32, device="cuda")
        del block

    peak = guard.stages["forward"]
    # Reserved is what the caching allocator took from the driver, so >= the 64 MiB requested.
    assert peak.reserved >= 64 * MIB
    assert peak.allocated >= 64 * MIB
    assert guard.worst_stage == "forward"


def test_stages_are_attributable_rather_than_cumulative() -> None:
    """Per-stage peaks must be independent, or the diagnostic is useless.

    Model load, forward, backward and optimizer are four different failure points. If the guard
    reported a running maximum, every stage after the largest one would look equally guilty.
    """
    guard = MemoryGuard(capacity_bytes=8 * GIB, fraction=0.95, enabled=True)

    with guard.stage("big"):
        big = torch.empty(128 * MIB // 4, dtype=torch.float32, device="cuda")
        del big
    with guard.stage("small"):
        small = torch.empty(4 * MIB // 4, dtype=torch.float32, device="cuda")
        del small

    assert guard.stages["big"].allocated > guard.stages["small"].allocated
    # The point: 'small' is not tainted by 'big'.
    assert guard.stages["small"].allocated < 32 * MIB
    assert guard.worst_stage == "big"


def test_budget_breach_raises_on_a_real_allocation() -> None:
    """A budget the allocation genuinely exceeds, measured rather than injected."""
    guard = MemoryGuard(capacity_bytes=256 * MIB, fraction=0.25, enabled=True)  # budget 64 MiB

    with guard.stage("forward"):
        block = torch.empty(128 * MIB // 4, dtype=torch.float32, device="cuda")
        del block

    with pytest.raises(MemoryBudgetExceeded) as excinfo:
        guard.check(step=7)

    message = str(excinfo.value)
    assert "step 7" in message and "forward" in message
    assert not isinstance(excinfo.value, HostMemorySpill), "128 MiB is over budget, not over capacity"


def test_host_spill_outranks_a_budget_breach() -> None:
    """Reserved above *capacity* is the WDDM signature and must be the louder error.

    They are different findings: over budget means the config is too big for the card, while over
    capacity means the driver is paging over PCIe and any throughput number collected is invalid.
    """
    guard = MemoryGuard(capacity_bytes=32 * MIB, fraction=0.5, enabled=True)

    with guard.stage("backward"):
        block = torch.empty(96 * MIB // 4, dtype=torch.float32, device="cuda")
        del block

    with pytest.raises(HostMemorySpill) as excinfo:
        guard.check(step=3)

    assert "SPILL" in str(excinfo.value).upper()


def test_a_run_inside_budget_does_not_raise() -> None:
    """The guard must be silent when it should be, or it trains people to ignore it."""
    guard = MemoryGuard(capacity_bytes=2 * GIB, fraction=0.9, enabled=True)

    with guard.stage("forward"):
        block = torch.empty(16 * MIB // 4, dtype=torch.float32, device="cuda")
        del block

    guard.check(step=1)
    assert guard.report()["peak_stage"] == "forward"
    assert guard.report()["headroom_gib"] > 0
