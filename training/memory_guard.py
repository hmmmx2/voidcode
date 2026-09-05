"""Per-step VRAM assertion. The guard that makes a bad configuration fail loudly.

Blueprint §3.5. Under WDDM (Windows/WSL2) the driver silently spills GPU allocations into
host RAM rather than raising OOM, so a run that does not fit executes over PCIe at a
fraction of expected speed while every log line looks healthy. A backward pass reaching
28.77 GiB on a 16 GiB card without failing is the observed case.

The rule this module enforces: **never treat "it did not crash" as evidence a configuration
fits.** An assertion, not a log line.

PORTED, AND WHY IT STILL APPLIES
--------------------------------
Written for WDDM and carried here unchanged, because the hardware moved but the hazard did
not. The original argument was made against Thunder Compute's virtualised "prototyping" tier.
That vendor is no longer in the plan, and the argument survives the switch without it.

On RunPod the live version is Community Cloud: third-party multitenant hardware where, by
RunPod's own description, availability varies by provider. The layer between this process and
the silicon is therefore not a constant, and a layer that can reinterpret allocation is a layer
that can mask over-subscription the way WDDM does. Nobody has measured whether any given host
does. Until P0 says otherwise, treat this assertion as load-bearing rather than historical.

There is a second reason it matters more here than it did on a desk: **you are paying by the
hour.** A run that silently degrades to PCIe bills at the same rate, and the throughput number
it produces is not merely wrong, it is expensive to have collected.

This module was tested and CI-gated on the platform branch and **never wired into a trainer**.
Wiring it is the point of the port; leaving it uncalled again would repeat the original defect.

Two distinct conditions are detected, because they mean different things:

  Budget breach   reserved > fraction * capacity   -> config is too large for the card
  Host spill      reserved > capacity              -> driver is paging to host RAM;
                                                      throughput numbers are meaningless

Usage:

    guard = MemoryGuard.for_current_device(fraction=0.92)
    for step, batch in enumerate(loader):
        with guard.stage("forward"):
            loss = model(**batch).loss
        with guard.stage("backward"):
            loss.backward()
        with guard.stage("optimizer"):
            opt.step(); opt.zero_grad(set_to_none=False)
        guard.check(step)
"""
from __future__ import annotations

import contextlib
import os
from dataclasses import dataclass, field

try:
    import torch
except ImportError:                                              # pragma: no cover
    torch = None

GIB = 1024 ** 3


class MemoryBudgetExceeded(RuntimeError):
    """Raised when a step exceeds its VRAM budget. Never caught inside a training loop."""


class HostMemorySpill(MemoryBudgetExceeded):
    """Reserved VRAM exceeded physical capacity — the driver is paging to host RAM.

    Distinct from a budget breach: the run has not failed, it has silently degraded.
    Any throughput measured in this state is invalid.
    """


@dataclass
class StagePeak:
    name: str
    allocated: int
    reserved: int

    @property
    def allocated_gib(self) -> float:
        return round(self.allocated / GIB, 4)

    @property
    def reserved_gib(self) -> float:
        return round(self.reserved / GIB, 4)


