"""Does a period of usage recover that period's GPU cost?

THIS IS THE TEST THE BUSINESS MODEL RESTS ON. Everything else in the metering subsystem checks that
credit moves correctly; this checks that the amount is the right amount. A billing system that
reserves, settles and reconciles perfectly while charging a price that does not cover the pod is
worse than no billing system, because it takes payments and loses money on every hour with the books
balancing the whole time.

It is deliberately end to end through the real wallet, the real settle and the real ledger, rather
than arithmetic on the pricing row — `test_gpu_pricing.py` already does the arithmetic. What this
adds is the plumbing: that the machinery neither loses nor invents money between a measured
occupancy and a balance.

WHAT "FULL UTILISATION" MEANS HERE

A pod sized for N concurrent slots, busy for an hour, produces N x 3600 slot-seconds. The test
synthesises exactly that many, spread over fewer, longer requests so the row count stays sane, and
then asks whether the credit drawn covers one pod-hour times the margin.
"""

import uuid

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from src.models.gpu_billing import GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.services import gpu_pricing
from src.services import gpu_sweep_service as sweep
from src.services import gpu_wallet_service as wallet

pytestmark = [requires_postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def learner(sessionmaker_np):
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"gpu-recon-{user_id.hex[:12]}@example.test",
                name="GPU reconciliation test",
                role="student",
            )
        )
        await db.flush()
        db.add(GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0))
        await db.commit()
    yield user_id
    async with sessionmaker_np() as db:
        await db.execute(delete(GpuLedger).where(GpuLedger.wallet_user_id == user_id))
        await db.execute(delete(GpuReservation).where(GpuReservation.wallet_user_id == user_id))
        await db.execute(delete(GpuWallet).where(GpuWallet.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()



async def _grant(sessionmaker_np, user_id, amount):
    async with sessionmaker_np() as db:
        await wallet.grant(db, user_id, amount_micro=amount, idempotency_key=f"g:{uuid.uuid4()}")


async def _run_requests(sessionmaker_np, user_id, *, count: int, slot_seconds: int, rate: int):
    """Reserve and settle `count` requests each occupying `slot_seconds`. Returns total charged."""
    charged = 0
    for _ in range(count):
        hold = slot_seconds * rate
        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, user_id, hold_micro=hold, request_id=f"chatcmpl-{uuid.uuid4().hex}",
                kind="chat", backend="hf", rate_micro_per_slot_second=rate,
            )
        async with sessionmaker_np() as db:
            before = (await db.get(GpuWallet, user_id)).balance_micro
            await wallet.settle(db, reservation.id, slot_ms=slot_seconds * 1000)
        async with sessionmaker_np() as db:
            after = (await db.get(GpuWallet, user_id)).balance_micro
        charged += before - after
    return charged


class TestABusyHourRecoversItsPodHour:
    async def test_full_utilisation_covers_the_pod_and_the_margin(
        self, sessionmaker_np, learner
    ):
        """The headline. If this fails, the credit price is wrong and real money would follow."""
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second

        # One fully-busy hour = nominal_concurrency slots x 3600 seconds of occupancy, synthesised
        # as fewer, longer requests so the test does not write thousands of rows to prove
        # arithmetic that is linear in slot-seconds anyway.
        slot_seconds_in_a_busy_hour = row.nominal_concurrency * 3600
        count = 24
        per_request = slot_seconds_in_a_busy_hour // count
        assert count * per_request == slot_seconds_in_a_busy_hour, "choose a count that divides"

        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=10 * row.pod_micro_per_hour,
                idempotency_key=f"g:{uuid.uuid4()}",
            )

        charged = await _run_requests(
            sessionmaker_np, learner, count=count, slot_seconds=per_request, rate=rate
        )

        pod_cost = row.pod_micro_per_hour
        expected = pod_cost * row.margin_bps // 10_000

        assert charged >= pod_cost, (
            f"a fully utilised hour drew {charged} micro-credits against a pod costing {pod_cost}. "
            "The price does not cover the hardware."
        )
        # Over-recovery only, and only by rounding dust. The bound accounts for TWO ceilings, not
        # one: `rate_micro_per_slot_second` rounds the base rate up, then rounds again after
        # applying the margin, so the first error is amplified by the margin before the second is
        # added. An earlier version of this assertion allowed one slot-second of drift and failed
        # the moment the pod cost changed -- the arithmetic was right, the bound was wrong.
        max_dust = slot_seconds_in_a_busy_hour * (1 + row.margin_bps // 10_000 + 1)
        assert charged >= expected, (
            f"charged {charged} against an intended {expected}: rounding up cannot under-recover, "
            "so this means the rate and the margin disagree"
        )
        assert charged - expected < max_dust, (
            f"charged {charged}, intended {expected} at {row.margin_bps} bps — "
            f"{charged - expected} over is more than rounding can explain"
        )

    async def test_a_half_idle_hour_under_recovers_and_that_is_correct(
        self, sessionmaker_np, learner
    ):
        """Idle capacity is the operator's cost, not a learner's.

        Recorded as a test rather than a comment because the instinct on seeing under-recovery is to
        raise the price until an idle pod pays for itself, which charges busy learners for empty
        slots. The answer to idle capacity is to stop running it — spin-down — not to reprice it.
        """
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        half_busy = (row.nominal_concurrency * 3600) // 2

        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=10 * row.pod_micro_per_hour,
                idempotency_key=f"g:{uuid.uuid4()}",
            )

        charged = await _run_requests(
            sessionmaker_np, learner, count=12, slot_seconds=half_busy // 12, rate=rate
        )
        assert charged < row.pod_micro_per_hour, (
            "a half-idle hour recovered a full pod-hour, which means busy learners are paying for "
            "empty slots"
        )


