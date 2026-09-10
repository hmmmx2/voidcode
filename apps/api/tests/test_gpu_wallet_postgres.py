"""The money path against a real Postgres, including the race it exists to survive.

WHY THESE CANNOT BE SQLITE, EVEN MORE THAN THE REST OF THE SUITE

The conftest already refuses SQLite because the models use `postgresql.UUID` and JSON. These tests
add a harder reason: what is under test *is* Postgres behaviour. Row-level locking, `rowcount` from a
guarded UPDATE, CHECK constraint enforcement and partial indexes are the mechanism, not an
implementation detail behind it. A test that passed on SQLite would be testing something else.

Nothing in this suite exercised concurrency before this file. `test_two_concurrent_reserves...` is
the first, and it is the test the whole reservation design exists to pass.
"""

import asyncio
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.models.gpu_billing import GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.services import gpu_wallet_service as wallet

from conftest import TEST_DATABASE_URL, requires_postgres

pytestmark = [requires_postgres, pytest.mark.asyncio]

RATE = 1000  # micro-credits per slot-second, so 1000 ms of occupancy costs exactly 1000 micro.


@pytest_asyncio.fixture
async def sessionmaker_np():
    """NullPool, deliberately.

    With the default pool two "concurrent" sessions can be handed the SAME connection, which
    serialises them and makes the concurrency test below pass for entirely the wrong reason. NullPool
    guarantees two distinct backend processes, which is the only way the row lock is actually
    exercised.
    """
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def funded(sessionmaker_np):
    """A user with a wallet. Yields `(user_id, credit)` and cleans up in FK order."""
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"gpu-wallet-{user_id.hex[:12]}@example.test",
                name="GPU wallet test",
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


async def _reserve(sessionmaker_np, user_id, hold):
    async with sessionmaker_np() as db:
        return await wallet.reserve(
            db, user_id, hold_micro=hold, request_id="chatcmpl-test",
            kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
        )


async def _wallet_row(sessionmaker_np, user_id) -> GpuWallet:
    async with sessionmaker_np() as db:
        return await db.get(GpuWallet, user_id)


class TestHoldAndSettle:
    async def test_a_hold_moves_credit_between_buckets_without_spending_it(
        self, sessionmaker_np, funded
    ):
        await _grant(sessionmaker_np, funded, 10_000)
        await _reserve(sessionmaker_np, funded, 4_000)

        row = await _wallet_row(sessionmaker_np, funded)
        # The balance is the TOTAL and has not moved; only the reserved bucket has.
        assert row.balance_micro == 10_000
        assert row.reserved_micro == 4_000
        async with sessionmaker_np() as db:
            assert await wallet.available_micro(db, funded) == 6_000

    async def test_settling_charges_measured_occupancy_and_returns_the_rest(
        self, sessionmaker_np, funded
    ):
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 4_000)

        async with sessionmaker_np() as db:
            # 1500 ms at 1000 micro/second = 1500 micro. The other 2500 goes back.
            assert await wallet.settle(db, reservation.id, slot_ms=1500) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 8_500
        assert row.reserved_micro == 0

    async def test_a_settle_larger_than_the_hold_is_clamped_not_refused(
        self, sessionmaker_np, funded
    ):
        """Under-billing a pathological request is the correct failure direction.

        The alternative is charging more than the learner authorised before their request ran.
        """
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 2_000)

        async with sessionmaker_np() as db:
            # 9 seconds of occupancy would be 9000 micro against a 2000 hold.
            assert await wallet.settle(db, reservation.id, slot_ms=9000) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 8_000  # charged the hold, not the 9000
        assert row.reserved_micro == 0

    async def test_voiding_returns_the_whole_hold(self, sessionmaker_np, funded):
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 4_000)
        async with sessionmaker_np() as db:
            assert await wallet.void(db, reservation.id) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 10_000
        assert row.reserved_micro == 0


