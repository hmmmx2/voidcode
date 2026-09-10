"""Spin-down must never take the GPU away from somebody who is using it.

EACH CLAUSE OF THE IDLE PREDICATE IS TESTED ALONE, AND THAT IS THE WHOLE POINT OF THIS FILE.

The predicate has four parts: no held reservation, no queued ticket, no leased slot, and nothing
settled recently. A single test that sets up a busy system and asserts "not idle" passes with two of
the three instantaneous clauses missing -- so it would not notice a refactor that dropped one, and
the way that presents is a learner's answer dying mid-stream.

So there is one test per clause, each establishing exactly that clause and nothing else.

The fourth clause is the one that is easy to argue away and hardest to test: the other three are
instantaneous, so without a recency window spin-down fires in the gap between one request finishing
and the next arriving. A learner reading an answer before asking a follow-up pays a multi-minute
cold start for the privilege.
"""

import ast
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from src import config
from src.models.gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet
from src.models.gpu_queue import STATE_ADMITTED, GpuQueueTicket, GpuSlot
from src.models.user import User
from src.services import gpu_wallet_service as wallet
from src.services import queue_service as queue
from src.services import runpod_client, spindown

pytestmark = [requires_postgres, pytest.mark.asyncio]

RATE = 1000


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def clean(sessionmaker_np):
    """Slots and tickets are shared rows; a test that left one held would make every later test
    read as busy for a reason that has nothing to do with it."""
    async def reset():
        async with sessionmaker_np() as db:
            await db.execute(update(GpuSlot).values(holder=None, leased_until=None))
            await db.execute(delete(GpuQueueTicket))
            await db.commit()

    await reset()
    yield
    await reset()


