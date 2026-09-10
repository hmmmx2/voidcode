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
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.models.gpu_billing import GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.services import gpu_pricing, gpu_sweep_service as sweep
from src.services import gpu_wallet_service as wallet

from conftest import TEST_DATABASE_URL, requires_postgres

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
    async def test_the_shipped_row_is_unmeasured_so_this_suite_proves_arithmetic_not_viability(
        self, sessionmaker_np, learner
    ):
        """The honesty guard, and the most important sentence in this file.

        Everything above proves the machinery charges what the price says. It does NOT prove the
        price is right, because the price is derived from a throughput figure nobody has measured
        for this model on this card. When a measured row replaces the placeholder, this test fails
        and whoever is here should re-read the assertions above with real numbers before deleting
        it.
        """
        row = gpu_pricing.rate_for()
        assert row.measured is False, (
            "the pricing row is now measured — re-run this suite against the real throughput "
            "figure and confirm a busy hour still covers the pod before removing this guard"
        )