class TestIdempotency:
    async def test_settling_twice_charges_once(self, sessionmaker_np, funded):
        """A settle can genuinely run twice: the background task and then the sweep."""
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 4_000)

        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=1500) is True
        async with sessionmaker_np() as db:
            # The second call is refused by the `state == 'held'` predicate, not by an exception.
            assert await wallet.settle(db, reservation.id, slot_ms=1500) is False

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 8_500

        async with sessionmaker_np() as db:
            charges = (
                await db.execute(
                    select(GpuLedger).where(
                        GpuLedger.reservation_id == reservation.id,
                        GpuLedger.entry_type == "charge",
                    )
                )
            ).scalars().all()
        assert len(charges) == 1

    async def test_a_duplicate_ledger_key_is_refused_by_the_database(
        self, sessionmaker_np, funded
    ):
        """The second, independent guard. Asserts the CONSTRAINT, not the code avoiding it."""
        await _grant(sessionmaker_np, funded, 10_000)
        async with sessionmaker_np() as db:
            db.add(
                GpuLedger(
                    wallet_user_id=funded, entry_type="adjust", amount_micro=0,
                    balance_after_micro=10_000, idempotency_key="duplicate-on-purpose",
                )
            )
            await db.commit()
        with pytest.raises(IntegrityError):
            async with sessionmaker_np() as db:
                db.add(
                    GpuLedger(
                        wallet_user_id=funded, entry_type="adjust", amount_micro=0,
                        balance_after_micro=10_000, idempotency_key="duplicate-on-purpose",
                    )
                )
                await db.commit()

    async def test_granting_the_same_key_twice_credits_once(self, sessionmaker_np, funded):
        key = f"grant-once-{uuid.uuid4()}"
        async with sessionmaker_np() as db:
            assert await wallet.grant(db, funded, amount_micro=5_000, idempotency_key=key) is True
        async with sessionmaker_np() as db:
            assert await wallet.grant(db, funded, amount_micro=5_000, idempotency_key=key) is False

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 5_000


class TestTheDatabaseKeepsTheInvariants:
    """These assert the CHECK constraints, not the service that avoids tripping them.

    They are the reason the constraints were worth introducing to a codebase that had none: a
    service can be wrong, and these are what make "cannot" different from "should not".
    """

    async def test_a_wallet_cannot_reserve_more_than_it_holds(self, sessionmaker_np, funded):
        await _grant(sessionmaker_np, funded, 1_000)
        with pytest.raises(IntegrityError) as exc:
            async with sessionmaker_np() as db:
                await db.execute(
                    text(
                        "UPDATE gpu_wallets SET reserved_micro = 5000 WHERE user_id = :u"
                    ),
                    {"u": funded},
                )
                await db.commit()
        assert "ck_gpu_wallets_reserved_le_balance" in str(exc.value)

    async def test_a_balance_cannot_go_negative(self, sessionmaker_np, funded):
        with pytest.raises(IntegrityError) as exc:
            async with sessionmaker_np() as db:
                await db.execute(
                    text("UPDATE gpu_wallets SET balance_micro = -1 WHERE user_id = :u"),
                    {"u": funded},
                )
                await db.commit()
        assert "ck_gpu_wallets_balance_nonneg" in str(exc.value)

    async def test_a_settle_above_the_hold_cannot_be_written_even_directly(
        self, sessionmaker_np, funded
    ):
        """The promise: a learner is never charged more than was authorised before the request ran."""
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 2_000)
        with pytest.raises(IntegrityError) as exc:
            async with sessionmaker_np() as db:
                await db.execute(
                    text(
                        "UPDATE gpu_reservations SET state='settled', settled_micro=9999 "
                        "WHERE id = :r"
                    ),
                    {"r": reservation.id},
                )
                await db.commit()
        assert "ck_gpu_reservations_settled_le_hold" in str(exc.value)

    async def test_a_finished_reservation_cannot_lack_its_settled_amount(
        self, sessionmaker_np, funded
    ):
        """Stops a crash between two writes leaving "finished" half-recorded."""
        await _grant(sessionmaker_np, funded, 10_000)
        reservation = await _reserve(sessionmaker_np, funded, 2_000)
        with pytest.raises(IntegrityError) as exc:
            async with sessionmaker_np() as db:
                await db.execute(
                    text("UPDATE gpu_reservations SET state='settled' WHERE id = :r"),
                    {"r": reservation.id},
                )
                await db.commit()
        assert "ck_gpu_reservations_state_consistent" in str(exc.value)