@pytest_asyncio.fixture
async def learner(sessionmaker_np):
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"spindown-{user_id.hex[:12]}@example.test",
                name="spindown test",
                role="student",
            )
        )
        await db.flush()
        db.add(GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0))
        await db.commit()
    yield user_id
    async with sessionmaker_np() as db:
        await db.execute(delete(GpuLedger).where(GpuLedger.wallet_user_id == user_id))
        await db.execute(delete(GpuGrantKey).where(GpuGrantKey.user_id == user_id))
        await db.execute(delete(GpuReservation).where(GpuReservation.wallet_user_id == user_id))
        await db.execute(delete(GpuWallet).where(GpuWallet.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


async def _grant(sessionmaker_np, user_id, amount):
    async with sessionmaker_np() as db:
        await wallet.grant(db, user_id, amount_micro=amount, idempotency_key=f"sd:{uuid.uuid4()}")


async def _age_every_settle(sessionmaker_np, seconds: int) -> None:
    """Push every settled_at into the past, so only the clause under test decides the outcome.

    Reservations from other tests persist in this database. Without this, the recency clause would
    hold the pod open for reasons belonging to somebody else's test.
    """
    async with sessionmaker_np() as db:
        await db.execute(
            update(GpuReservation)
            .where(GpuReservation.settled_at.is_not(None))
            .values(settled_at=datetime.now(UTC) - timedelta(seconds=seconds))
        )
        await db.commit()


class TestEachClauseAloneHoldsThePodOpen:
    async def test_a_held_reservation_is_not_idle(self, sessionmaker_np, learner):
        """Credit is committed and a request is in flight."""
        await _age_every_settle(sessionmaker_np, 99_999)
        await _grant(sessionmaker_np, learner, 100_000)
        async with sessionmaker_np() as db:
            await wallet.reserve(
                db, learner, hold_micro=50_000, request_id="chatcmpl-sd",
                kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
            )

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.held_reservations == 1
        assert report.is_idle(1.0) is False, (
            "spin-down would have stopped the pod with a request in flight"
        )
        assert "held reservation" in report.why_busy(1.0)

    async def test_a_waiting_ticket_is_not_idle(self, sessionmaker_np, learner):
        """Somebody is in line. Stopping here refuses the request we were about to serve."""
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            await queue.enqueue(db, learner, "chatcmpl-waiting", max_depth=10)

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.queued_tickets == 1
        assert report.is_idle(1.0) is False
        assert "queued ticket" in report.why_busy(1.0)

    async def test_an_admitted_ticket_is_not_idle(self, sessionmaker_np, learner):
        """Let in, but has not taken a slot yet -- the narrowest window, and a real one."""
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            ticket = await queue.enqueue(db, learner, "chatcmpl-admitted", max_depth=10)
            await db.execute(
                update(GpuQueueTicket)
                .where(GpuQueueTicket.id == ticket.id)
                .values(state=STATE_ADMITTED)
            )
            await db.commit()

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.queued_tickets == 1
        assert report.is_idle(1.0) is False

    async def test_a_leased_slot_is_not_idle(self, sessionmaker_np):
        """The authoritative clause: what is actually held, not what the database was told."""
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            assert await queue.try_claim(db, uuid.uuid4()) is not None

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.leased_slots == 1
        assert report.is_idle(1.0) is False
        assert "leased slot" in report.why_busy(1.0)

    async def test_a_recent_settle_is_not_idle(self, sessionmaker_np, learner):
        """The clause that is easy to argue away.

        Every other clause is instantaneous, so without this one spin-down fires in the gap between
        one request finishing and the next arriving -- and a learner reading an answer before asking
        a follow-up pays a multi-minute cold start for it.
        """
        await _age_every_settle(sessionmaker_np, 99_999)
        await _grant(sessionmaker_np, learner, 100_000)
        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=50_000, request_id="chatcmpl-recent",
                kind="chat", backend="hf", rate_micro_per_slot_second=RATE,
            )
        async with sessionmaker_np() as db:
            await wallet.settle(db, reservation.id, slot_ms=1000)

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.held_reservations == 0
        assert report.leased_slots == 0
        assert report.queued_tickets == 0
        assert report.is_idle(600) is False, (
            "nothing was in flight, but a request had just finished — a follow-up question would "
            "have paid a cold start"
        )
        assert "last settle" in report.why_busy(600)


class TestWhenItIsActuallyIdle:
    async def test_a_quiet_system_is_idle(self, sessionmaker_np):
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.is_idle(600) is True
        assert report.why_busy(600) == "idle"

    async def test_a_lapsed_lease_does_not_hold_it_open(self, sessionmaker_np):
        """A slot whose holder died is free. Counting it as busy would keep a pod alive forever
        after one crashed replica."""
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            slot = await queue.try_claim(db, uuid.uuid4())
            await db.execute(
                update(GpuSlot)
                .where(GpuSlot.id == slot)
                .values(leased_until=datetime.now(UTC) - timedelta(seconds=1))
            )
            await db.commit()

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.leased_slots == 0
        assert report.is_idle(600) is True

    async def test_an_abandoned_ticket_does_not_hold_it_open(self, sessionmaker_np, learner):
        await _age_every_settle(sessionmaker_np, 99_999)
        async with sessionmaker_np() as db:
            ticket = await queue.enqueue(db, learner, "chatcmpl-gone", max_depth=10)
            await queue.abandon(db, ticket.id)

        async with sessionmaker_np() as db:
            report = await spindown.measure(db)
        assert report.queued_tickets == 0
        assert report.is_idle(600) is True


class TestItIsInertUnlessArmed:
    async def test_it_does_nothing_when_spindown_is_disabled(self, monkeypatch):
        monkeypatch.setattr(config, "SPINDOWN_ENABLED", False)
        called = []
        monkeypatch.setattr(runpod_client, "stop", lambda: called.append("stop"))
        assert await spindown.consider_stopping() is False
        assert called == []

    async def test_it_does_nothing_when_pod_control_is_not_armed(self, monkeypatch):
        """Enabled but unarmed must be silent, not a decision it cannot carry out.

        A watcher that measured idleness and then found it had no authority would log a decision it
        never had, which is how a log stops being trustworthy.
        """
        monkeypatch.setattr(config, "SPINDOWN_ENABLED", True)
        monkeypatch.setattr(config, "POD_CONTROL_ENABLED", False)
        called = []
        monkeypatch.setattr(runpod_client, "stop", lambda: called.append("stop"))
        assert await spindown.consider_stopping() is False
        assert called == []

    async def test_the_watch_loop_exits_immediately_when_disabled(self, monkeypatch):
        """Not a task that wakes every two minutes to decide it may do nothing."""
        monkeypatch.setattr(config, "SPINDOWN_ENABLED", False)
        await spindown.watch_loop(interval_seconds=0.01)

    def test_it_ships_disabled(self):
        """The shipped default, read from `config.py` rather than from the running configuration.

        Reading the live value made this fail on any machine where somebody had deliberately armed
        pod control in their own `.env` — punishing the intended workflow rather than guarding
        anything. `test_runpod_pod_control.py::test_it_ships_disarmed` holds the same line for both
        switches; this one is kept so the spin-down suite fails on its own if that changes.
        """
        import re
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "src" / "config.py").read_text(
            encoding="utf-8"
        )
        match = re.search(r'SPINDOWN_ENABLED\s*=\s*_flag\(\s*"SPINDOWN_ENABLED"\s*,\s*default=(\w+)', source)
        assert match is not None and match.group(1) == "False", (
            "spin-down no longer ships disabled, so a deployment that never opted in could stop "
            "its own backend"
        )