@dataclass
class MemoryGuard:
    """Tracks peak VRAM per stage and raises when a step breaches its budget.

    `capacity_bytes` is the physical card capacity, not the budget. `fraction` is the
    share of it this run is permitted — leave headroom for fragmentation and the CUDA
    context, which together commonly account for 2-4 GiB on a 48 GiB card.
    """

    capacity_bytes: int
    fraction: float = 0.92
    device: int = 0
    enabled: bool = True
    stages: dict[str, StagePeak] = field(default_factory=dict)
    worst_reserved: int = 0
    worst_stage: str | None = None

    # ── construction ────────────────────────────────────────────────────────
    @classmethod
    def for_current_device(cls, fraction: float = 0.92,
                           device: int | None = None) -> MemoryGuard:
        if torch is None or not torch.cuda.is_available():
            # CPU / CI: construct disabled so training code needs no branching.
            return cls(capacity_bytes=0, fraction=fraction, device=0, enabled=False)
        device = torch.cuda.current_device() if device is None else device
        capacity = torch.cuda.get_device_properties(device).total_memory
        return cls(capacity_bytes=capacity, fraction=fraction, device=device)

    @property
    def budget_bytes(self) -> int:
        return int(self.capacity_bytes * self.fraction)

    # ── measurement ─────────────────────────────────────────────────────────
    def reset_peak(self) -> None:
        if self.enabled:
            torch.cuda.synchronize(self.device)
            torch.cuda.reset_peak_memory_stats(self.device)

    def _peak(self) -> tuple[int, int]:
        if not self.enabled:
            return 0, 0
        torch.cuda.synchronize(self.device)
        return (torch.cuda.max_memory_allocated(self.device),
                torch.cuda.max_memory_reserved(self.device))

    @contextlib.contextmanager
    def stage(self, name: str):
        """Record the peak reached inside this block.

        Peak stats are reset on entry, so each stage's figure is attributable rather
        than being the running maximum of everything before it. Model load, forward,
        backward and optimizer step are four different failure points and conflating
        them destroys the diagnostic.
        """
        self.reset_peak()
        try:
            yield self
        finally:
            allocated, reserved = self._peak()
            self.stages[name] = StagePeak(name, allocated, reserved)
            if reserved > self.worst_reserved:
                self.worst_reserved = reserved
                self.worst_stage = name

    # ── assertion ───────────────────────────────────────────────────────────
    def check(self, step: int | None = None) -> None:
        """Raise if the worst stage this step breached capacity or budget."""
        if not self.enabled:
            return
        where = f"step {step}, stage {self.worst_stage!r}" if step is not None \
            else f"stage {self.worst_stage!r}"

        if self.worst_reserved > self.capacity_bytes:
            raise HostMemorySpill(
                f"HOST RAM SPILL at {where}: reserved "
                f"{self.worst_reserved / GIB:.2f} GiB exceeds device capacity "
                f"{self.capacity_bytes / GIB:.2f} GiB. The driver is paging to host "
                f"memory over PCIe — the run has NOT failed, it has silently degraded, "
                f"and any throughput measured now is invalid. Reduce batch size, "
                f"sequence length, or optimizer state.")

        if self.worst_reserved > self.budget_bytes:
            raise MemoryBudgetExceeded(
                f"VRAM budget exceeded at {where}: reserved "
                f"{self.worst_reserved / GIB:.2f} GiB > budget "
                f"{self.budget_bytes / GIB:.2f} GiB "
                f"({self.fraction:.0%} of {self.capacity_bytes / GIB:.2f} GiB). "
                f"Per-stage peaks: {self.summary()}")

    def summary(self) -> dict[str, float]:
        return {name: p.reserved_gib for name, p in self.stages.items()}

    def report(self) -> dict:
        """Structured record for MLflow. Emit once per run, not per step."""
        return {
            "device": self.device,
            "capacity_gib": round(self.capacity_bytes / GIB, 3),
            "budget_gib": round(self.budget_bytes / GIB, 3),
            "peak_reserved_gib": round(self.worst_reserved / GIB, 3),
            "peak_stage": self.worst_stage,
            "headroom_gib": round(
                (self.capacity_bytes - self.worst_reserved) / GIB, 3),
            "stages": {n: {"allocated_gib": p.allocated_gib,
                           "reserved_gib": p.reserved_gib}
                       for n, p in self.stages.items()},
        }


def assert_expandable_segments() -> None:
    """Warn when the allocator is left in its default fragmenting configuration.

    `expandable_segments:True` materially reduces fragmentation on long runs with
    variable sequence lengths, which is exactly the multipack case. Not fatal, so this
    warns rather than raises.
    """
    conf = os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "")
    if "expandable_segments" not in conf:
        print("WARNING: PYTORCH_CUDA_ALLOC_CONF lacks expandable_segments:True — "
              "expect avoidable fragmentation under variable-length packing.")