class TestTheBooksBalance:
    async def test_the_ledger_sums_to_the_balance_after_a_day_of_traffic(
        self, sessionmaker_np, learner
    ):
        """The wallet is a cache of the ledger. If they disagree, one of them is lying.

        This is what `reconcile_wallets` checks in production; running it over synthetic traffic
        proves the check works and that the machinery it checks does not drift under load.
        """
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second

        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=5 * row.pod_micro_per_hour,
                idempotency_key=f"g:{uuid.uuid4()}",
            )

        # Mixed traffic: short questions and long ones, plus abandoned requests that never settle.
        await _run_requests(sessionmaker_np, learner, count=10, slot_seconds=3, rate=rate)
        await _run_requests(sessionmaker_np, learner, count=5, slot_seconds=90, rate=rate)
        async with sessionmaker_np() as db:
            abandoned = await wallet.reserve(
                db, learner, hold_micro=100 * rate, request_id="chatcmpl-abandoned",
                kind="chat", backend="hf", rate_micro_per_slot_second=rate,
            )
        async with sessionmaker_np() as db:
            await wallet.void(db, abandoned.id)

        async with sessionmaker_np() as db:
            balance = (await db.get(GpuWallet, learner)).balance_micro
            ledger_total = await db.scalar(
                select(func.sum(GpuLedger.amount_micro)).where(
                    GpuLedger.wallet_user_id == learner
                )
            )
        assert balance == ledger_total, (
            f"wallet says {balance}, its ledger sums to {ledger_total}"
        )

        async with sessionmaker_np() as db:
            drift = await sweep.reconcile_wallets(db)
        assert [r for r in drift if r[0] == learner] == []

    async def test_nothing_is_left_held_after_every_request_finished(
        self, sessionmaker_np, learner
    ):
        """A stranded hold is invisible in the balance but real in the available credit."""
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=row.pod_micro_per_hour,
                idempotency_key=f"g:{uuid.uuid4()}",
            )
        await _run_requests(sessionmaker_np, learner, count=8, slot_seconds=5, rate=rate)

        async with sessionmaker_np() as db:
            wallet_row = await db.get(GpuWallet, learner)
            held = await db.scalar(
                select(func.count())
                .select_from(GpuReservation)
                .where(
                    GpuReservation.wallet_user_id == learner,
                    GpuReservation.state == "held",
                )
            )
        assert wallet_row.reserved_micro == 0
        assert held == 0


