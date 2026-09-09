"""What a slot-second costs, and how big a hold a request needs.

THE PRICE IS A DATED ROW, NOT A CONSTANT

Hardware and model changes move the price. If the current price were a bare constant, a past request
would re-price whenever it changed, and a reconciliation against last month's invoice would drift
every time someone edited a number. So the table is a list of dated rows, `rate_for()` picks the one
that was live at a given instant, and every reservation snapshots the rate it used. A past request
settles at the rate that was live when it ran, permanently.

THE CENTRAL NUMBER IS NOT MEASURED YET, AND THE TABLE SAYS SO

`credit_per_slot_second` derives from the pod's hourly cost and the nominal concurrency, both of
which are known. What is *not* known is whether the resulting price recovers cost, because that
depends on throughput per slot for the served model at realistic generation lengths, and no such
measurement exists for the 30B on an A40. The closest figures on record are 157.1 tok/s (a 7.6B AWQ
model, three prompts, 64 tokens, and its own evidence file calls it "not a sustained throughput
benchmark") and 18.6 tok/s (local 5060 Ti, 9B fp8). Neither is the right number.

So the first row below is marked `measured=False`. It is a placeholder that lets the machinery run in
shadow mode; it is not a claim. The reconciliation test is expected to fail against real cost until a
measured row replaces it, and that failure is the point.
"""

from dataclasses import dataclass
from datetime import datetime, timezone

MICRO_PER_CREDIT = 1_000_000


def ceil_div(numerator: int, denominator: int) -> int:
    """Integer ceiling division. Never `math.ceil(a / b)` — that routes money through a float."""
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return -(-numerator // denominator)


@dataclass(frozen=True)
class PricingRow:
    """One dated price. `effective_from` is inclusive; the latest row at or before an instant wins."""

    effective_from: datetime
    #: What the pod costs per hour, in micro-credits, at the operator's rented rate.
    pod_micro_per_hour: int
    #: Slots the pod is sized to serve at once. This is the divisor that makes the unit honest --
    #: see the module docstring on gpu_billing. It must be MAX_CONCURRENT_REQUESTS x replicas,
    #: because the semaphore is per-process and the deployment runs more than one.
    nominal_concurrency: int
    #: Multiplier recovering idle hours across active ones, since an idle pod bills too and no
    #: single learner can be charged for it. **Basis points, not a float**: 10_000 = 1.0x,
    #: 15_000 = 1.5x. A float margin was the first version and it put a float on the money path --
    #: `base * 1000 * 1.5` is a float multiplication, exact for small values and silently lossy for
    #: large ones, which is the failure this module's own docstring forbids.
    margin_bps: int
    gpu: str
    model: str
    #: False when the throughput this price implies has not been measured on this hardware.
    measured: bool
    note: str = ""

    @property
    def rate_micro_per_slot_second(self) -> int:
        """Cost of one second of one slot, with margin. Integer, rounded up."""
        base = ceil_div(self.pod_micro_per_hour, 3600 * self.nominal_concurrency)
        return ceil_div(base * self.margin_bps, 10_000)


#: Dated, newest last. Add a row; never edit one that has settled requests behind it.
PRICING: tuple[PricingRow, ...] = (
    PricingRow(
        effective_from=datetime(2026, 9, 9, tzinfo=timezone.utc),
        # ~$0.49/hr for a 48 GB A40, the figure `docs/specs/SCALING-PROPOSAL.md` recommends for
        # serving a ~30B tutor. Expressed as micro-credits by pinning 1 credit = 1 US cent, so an
        # hour is 49 cents = 49_000_000 micro-credits.
        pod_micro_per_hour=49_000_000,
        # MAX_CONCURRENT_REQUESTS (8 under vLLM) x 2 replicas.
        nominal_concurrency=16,
        margin_bps=15_000,
        gpu="A40 48GB",
        model="Qwen3-Coder-30B-A3B-Instruct + RL adapter",
        measured=False,
        note=(
            "PLACEHOLDER. Throughput per slot for this model on this card at realistic generation "
            "lengths has never been measured -- the A40 has been occupied by the seed-1 "
            "replication and the max-cases ablation. Replace with a measured row before charging "
            "anyone, and expect the reconciliation test to fail until then."
        ),
    ),
)


def rate_for(when: datetime | None = None) -> PricingRow:
    """The row live at `when` (default now). Raises if the table starts after that instant."""
    when = when or datetime.now(timezone.utc)
    live = [row for row in PRICING if row.effective_from <= when]
    if not live:
        raise ValueError(f"no pricing row is effective at {when.isoformat()}")
    return live[-1]


def hold_micro_for(max_slot_seconds: int, *, floor_micro: int, when: datetime | None = None) -> int:
    """The worst case a request may cost, which is what gets held up front.

    A ceiling, not a forecast: the settle charges measured occupancy and returns the rest. Holding
    the worst case is what makes "refuse before the pod runs" possible — a learner who cannot afford
    the maximum is refused at 402 rather than discovering it mid-generation.

    `floor_micro` is applied here as well as at settle, so a request that cannot afford even the
    floor is refused up front.
    """
    row = rate_for(when)
    return max(max_slot_seconds * row.rate_micro_per_slot_second, floor_micro)