class TestConcurrency:
    """The test this entire design exists to pass.

    Nothing else in the API suite exercises concurrency, so the mechanics matter as much as the
    assertion — three of them are easy to get wrong in ways that make the test pass vacuously:

      1. NullPool (in the fixture), or both sessions may share one connection and serialise.
      2. A barrier, so both transactions are genuinely open before either commits. Without it the
         second reserve reads an already-committed row and takes the trivial path instead of the
         lock path.
      3. Funding for exactly ONE hold, so "both succeeded" is actually possible if the guard is
         wrong. Over-funding would make the test pass no matter what.
    """

    async def test_two_concurrent_reserves_cannot_both_take_the_last_credit(
        self, sessionmaker_np, funded
    ):
        hold = 5_000
        await _grant(sessionmaker_np, funded, hold)  # enough for exactly one

        barrier = asyncio.Barrier(2)

        async def attempt() -> str:
            async with sessionmaker_np() as db:
                await barrier.wait()
                try:
                    await wallet.reserve(
                        db, funded, hold_micro=hold, request_id="chatcmpl-race",
                        kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
                    )
                    return "reserved"
                except wallet.InsufficientCredit:
                    return "refused"

        outcomes = sorted(await asyncio.gather(attempt(), attempt()))
        assert outcomes == ["refused", "reserved"], (
            f"a wallet funded for one hold produced {outcomes}; it oversold"
        )

        # The invariant afterwards matters as much as the return values.
        row = await _wallet_row(sessionmaker_np, funded)
        assert row.reserved_micro == hold
        assert row.reserved_micro <= row.balance_micro

        async with sessionmaker_np() as db:
            holds = (
                await db.execute(
                    select(GpuReservation).where(GpuReservation.wallet_user_id == funded)
                )
            ).scalars().all()
        assert len(holds) == 1, "two reservation rows exist for one affordable hold"

    async def test_ten_concurrent_reserves_take_exactly_the_affordable_number(
        self, sessionmaker_np, funded
    ):
        """Scaling the same property up, because a two-way race can pass by luck."""
        hold = 1_000
        await _grant(sessionmaker_np, funded, hold * 3)  # room for exactly three

        barrier = asyncio.Barrier(10)

        async def attempt() -> str:
            async with sessionmaker_np() as db:
                await barrier.wait()
                try:
                    await wallet.reserve(
                        db, funded, hold_micro=hold, request_id="chatcmpl-race",
                        kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
                    )
                    return "reserved"
                except wallet.InsufficientCredit:
                    return "refused"

        outcomes = await asyncio.gather(*[attempt() for _ in range(10)])
        assert outcomes.count("reserved") == 3, f"expected exactly 3 to win, got {outcomes}"

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.reserved_micro == hold * 3
        assert row.reserved_micro <= row.balance_micro


class TestTheFloorPrice:
    """Section 4.3 of the billing spec: "A one-token reply still occupied the GPU and still cost you."

    The floor exists because occupancy is not the whole cost. Scheduling, prompt processing and a
    share of the idle hour between questions are all real and none of them appear on the slot clock.
    Applying the floor only at the hold refuses a learner who cannot afford it without ever
    collecting it — which was the state this test was written against.
    """

    async def test_a_trivial_request_is_charged_the_floor_not_its_measured_cost(
        self, sessionmaker_np, funded
    ):
        await _grant(sessionmaker_np, funded, 100_000)
        reservation = await _reserve(sessionmaker_np, funded, 50_000)

        floor = 1_000
        async with sessionmaker_np() as db:
            # 40 ms at 1000 micro/slot-second measures 40 micro — far below the floor.
            assert await wallet.settle(db, reservation.id, slot_ms=40, floor_micro=floor) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 100_000 - floor, (
            "a 40ms reply was charged its measured cost rather than the floor"
        )

    async def test_a_substantial_request_is_charged_its_measured_cost_not_the_floor(
        self, sessionmaker_np, funded
    ):
        """The floor is a minimum, not a fee. Anything above it charges what it measured."""
        await _grant(sessionmaker_np, funded, 100_000)
        reservation = await _reserve(sessionmaker_np, funded, 50_000)

        async with sessionmaker_np() as db:
            # 30 seconds at 1000 micro/slot-second = 30_000 micro, well above a 1_000 floor.
            assert await wallet.settle(db, reservation.id, slot_ms=30_000, floor_micro=1_000) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 100_000 - 30_000

    async def test_the_floor_never_exceeds_the_authorised_hold(self, sessionmaker_np, funded):
        """Floor first, clamp second.

        A learner must never be charged more than was authorised before their request ran, even if
        someone later raises the floor above an in-flight hold.
        """
        await _grant(sessionmaker_np, funded, 100_000)
        reservation = await _reserve(sessionmaker_np, funded, 500)

        async with sessionmaker_np() as db:
            assert await wallet.settle(db, reservation.id, slot_ms=10, floor_micro=9_999) is True

        row = await _wallet_row(sessionmaker_np, funded)
        assert row.balance_micro == 100_000 - 500, "the floor was charged above the hold"