class TestThePriceIsStillAPlaceholder:
    async def test_the_shipped_row_is_measured_and_says_what_measured_it(
        self, sessionmaker_np, learner
    ):
        """This guard used to assert the opposite, and it did its job.

        It read `assert row.measured is False` with a message telling whoever tripped it to re-run
        this suite against real numbers before deleting it. The serving benchmark ran on
        2026-09-10 and that is exactly what happened: the A40 served 16 concurrent requests at
        max_model_len 5120 with zero failures, so the concurrency divisor the price rests on is no
        longer a guess. The assertions above now hold against a measured figure rather than a
        placeholder.

        WHAT REPLACES IT IS NOT NOTHING. A `measured=True` with no evidence behind it is worse than
        `measured=False`, because the flag is what a margin query filters on -- and an unbacked
        claim there turns an assumption into a reported fact. So this asserts the flag AND that the
        note says what produced it.

        The residual caveat, recorded in the row itself: 16 is a demonstrated floor, not the card's
        ceiling. The sweep's top level was 16 and it rejected nothing, so the true limit was never
        found. The price uses the floor deliberately -- a higher divisor would understate cost, and
        that is the one direction this table must not err in.
        """
        row = gpu_pricing.rate_for()
        assert row.measured is True, (
            "the live pricing row is unmeasured again — a price that divides by a guessed "
            "concurrency can under-recover threefold with every ledger figure staying correct"
        )
        assert "MEASURED" in row.note
        assert "bench-serving-30b.json" in row.note, (
            "the row claims to be measured but does not say by what. The artefact is the whole "
            "difference between a measurement and an assertion, and `measured` is the flag a "
            "margin query filters on."
        )
        assert row.nominal_concurrency <= 16, (
            "the concurrency divisor now exceeds what the benchmark demonstrated. The sweep's top "
            "level was 16 and it rejected nothing, so anything above that is extrapolation — and "
            "extrapolating upward here understates cost."
        )


