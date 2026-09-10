"""The recovery sweep, against a real Postgres.

The sweep is the only backstop for a hold whose request died between releasing its permit and
settling. Everything else in the metering path is allowed to fail loudly *because* this exists, so
these tests are load-bearing for that argument rather than for the sweep alone.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.models.gpu_billing import GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.services import gpu_sweep_service as sweep
from src.services import gpu_wallet_service as wallet

from conftest import TEST_DATABASE_URL, requires_postgres

pytestmark = [requires_postgres, pytest.mark.asyncio]

RATE = 1000


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def funded(sessionmaker_np):
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"gpu-sweep-{user_id.hex[:12]}@example.test",
                name="GPU sweep test",
                role="student",
            )
        )
        await db.flush()
        db.add(GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0))
        await db.commit()
    async with sessionmaker_np() as db:
        await wallet.grant(db, user_id, amount_micro=50_000, idempotency_key=f"g:{uuid.uuid4()}")

    yield user_id

    async with sessionmaker_np() as db:
        await db.execute(delete(GpuLedger).where(GpuLedger.wallet_user_id == user_id))
        await db.execute(delete(GpuReservation).where(GpuReservation.wallet_user_id == user_id))
        await db.execute(delete(GpuWallet).where(GpuWallet.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


async def _stranded(sessionmaker_np, user_id, *, hold=4_000, age_seconds=3600):
    """A hold whose request died: reserved, then backdated so the sweep will see it."""
    async with sessionmaker_np() as db:
        reservation = await wallet.reserve(
            db, user_id, hold_micro=hold, request_id="chatcmpl-stranded",
            kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
        )
    async with sessionmaker_np() as db:
        await db.execute(
            update(GpuReservation)
            .where(GpuReservation.id == reservation.id)
            .values(created_at=datetime.now(timezone.utc) - timedelta(seconds=age_seconds))
        )
        await db.commit()
    return reservation


class TestTheSweepReleasesWhatDied:
    async def test_a_stranded_hold_is_returned_to_the_wallet(self, sessionmaker_np, funded):
        await _stranded(sessionmaker_np, funded, hold=4_000)

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
            assert row.reserved_micro == 4_000, "precondition: the hold is outstanding"

        async with sessionmaker_np() as db:
            # The sweep is global -- it is a background job over the whole table -- so the return
            # count depends on what else is stranded. This test owns one wallet, so it asserts the
            # effect on that wallet rather than a number it does not control.
            assert await sweep.sweep_stale_reservations(db, max_age_seconds=60) >= 1

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
        # Voided, not charged: the measurement was lost, so any amount would be a guess.
        assert row.reserved_micro == 0
        assert row.balance_micro == 50_000

    async def test_a_young_hold_is_left_alone(self, sessionmaker_np, funded):
        """The sweep must not race the settle it backs up, or slow requests get voided mid-flight."""
        await _stranded(sessionmaker_np, funded, hold=4_000, age_seconds=5)

        async with sessionmaker_np() as db:
            assert await sweep.sweep_stale_reservations(db, max_age_seconds=900) == 0

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
        assert row.reserved_micro == 4_000

    async def test_a_settled_reservation_is_not_swept_again(self, sessionmaker_np, funded):
        reservation = await _stranded(sessionmaker_np, funded, hold=4_000)
        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=1000) is True

        async with sessionmaker_np() as db:
            assert await sweep.sweep_stale_reservations(db, max_age_seconds=60) == 0

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
        # Charged once for the second it actually held, and the hold returned. Not double-counted.
        assert row.balance_micro == 49_000
        assert row.reserved_micro == 0

    async def test_a_late_settle_after_a_sweep_does_not_charge(self, sessionmaker_np, funded):
        """The real race: the pod comes back and its settle task fires after the sweep voided it.

        The `state == 'held'` predicate is what refuses it, so the learner is not charged for a
        request whose credit was already returned.
        """
        reservation = await _stranded(sessionmaker_np, funded, hold=4_000)
        async with sessionmaker_np() as db:
            assert await sweep.sweep_stale_reservations(db, max_age_seconds=60) >= 1
        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=1000) is False

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
        assert row.balance_micro == 50_000
        assert row.reserved_micro == 0


class TestTwoReplicasSweepingAtOnce:
    async def test_one_stranded_hold_is_released_exactly_once(self, sessionmaker_np, funded):
        """Every replica runs its own sweep loop; nothing elects a leader.

        Releasing twice would credit the wallet twice for one hold, which is the sweep turning into
        a way to mint credit. The guarded UPDATE with RETURNING is what prevents it: each caller
        gets back only the rows it actually claimed.
        """
        await _stranded(sessionmaker_np, funded, hold=4_000)

        barrier = asyncio.Barrier(2)

        async def replica() -> int:
            async with sessionmaker_np() as db:
                await barrier.wait()
                return await sweep.sweep_stale_reservations(db, max_age_seconds=60)

        await asyncio.gather(replica(), replica())

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
            releases = (
                await db.execute(
                    select(GpuLedger).where(
                        GpuLedger.wallet_user_id == funded, GpuLedger.entry_type == "release"
                    )
                )
            ).scalars().all()

        assert row.reserved_micro == 0
        assert row.balance_micro == 50_000, "the wallet was credited more than once"
        # One release row for one hold. Two replicas both claiming it would produce two, or would
        # be refused by `uq_gpu_ledger_idempotency_key` and lose the whole pass -- either way this
        # is the assertion that catches it.
        assert len(releases) == 1


class TestReconciliationReportsAndDoesNotRepair:
    async def test_a_wallet_matching_its_ledger_is_not_reported(self, sessionmaker_np, funded):
        async with sessionmaker_np() as db:
            drift = await sweep.reconcile_wallets(db)
        assert [row for row in drift if row[0] == funded] == []

    async def test_a_drifted_wallet_is_reported_and_left_untouched(self, sessionmaker_np, funded):
        """Repairing would erase the evidence of whatever caused the drift.

        A billing system that silently corrects itself is one nobody can audit, so the contract is
        report-only — asserted by checking the wrong number is still wrong afterwards.
        """
        async with sessionmaker_np() as db:
            await db.execute(
                text("UPDATE gpu_wallets SET balance_micro = 12345 WHERE user_id = :u"),
                {"u": funded},
            )
            await db.commit()

        async with sessionmaker_np() as db:
            drift = await sweep.reconcile_wallets(db)
        mine = [row for row in drift if row[0] == funded]
        assert len(mine) == 1
        assert mine[0][1] == 12345  # the wallet
        assert mine[0][2] == 50_000  # what the ledger says it should be

        async with sessionmaker_np() as db:
            row = await db.get(GpuWallet, funded)
        assert row.balance_micro == 12345, "reconciliation repaired the wallet instead of reporting"
