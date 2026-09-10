"""The fleet-wide serving budget, against a real Postgres.

WHY THESE CANNOT BE SQLITE, EVEN MORE THAN THE REST OF THE SUITE

What is under test IS Postgres behaviour. `FOR UPDATE SKIP LOCKED` is the mechanism, not an
implementation detail behind it -- it is the reason four replicas polling for a slot each get a
different row instead of queueing behind one another. A test that passed on SQLite would be testing
something else entirely.

THE TEST THAT MATTERS MOST IS `test_a_late_release_does_not_free_the_new_holders_slot`.

"A slot released twice" used to mean a semaphore released twice, which inflates a permit count. With
leases it means something nastier: a holder whose lease lapsed, whose slot was legitimately claimed
by somebody else, and which then returns and releases. Without the `holder = :me` predicate that
release frees a slot the new owner is actively using, and two requests end up on capacity sized for
one. The symptom is a backend that OOMs under a load its own metrics say it can carry.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.models.gpu_queue import STATE_ABANDONED, STATE_WAITING, GpuQueueTicket, GpuSlot
from src.services import queue_service as queue

from conftest import TEST_DATABASE_URL, requires_postgres

pytestmark = [requires_postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def sessionmaker_np():
    """NullPool, deliberately.

    With the default pool two "concurrent" sessions can be handed the SAME connection, which
    serialises them and makes every race here pass for entirely the wrong reason. NullPool
    guarantees distinct backend processes, which is the only way the row lock is exercised.
    """
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def clean_slots(sessionmaker_np):
    """Free every slot and clear every ticket, before and after.

    Slots are shared, seeded rows rather than per-test fixtures, so a test that left one held would
    silently reduce the capacity every later test measures against.
    """
    async def reset():
        async with sessionmaker_np() as db:
            await db.execute(update(GpuSlot).values(holder=None, leased_until=None))
            await db.execute(delete(GpuQueueTicket))
            await db.commit()

    await reset()
    yield
    await reset()


async def _capacity(sessionmaker_np) -> int:
    async with sessionmaker_np() as db:
        return await queue.capacity(db)


class TestTheBudgetIsTheRowCount:
    async def test_exactly_capacity_claims_succeed_and_the_next_does_not(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        assert n > 0, "no slots are seeded; the migration did not run"

        tickets = [uuid.uuid4() for _ in range(n)]
        claimed = []
        async with sessionmaker_np() as db:
            for t in tickets:
                claimed.append(await queue.try_claim(db, t))

        assert all(s is not None for s in claimed), f"only {len([s for s in claimed if s])} of {n}"
        assert len(set(claimed)) == n, "two tickets were given the same slot"

        async with sessionmaker_np() as db:
            assert await queue.try_claim(db, uuid.uuid4()) is None, "capacity was exceeded"

    async def test_releasing_one_lets_exactly_one_more_in(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        tickets = [uuid.uuid4() for _ in range(n)]
        async with sessionmaker_np() as db:
            slots = [await queue.try_claim(db, t) for t in tickets]
            assert await queue.try_claim(db, uuid.uuid4()) is None

            assert await queue.release(db, slots[0], tickets[0]) is True
            assert await queue.try_claim(db, uuid.uuid4()) is not None
            assert await queue.try_claim(db, uuid.uuid4()) is None


class TestConcurrentClaims:
    async def test_two_replicas_racing_for_one_slot_get_one_each_at_most(self, sessionmaker_np):
        """Fill every slot but one, then have two "replicas" go for it together."""
        n = await _capacity(sessionmaker_np)
        async with sessionmaker_np() as db:
            for _ in range(n - 1):
                assert await queue.try_claim(db, uuid.uuid4()) is not None

        barrier = asyncio.Barrier(2)

        async def attempt():
            async with sessionmaker_np() as db:
                await barrier.wait()
                return await queue.try_claim(db, uuid.uuid4())

        results = await asyncio.gather(attempt(), attempt())
        got = [r for r in results if r is not None]
        assert len(got) == 1, f"one free slot produced {len(got)} claims: {results}"

    async def test_ten_racing_for_one_slot_still_produce_one_claim(self, sessionmaker_np):
        """Two can serialise by accident. Ten will not."""
        n = await _capacity(sessionmaker_np)
        async with sessionmaker_np() as db:
            for _ in range(n - 1):
                await queue.try_claim(db, uuid.uuid4())

        barrier = asyncio.Barrier(10)

        async def attempt():
            async with sessionmaker_np() as db:
                await barrier.wait()
                return await queue.try_claim(db, uuid.uuid4())

        results = await asyncio.gather(*(attempt() for _ in range(10)))
        assert len([r for r in results if r is not None]) == 1

    async def test_a_full_scramble_never_double_books_a_slot(self, sessionmaker_np):
        """Every slot contended at once. No slot may be handed to two tickets."""
        n = await _capacity(sessionmaker_np)
        barrier = asyncio.Barrier(n * 2)

        async def attempt(ticket):
            async with sessionmaker_np() as db:
                await barrier.wait()
                return (ticket, await queue.try_claim(db, ticket))

        pairs = await asyncio.gather(*(attempt(uuid.uuid4()) for _ in range(n * 2)))
        won = [slot for _, slot in pairs if slot is not None]
        assert len(won) == n, f"{len(won)} claims against {n} slots"
        assert len(set(won)) == n, "a slot was handed out twice"


class TestLeases:
    async def test_a_lapsed_lease_is_claimable_by_somebody_else(self, sessionmaker_np):
        """The self-healing property. A replica killed mid-request frees its slot by expiring."""
        dead = uuid.uuid4()
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, dead)
            # Its replica is gone, so nothing renewed. Age the lease rather than sleeping 60s.
            await db.execute(
                update(GpuSlot)
                .where(GpuSlot.id == slot)
                .values(leased_until=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await db.commit()

        successor = uuid.uuid4()
        async with sessionmaker_np() as db:
            assert await queue.try_claim(db, successor) == slot, (
                "a lapsed slot was not reclaimed; a killed replica would strand capacity forever"
            )

    async def test_a_late_release_does_not_free_the_new_holders_slot(self, sessionmaker_np):
        """THE ONE THIS FILE EXISTS FOR.

        The original holder lapsed, somebody else took the slot, and now the original returns and
        releases. Without the `holder = :me` predicate it frees a slot that is actively in use, and
        two requests land on capacity sized for one.
        """
        original = uuid.uuid4()
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, original)
            await db.execute(
                update(GpuSlot)
                .where(GpuSlot.id == slot)
                .values(leased_until=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await db.commit()

        successor = uuid.uuid4()
        async with sessionmaker_np() as db:
            assert await queue.try_claim(db, successor) == slot

        async with sessionmaker_np() as db:
            freed = await queue.release(db, slot, original)
        assert freed is False, "a lapsed holder released a slot it no longer owned"

        async with sessionmaker_np() as db:
            row = await db.get(GpuSlot, slot)
        assert row.holder == successor, (
            "the late release handed the new holder's slot back to the pool while it was in use"
        )

    async def test_a_lapsed_holder_cannot_renew_its_way_back_on_top(self, sessionmaker_np):
        """The mirror image, and the likelier of the two.

        A renewal that did not check `holder` would let a holder whose lease had already lapsed
        push the lease out again -- over whoever legitimately claimed the slot in the meantime.
        """
        original = uuid.uuid4()
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, original)
            await db.execute(
                update(GpuSlot)
                .where(GpuSlot.id == slot)
                .values(leased_until=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await db.commit()

        successor = uuid.uuid4()
        async with sessionmaker_np() as db:
            await queue.try_claim(db, successor)

        async with sessionmaker_np() as db:
            assert await queue.renew(db, slot, original) is False

        async with sessionmaker_np() as db:
            row = await db.get(GpuSlot, slot)
        assert row.holder == successor

    async def test_renewing_keeps_a_slot_out_of_reach(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        mine = uuid.uuid4()
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, mine)
            for _ in range(n - 1):
                await queue.try_claim(db, uuid.uuid4())
            assert await queue.renew(db, slot, mine) is True
            assert await queue.try_claim(db, uuid.uuid4()) is None

    async def test_in_use_counts_leases_not_holder_columns(self, sessionmaker_np):
        """A lapsed slot is free, whatever its `holder` says. Utilisation must agree."""
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, uuid.uuid4())
            assert await queue.slots_in_use(db) == 1
            await db.execute(
                update(GpuSlot)
                .where(GpuSlot.id == slot)
                .values(leased_until=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await db.commit()
            assert await queue.slots_in_use(db) == 0


class TestTheQueue:
    async def test_position_counts_only_who_is_ahead(self, sessionmaker_np):
        user = uuid.uuid4()
        async with sessionmaker_np() as db:
            first = await queue.enqueue(db, user, "chatcmpl-1", max_depth=100)
            second = await queue.enqueue(db, user, "chatcmpl-2", max_depth=100)
            third = await queue.enqueue(db, user, "chatcmpl-3", max_depth=100)

            assert await queue.position(db, first) == 1
            assert await queue.position(db, second) == 2
            assert await queue.position(db, third) == 3

    async def test_position_improves_when_somebody_ahead_leaves(self, sessionmaker_np):
        user = uuid.uuid4()
        async with sessionmaker_np() as db:
            first = await queue.enqueue(db, user, "chatcmpl-1", max_depth=100)
            second = await queue.enqueue(db, user, "chatcmpl-2", max_depth=100)
            assert await queue.position(db, second) == 2

            await queue.abandon(db, first.id)
            assert await queue.position(db, second) == 1, (
                "an abandoned ticket still counted, so everybody behind it waits on nobody"
            )

    async def test_a_full_queue_refuses_at_the_door(self, sessionmaker_np):
        user = uuid.uuid4()
        async with sessionmaker_np() as db:
            for i in range(3):
                await queue.enqueue(db, user, f"chatcmpl-{i}", max_depth=3)
            with pytest.raises(queue.QueueFull):
                await queue.enqueue(db, user, "chatcmpl-over", max_depth=3)

    async def test_an_abandoned_ticket_is_recorded_not_deleted(self, sessionmaker_np):
        """Depth over time stays readable, which is the only way to know the ceiling is right."""
        user = uuid.uuid4()
        async with sessionmaker_np() as db:
            ticket = await queue.enqueue(db, user, "chatcmpl-x", max_depth=10)
            await queue.abandon(db, ticket.id)
            row = await db.get(GpuQueueTicket, ticket.id)
        assert row is not None and row.state == STATE_ABANDONED


class TestWaiting:
    async def test_a_waiter_is_admitted_when_a_slot_frees(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        holders = [uuid.uuid4() for _ in range(n)]
        async with sessionmaker_np() as db:
            slots = [await queue.try_claim(db, t) for t in holders]

        seen: list[int] = []

        async def report(pos):
            seen.append(pos)

        async def free_one_shortly():
            await asyncio.sleep(0.5)
            async with sessionmaker_np() as db:
                await queue.release(db, slots[0], holders[0])

        waiter = asyncio.create_task(
            queue.wait_for_slot(
                sessionmaker_np, uuid.uuid4(), "chatcmpl-wait",
                max_wait_seconds=20, max_depth=100, on_position=report,
            )
        )
        await free_one_shortly()
        ticket_id, slot_id = await waiter

        assert slot_id == slots[0]
        assert seen and seen[0] == 1, f"position was reported as {seen}"

    async def test_a_waiter_that_times_out_abandons_its_ticket(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        async with sessionmaker_np() as db:
            for _ in range(n):
                await queue.try_claim(db, uuid.uuid4())

        with pytest.raises(queue.QueueTimeout):
            await queue.wait_for_slot(
                sessionmaker_np, uuid.uuid4(), "chatcmpl-timeout",
                max_wait_seconds=1, max_depth=100,
            )

        async with sessionmaker_np() as db:
            waiting = await queue.waiting_count(db)
        assert waiting == 0, "a timed-out waiter still counts in everybody else's position"

    async def test_a_disconnected_caller_never_takes_a_slot(self, sessionmaker_np):
        """The scarcest thing here is a slot. Admitting a caller who left spends one on nobody."""
        async def gone():
            return True

        with pytest.raises(queue.QueueTimeout):
            await queue.wait_for_slot(
                sessionmaker_np, uuid.uuid4(), "chatcmpl-gone",
                max_wait_seconds=10, max_depth=100, is_disconnected=gone,
            )

        async with sessionmaker_np() as db:
            assert await queue.slots_in_use(db) == 0
            assert await queue.waiting_count(db) == 0

    async def test_a_cancelled_waiter_does_not_linger_in_the_queue(self, sessionmaker_np):
        n = await _capacity(sessionmaker_np)
        async with sessionmaker_np() as db:
            for _ in range(n):
                await queue.try_claim(db, uuid.uuid4())

        task = asyncio.create_task(
            queue.wait_for_slot(
                sessionmaker_np, uuid.uuid4(), "chatcmpl-cancel",
                max_wait_seconds=30, max_depth=100,
            )
        )
        await asyncio.sleep(0.3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        async with sessionmaker_np() as db:
            assert await queue.waiting_count(db) == 0