class TestMarginIsQueryableFromTheRow:
    """Revenue was recorded and cost was not, so margin was an arithmetic exercise, not a query.

    Recomputing it after the fact meant reaching back into `gpu_pricing.PRICING` -- a dated,
    append-only tuple -- and guessing which row was live when each request ran. That gets harder
    with every price change and is already impossible to do exactly for a request served under a
    superseded row. These columns make it a `SELECT`.
    """

    async def test_a_settled_request_carries_its_cost_and_the_basis_behind_it(
        self, sessionmaker_np, learner
    ):
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        await _grant(sessionmaker_np, learner, 100 * rate)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=60 * rate, request_id="chatcmpl-cost",
                kind="chat", backend="sglang", rate_micro_per_slot_second=rate,
                pod_micro_per_hour=row.pod_micro_per_hour,
                nominal_concurrency=row.nominal_concurrency,
                margin_bps=row.margin_bps,
                pricing_measured=row.measured,
            )
        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=30_000) is True

        async with sessionmaker_np() as db:
            settled = await db.get(GpuReservation, reservation.id)

        assert settled.pod_micro_per_hour == row.pod_micro_per_hour
        assert settled.nominal_concurrency == row.nominal_concurrency
        assert settled.margin_bps == row.margin_bps
        assert settled.pricing_measured is row.measured
        assert settled.cost_micro is not None, "a settled request recorded no cost"

    async def test_the_cost_is_reproducible_from_the_columns_beside_it(
        self, sessionmaker_np, learner
    ):
        """The reason the inputs are stored: the derivation can be re-run against the row."""
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        await _grant(sessionmaker_np, learner, 100 * rate)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=60 * rate, request_id="chatcmpl-cost-repro",
                kind="chat", backend="sglang", rate_micro_per_slot_second=rate,
                pod_micro_per_hour=row.pod_micro_per_hour,
                nominal_concurrency=row.nominal_concurrency,
                margin_bps=row.margin_bps,
                pricing_measured=row.measured,
            )
        async with sessionmaker_np() as db:
            await wallet.settle(db, reservation.id, slot_ms=30_000)

        async with sessionmaker_np() as db:
            settled = await db.get(GpuReservation, reservation.id)

        expected = wallet.ceil_div(
            settled.pod_micro_per_hour * settled.slot_ms,
            3600 * 1000 * settled.nominal_concurrency,
        )
        assert settled.cost_micro == expected

    async def test_margin_is_a_subtraction_and_it_is_positive(self, sessionmaker_np, learner):
        """`settled_micro - cost_micro`, and it must come out at about `margin_bps`.

        Asserted as a relationship rather than a number, so a deliberate reprice does not fail it
        while a units mix-up still does -- the discipline `test_pack_economics.py` was written for.
        """
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        await _grant(sessionmaker_np, learner, 1000 * rate)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=600 * rate, request_id="chatcmpl-margin",
                kind="chat", backend="sglang", rate_micro_per_slot_second=rate,
                pod_micro_per_hour=row.pod_micro_per_hour,
                nominal_concurrency=row.nominal_concurrency,
                margin_bps=row.margin_bps,
                pricing_measured=row.measured,
            )
        # Long enough that the per-second rounding is negligible against the ratio.
        async with sessionmaker_np() as db:
            await wallet.settle(db, reservation.id, slot_ms=600_000)

        async with sessionmaker_np() as db:
            settled = await db.get(GpuReservation, reservation.id)

        margin = settled.settled_micro - settled.cost_micro
        assert margin > 0, (
            f"a 600-second request billed {settled.settled_micro} and cost {settled.cost_micro}: "
            "serving it lost money. Check that the rate and the cost divide by the same concurrency."
        )
        # 15_000 bps means revenue is 1.5x cost, so margin is 0.5x cost. Two ceilings sit between
        # the two figures, so this is a band rather than an equality.
        implied_bps = (settled.settled_micro * 10_000) // settled.cost_micro
        assert abs(implied_bps - row.margin_bps) <= 20, (
            f"the row implies a {implied_bps} bps margin but the price says {row.margin_bps}"
        )

    async def test_a_voided_request_records_no_cost(self, sessionmaker_np, learner):
        """Nothing was consumed, so there is nothing to have cost anything.

        A zero here would be a lie of a different kind -- it would read as a free request rather
        than as one that never ran.
        """
        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        await _grant(sessionmaker_np, learner, 100 * rate)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=60 * rate, request_id="chatcmpl-void",
                kind="chat", backend="sglang", rate_micro_per_slot_second=rate,
                pod_micro_per_hour=row.pod_micro_per_hour,
                nominal_concurrency=row.nominal_concurrency,
                margin_bps=row.margin_bps,
                pricing_measured=row.measured,
            )
        async with sessionmaker_np() as db:
            assert await wallet.void(db, reservation.id) is True

        async with sessionmaker_np() as db:
            voided = await db.get(GpuReservation, reservation.id)
        assert voided.cost_micro is None

    async def test_a_reservation_without_a_basis_settles_without_one(
        self, sessionmaker_np, learner
    ):
        """Every row written before this existed. Reading one must not raise.

        The columns are nullable precisely so the sweep -- which voids a reservation without ever
        seeing a price -- and every pre-existing row keep working. A `NOT NULL` here would have
        turned an additive migration into an outage.
        """
        rate = 1000
        await _grant(sessionmaker_np, learner, 100_000)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=60_000, request_id="chatcmpl-nobasis",
                kind="chat", backend="hf", rate_micro_per_slot_second=rate,
            )
        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=30_000) is True

        async with sessionmaker_np() as db:
            settled = await db.get(GpuReservation, reservation.id)
        assert settled.settled_micro == 30_000, "billing broke when the cost basis was absent"
        assert settled.cost_micro is None

    async def test_the_cost_basis_is_the_one_quoted_at_hold_time(self, sessionmaker_np, learner):
        """A price change mid-flight must not move the cost any more than it moves the charge."""
        import dataclasses

        row = gpu_pricing.rate_for()
        rate = row.rate_micro_per_slot_second
        await _grant(sessionmaker_np, learner, 1000 * rate)

        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=600 * rate, request_id="chatcmpl-costdrift",
                kind="chat", backend="sglang", rate_micro_per_slot_second=rate,
                pod_micro_per_hour=row.pod_micro_per_hour,
                nominal_concurrency=row.nominal_concurrency,
                margin_bps=row.margin_bps,
                pricing_measured=row.measured,
            )

        dearer = tuple(
            dataclasses.replace(r, pod_micro_per_hour=r.pod_micro_per_hour * 10)
            for r in gpu_pricing.PRICING
        )
        original = gpu_pricing.PRICING
        try:
            gpu_pricing.PRICING = dearer
            async with sessionmaker_np() as db:
                await wallet.settle(db, reservation.id, slot_ms=30_000)
        finally:
            gpu_pricing.PRICING = original

        async with sessionmaker_np() as db:
            settled = await db.get(GpuReservation, reservation.id)
        expected = wallet.ceil_div(
            row.pod_micro_per_hour * 30_000, 3600 * 1000 * row.nominal_concurrency
        )
        assert settled.cost_micro == expected, (
            "the recorded cost moved with a price change that landed after the hold"
        )


class TestTheWiringPassesTheBasis:
    """`metering.begin()` is the only caller in production, so it is the one that must not forget.

    `reserve()` takes the basis optionally -- rows predating the columns legitimately have none --
    which means a caller that omits it produces a settled request with revenue and no cost, silently.
    This is the guard against that, in the source-scanning style the rest of the suite uses.
    """

    def test_begin_passes_every_cost_column(self):
        import ast
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1] / "src" / "metering.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        begin = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "begin"
        )
        body = ast.get_source_segment(source, begin) or ""
        for field in (
            "pod_micro_per_hour",
            "nominal_concurrency",
            "margin_bps",
            "pricing_measured",
        ):
            assert f"{field}=" in body, (
                f"`metering.begin()` no longer passes `{field}` to reserve(), so every request it "
                "meters will settle with revenue recorded and no cost beside it"
            )