class TestBothHalvesAreConnected:
    """A stop needs a start, and for a long time only the stop was wired.

    `watch_loop` has been started from the lifespan since the feature landed. `ensure_awake` was
    written at the same time, tested, documented -- and called from nowhere. Arming
    `SPINDOWN_ENABLED` would therefore have stopped the pod once and left it stopped, with every
    request after that failing against a backend nothing was going to restart.

    That is strictly worse than having no spin-down: it converts a bill into an outage, and an
    outage whose cause is a feature working exactly as designed. Neither half is useful alone, so
    both are pinned here.

    Text and AST scans rather than imports, because `conftest.py` records that tests must never
    import `main` -- it pulls torch at module scope.
    """

    MAIN = Path(__file__).resolve().parents[1] / "src" / "main.py"

    def test_the_watcher_is_started_from_the_lifespan(self):
        source = self.MAIN.read_text(encoding="utf-8")
        starts = re.findall(r"asyncio\.create_task\(spindown\.watch_loop\(\)\)", source)
        assert len(starts) == 1, (
            f"expected exactly one place starting the idle watcher, found {len(starts)} -- "
            "without it nothing ever stops the pod and SPINDOWN_ENABLED does nothing")

    def test_something_wakes_the_pod_again(self):
        """THE ONE THAT WAS MISSING.

        Without a caller, `ensure_awake` is dead code and spin-down is a one-way door.
        """
        source = self.MAIN.read_text(encoding="utf-8")
        calls = re.findall(r"await spindown\.ensure_awake\(\)", source)
        assert len(calls) == 1, (
            f"expected exactly one call to ensure_awake, found {len(calls)} -- if the pod can be "
            "stopped and nothing starts it, the first request after an idle period fails forever")

    def test_the_wake_happens_before_the_request_tries_to_use_the_backend(self):
        """Waking after taking a slot would hold capacity open across a cold start.

        The capacity gate is where a request commits to a slot or a queue position. Asking the pod
        to come back has to happen before that, or a multi-minute wake is spent holding a resource
        every other learner is waiting for.
        """
        source = self.MAIN.read_text(encoding="utf-8")
        wake = source.index("await spindown.ensure_awake()")
        capacity = source.index("# ── Capacity ─")
        assert wake < capacity, (
            "ensure_awake runs after the capacity gate; a cold start would be spent holding a slot")

    def test_the_watcher_is_cancelled_at_shutdown(self):
        """A spin-down decision taken during shutdown reads a system that is idle only because it
        is stopping."""
        source = self.MAIN.read_text(encoding="utf-8")
        assert "_spindown_task.cancel()" in source, (
            "the idle watcher is no longer cancelled at shutdown")

    def test_waking_does_not_block_the_request(self):
        """`ensure_awake` must fire and return, not wait for readiness.

        A cold start is minutes. Waiting inside the request holds the connection open for all of
        it and then times out anyway; the queue frame's `backendState: "waking"` is the channel
        built for saying so.
        """
        spindown_source = (
            Path(__file__).resolve().parents[1] / "src" / "services" / "spindown.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(spindown_source)
        function = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "ensure_awake"
        )
        waits = [
            node for node in ast.walk(function)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"sleep", "wait_for"}
        ]
        assert not waits, (
            "ensure_awake now waits for the backend; a cold start would block the request that "
            "triggered it for minutes")
