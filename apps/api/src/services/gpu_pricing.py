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


#: What a US dollar of GPU cost is worth in MYR, IN TENTHS, so the money path stays integer-only.
#: 47 means 4.7 MYR to the dollar.
#:
#: Written as tenths rather than as 4.7 because this module's own no-floats guard rejects a float
#: literal here -- and it was right to. A float constant is harmless in isolation, but it is how a
#: float reaches the arithmetic beside it, and the guard cannot tell a one-off derivation from a
#: per-transaction multiplication.
#:
#: THIS IS AN FX ASSUMPTION, NOT A MEASUREMENT, and it is the one number here that moves without
#: anyone touching the code. You pay for the pod in USD and collect in MYR, so a weakening ringgit
#: raises your real cost while every price stays where it is. The margin absorbs that as well as
#: idle capacity; if the rate moves far, add a pricing row rather than hoping.
USD_TO_MYR_TENTHS = 47

# No `USD_TO_MYR = USD_TO_MYR_TENTHS / 10` convenience alias: that is a true division, and this
# module's own guard rejects it. Callers that want the decimal can divide it themselves, outside the
# money path.

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
            "PLACEHOLDER, AND DENOMINATED IN US CENTS, WHICH WAS WRONG FOR AN MYR PRODUCT. "
            "Superseded the next day by the row below. Kept because this table is append-only and "
            "because the error is worth being able to find: credits were defined as US cents while "
            "packs were sold in ringgit, so a RM20 pack granted about RM56 of GPU. Nothing ever "
            "settled against it -- metering has never been switched on."
        ),
    ),
    PricingRow(
        effective_from=datetime(2026, 9, 10, tzinfo=timezone.utc),
        # THE CORRECTION: one credit is one SEN, not one US cent, because that is the currency the
        # product sells in. RunPod bills ~$0.49/hr for the A40, so the pod costs
        # 0.49 x USD_TO_MYR = ~RM2.30/hr = 230 sen = 230 credits per hour.
        #
        # Getting this wrong is not a rounding error. With credits denominated in US cents and packs
        # priced in ringgit, every pack sold GPU at roughly a third of cost, and every figure in the
        # ledger stayed arithmetically correct while it happened. `test_pack_economics.py` now ties
        # the two together so the units cannot drift apart again unnoticed.
        # 49 US cents/hr x 4.7 = 230.3 sen, floored to 230. Integer throughout:
        # 49 * 47 // 10 = 230.
        pod_micro_per_hour=(49 * USD_TO_MYR_TENTHS // 10) * 1_000_000,
        nominal_concurrency=16,
        margin_bps=15_000,
        gpu="A40 48GB",
        model="Qwen3-Coder-30B-A3B-Instruct + RL adapter",
        measured=False,
        note=(
            "MYR-denominated: 1 credit = 1 sen. Still PLACEHOLDER on the other axis -- "
            "nominal_concurrency of 16 is an API semaphore count, not a measured property of an "
            "A40, and the serving benchmark has not run. Replace with a measured row before "
            "charging anyone."
        ),
    ),
    PricingRow(
        # 08:56 UTC: the minute the benchmark finished. Dated to when the measurement
        # exists rather than to midnight, so the row above stays the one that was live
        # for the whole period when nobody had measured anything.
        effective_from=datetime(2026, 9, 10, 8, 56, tzinfo=timezone.utc),
        # Same money as the row above. What changed is that the concurrency divisor is no longer a
        # guess, so `measured` can finally be True.
        pod_micro_per_hour=(49 * USD_TO_MYR_TENTHS // 10) * 1_000_000,
        # MEASURED, AND DELIBERATELY NOT RAISED. `docs/rl/bench-serving-30b.json`: the A40 served 16
        # concurrent requests at 5120 tokens with 48 of 48 succeeding and per-slot throughput at
        # 45.1 tok/s -- half the single-slot 90.4, against a rejection threshold of a quarter.
        #
        # 16 IS A FLOOR, NOT A CEILING, AND THE PRICE USES THE FLOOR ON PURPOSE. The sweep stopped
        # at 16 because that is the highest level the script tests: `levels_rejected` is empty, so
        # nothing was refused and the real limit was never found. vLLM's own estimate from the KV
        # cache it allocated is 43.83x. Dividing the pod's cost by a concurrency higher than what
        # has actually been demonstrated would understate cost, which is the one direction this
        # table must not err in.
        #
        # The consequence of using the floor is that credit is priced above true cost if the card
        # really does forty. That is the safe error -- learners pay more than necessary rather than
        # the pod running at a loss -- and it can be corrected downward once a sweep finds the
        # ceiling.
        nominal_concurrency=16,
        margin_bps=15_000,
        gpu="A40 48GB",
        model="Qwen3-Coder-30B-A3B-Instruct + RL adapter",
        measured=True,
        note=(
            "MEASURED. Serving benchmark 2026-09-10 on a dedicated A40 with nothing else "
            "resident: 16 concurrent at max_model_len 5120, zero failures over 48 requests, "
            "619.9 tok/s aggregate, 45.1 tok/s per slot, single-slot 90.4 tok/s, TTFT p50 0.139 s. "
            "Full result in docs/rl/bench-serving-30b.json. The figure is a demonstrated floor "
            "rather than the card's ceiling: the sweep's top level was 16 and it rejected nothing, "
            "so the price is conservative by however much the real limit exceeds it."
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
