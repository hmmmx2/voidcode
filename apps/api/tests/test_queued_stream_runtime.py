"""`_queued_stream` is actually run here, not scanned.

WHY THIS FILE BREAKS THE SUITE'S OWN RULE ABOUT IMPORTING `main`

`conftest.py` states that tests must not import `main`, because it pulls torch at module scope and
the suite must not depend on the inference stack. Every other guard on this endpoint therefore reads
its source as text or AST.

That rule has a cost, and this session paid it. A lease was threaded through six release sites by
editing each to read `lease=slot_lease`; one of them was inside a module-level generator where that
name does not exist, and every streaming request would have raised `NameError` while releasing its
slot. 419 tests passed. None of them ran the generator.

`_queued_stream` is a new generator carrying the release of a permit, a fleet slot and a learner's
credit, with five exit paths. Guarding that by reading the source would repeat the mistake. So this
module imports `main` and drives the generator, and skips cleanly where torch is absent — the same
bargain `requires_postgres` makes, with the same obligation on whoever runs the suite to look at the
skip count rather than only the pass count.

Generation itself is stubbed. What is under test is the control flow around it: what gets emitted,
what gets acquired, and — above all — what gets released on each of the ways out.
"""

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from fastapi import HTTPException
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

main = pytest.importorskip(
    "src.main",
    reason="`main` needs torch; this is the one module in the suite that imports it",
)

from src import config  # noqa: E402
from src.models.gpu_queue import GpuQueueTicket, GpuSlot  # noqa: E402
from src.services import queue_service  # noqa: E402

pytestmark = [requires_postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def clean(sessionmaker_np, monkeypatch):
    """Free every slot, clear every ticket, and keep metering out of it.

    Metering is a separate subsystem with its own suite. Leaving it on here would make these tests
    depend on a funded wallet to prove something about generator control flow.
    """
    monkeypatch.setattr(config, "GPU_METERING_ENABLED", False)
    monkeypatch.setattr(config, "GPU_QUEUE_MAX_WAIT_SECONDS", 3.0)
    monkeypatch.setattr(config, "GPU_QUEUE_MAX_DEPTH", 50)

    # `_queued_stream` reaches for the application's own sessionmaker. Point it at the test's
    # NullPool one, so the generator and the fixtures are looking at the same connections rather
    # than at two pools that happen to address the same database -- which is how a test ends up
    # asserting against state its own setup cannot see.
    monkeypatch.setattr(main, "AsyncSessionLocal", sessionmaker_np)

    async def reset():
        async with sessionmaker_np() as db:
            await db.execute(update(GpuSlot).values(holder=None, leased_until=None))
            await db.execute(delete(GpuQueueTicket))
            await db.commit()

    await reset()
    yield
    await reset()


class _FakeRequest:
    """Stands in for the Starlette request. Only `is_disconnected` is ever consulted."""

    def __init__(self, disconnected: bool = False):
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


class _Caller:
    def __init__(self):
        self.user_id = uuid.uuid4()
        self.verified = True
        self.is_anonymous = False


def _stub_generation(monkeypatch, chunks=("hello", " world")):
    """Replace the backend with a generator that yields known frames."""

    async def fake_stream():
        for c in chunks:
            yield f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}\n\n"
        yield "data: [DONE]\n\n"

    def fake_stream_for(request, request_id, prepared):
        return fake_stream(), {}

    monkeypatch.setattr(main, "_stream_for", fake_stream_for)

    async def fake_prepare(request, caller, request_id):
        return main._Prepared(None, [], "general", "hi", None)

    monkeypatch.setattr(main, "_prepare_for_generation", fake_prepare)


async def _drain(agen) -> list[str]:
    return [frame async for frame in agen]


async def _fill_every_slot(sessionmaker_np) -> list:
    """Occupy the whole fleet budget, so the next request must queue."""
    held = []
    async with sessionmaker_np() as db:
        capacity = await queue_service.capacity(db)
        for _ in range(capacity):
            ticket = uuid.uuid4()
            slot = await queue_service.try_claim(db, ticket)
            assert slot is not None
            held.append((ticket, slot))
    return held


class TestAQueuedRequestReportsItsPosition:
    async def test_it_emits_positions_then_the_answer(
        self, sessionmaker_np, monkeypatch
    ):
        """The whole point of the change: the learner hears something before the answer."""
        _stub_generation(monkeypatch)
        monkeypatch.setattr(main, "USE_SGLANG", False)
        held = await _fill_every_slot(sessionmaker_np)

        async def free_one_shortly():
            await asyncio.sleep(0.6)
            async with sessionmaker_np() as db:
                await queue_service.release(db, held[0][1], held[0][0])

        freeing = asyncio.create_task(free_one_shortly())
        frames = await _drain(
            main._queued_stream(object(), _Caller(), _FakeRequest(), "chatcmpl-q1")
        )
        await freeing

        joined = "".join(frames)
        assert ": queue position" in joined, "no position was ever reported to the caller"
        assert "hello" in joined and " world" in joined, "the answer never arrived"
        assert joined.index(": queue position") < joined.index("hello"), (
            "the position was reported after the answer, which helps nobody"
        )

    async def test_the_position_frame_is_a_valid_openai_chunk(
        self, sessionmaker_np, monkeypatch
    ):
        """A strict client -- the desktop app -- must render it as nothing, not choke on it."""
        _stub_generation(monkeypatch)
        monkeypatch.setattr(main, "USE_SGLANG", False)
        held = await _fill_every_slot(sessionmaker_np)

        async def free_one_shortly():
            await asyncio.sleep(0.6)
            async with sessionmaker_np() as db:
                await queue_service.release(db, held[0][1], held[0][0])

        freeing = asyncio.create_task(free_one_shortly())
        frames = await _drain(
            main._queued_stream(object(), _Caller(), _FakeRequest(), "chatcmpl-q2")
        )
        await freeing

        queue_frames = [f for f in frames if '"type": "queue"' in f]
        assert queue_frames, "no queue frame was emitted"

        for frame in queue_frames:
            assert frame.startswith(": queue position "), "the SSE comment heartbeat is missing"
            payload = frame.split("data: ", 1)[1].strip()
            chunk = json.loads(payload)
            assert chunk["object"] == "chat.completion.chunk"
            assert chunk["choices"][0]["delta"] == {}, (
                "the delta is not empty, so a strict OpenAI client would render queue noise into "
                "the learner's answer"
            )
            assert chunk["queue"]["position"] >= 1
            assert chunk["id"] == "chatcmpl-q2", (
                "the frame carries a different id from the request, so nothing can be correlated"
            )


class TestEveryExitReleasesExactlyWhatItTook:
    """The property the NameError would have broken, tested by running the code rather than reading it."""

    async def test_a_completed_stream_gives_the_slot_back(
        self, sessionmaker_np, monkeypatch
    ):
        _stub_generation(monkeypatch)
        monkeypatch.setattr(main, "USE_SGLANG", False)
        held = await _fill_every_slot(sessionmaker_np)

        async def free_one_shortly():
            await asyncio.sleep(0.6)
            async with sessionmaker_np() as db:
                await queue_service.release(db, held[0][1], held[0][0])

        permits_before = main._inference_semaphore._value
        freeing = asyncio.create_task(free_one_shortly())
        await _drain(main._queued_stream(object(), _Caller(), _FakeRequest(), "chatcmpl-q3"))
        await freeing
        # The release is fire-and-forget, like the settle it mirrors.
        await asyncio.sleep(0.3)

        assert main._inference_semaphore._value == permits_before, (
            "the permit count changed across a completed stream"
        )
        async with sessionmaker_np() as db:
            in_use = await queue_service.slots_in_use(db)
        assert in_use == len(held) - 1, (
            f"{in_use} slots still held; the finished request did not give its slot back"
        )

    async def test_a_queue_timeout_emits_an_error_and_takes_no_permit(
        self, sessionmaker_np, monkeypatch
    ):
        """The exit that never acquired anything.

        Releasing here would raise the permit count above the cap -- a capacity leak that gets worse
        with every timed-out request and never announces itself.
        """
        _stub_generation(monkeypatch)
        monkeypatch.setattr(main, "USE_SGLANG", False)
        monkeypatch.setattr(config, "GPU_QUEUE_MAX_WAIT_SECONDS", 1.0)
        await _fill_every_slot(sessionmaker_np)

        permits_before = main._inference_semaphore._value
        frames = await _drain(
            main._queued_stream(object(), _Caller(), _FakeRequest(), "chatcmpl-q4")
        )
        await asyncio.sleep(0.3)

        joined = "".join(frames)
        assert "queue_timeout" in joined, f"no timeout error was emitted: {joined[-200:]}"
        assert joined.rstrip().endswith("data: [DONE]"), (
            "the stream did not terminate with [DONE]; a client would wait forever"
        )
        assert main._inference_semaphore._value == permits_before, (
            "a request that never acquired a permit released one anyway, raising the concurrency "
            "cap above what the pod was sized for"
        )

    async def test_a_refusal_after_admission_is_delivered_in_band(
        self, sessionmaker_np, monkeypatch
    ):
        """A 402 that arrived too late to be a status code.

        Headers are already sent, so the only honest thing left is to say it in the body -- and to
        give the slot back rather than holding it through a failure.
        """
        monkeypatch.setattr(main, "USE_SGLANG", False)

        async def broke(request, caller, request_id):
            raise HTTPException(
                status_code=402,
                detail={"error": "insufficient_credit", "message": "You have run out of credit."},
            )

        monkeypatch.setattr(main, "_prepare_for_generation", broke)
        held = await _fill_every_slot(sessionmaker_np)

        async def free_one_shortly():
            await asyncio.sleep(0.6)
            async with sessionmaker_np() as db:
                await queue_service.release(db, held[0][1], held[0][0])

        permits_before = main._inference_semaphore._value
        freeing = asyncio.create_task(free_one_shortly())
        frames = await _drain(
            main._queued_stream(object(), _Caller(), _FakeRequest(), "chatcmpl-q5")
        )
        await freeing
        await asyncio.sleep(0.3)

        joined = "".join(frames)
        assert "run out of credit" in joined, (
            "the learner was told nothing about why their request stopped"
        )
        assert "http_402" in joined
        assert joined.rstrip().endswith("data: [DONE]")
        assert main._inference_semaphore._value == permits_before, (
            "the permit was not returned after a refusal"
        )
        async with sessionmaker_np() as db:
            assert await queue_service.slots_in_use(db) == len(held) - 1

    async def test_a_disconnected_caller_never_takes_a_slot(
        self, sessionmaker_np, monkeypatch
    ):
        """A slot is the scarcest thing here. Spending one on somebody who closed the tab is waste
        that looks exactly like load."""
        _stub_generation(monkeypatch)
        monkeypatch.setattr(main, "USE_SGLANG", False)

        permits_before = main._inference_semaphore._value
        frames = await _drain(
            main._queued_stream(
                object(), _Caller(), _FakeRequest(disconnected=True), "chatcmpl-q6"
            )
        )
        await asyncio.sleep(0.2)

        assert "queue_timeout" in "".join(frames)
        assert main._inference_semaphore._value == permits_before
        async with sessionmaker_np() as db:
            assert await queue_service.slots_in_use(db) == 0
            assert await queue_service.waiting_count(db) == 0


class TestTheFastPathIsUnaffected:
    async def test_a_free_slot_is_claimed_without_queueing(self, sessionmaker_np):
        """The common case must not go near the generator above.

        `try_acquire_lease` returning a lease is what keeps every request that does not wait on the
        code path it has always been on, with real HTTP statuses and the diagnosis header intact.
        """
        caller = _Caller()
        lease = await queue_service.try_acquire_lease(
            sessionmaker_np, caller.user_id, "chatcmpl-fast"
        )
        assert lease is not None
        try:
            async with sessionmaker_np() as db:
                assert await queue_service.slots_in_use(db) == 1
        finally:
            lease.release_in_background(sessionmaker_np)
            await asyncio.sleep(0.2)

    async def test_it_returns_none_when_every_slot_is_busy(self, sessionmaker_np):
        await _fill_every_slot(sessionmaker_np)
        caller = _Caller()
        lease = await queue_service.try_acquire_lease(
            sessionmaker_np, caller.user_id, "chatcmpl-nofast"
        )
        assert lease is None, "a lease was handed out with no slot free"

    async def test_a_failed_fast_claim_leaves_no_ticket_behind(self, sessionmaker_np):
        """It creates a ticket to claim with. A miss must clean it up, or every busy-moment
        request would inflate the queue depth everybody else is measured against."""
        await _fill_every_slot(sessionmaker_np)
        caller = _Caller()
        await queue_service.try_acquire_lease(sessionmaker_np, caller.user_id, "chatcmpl-litter")

        async with sessionmaker_np() as db:
            assert await queue_service.waiting_count(db) == 0


class TestTheQueueGaugesAreActuallySampled:
    """Declared, given a setter, and never called -- for one whole commit.

    `voidcode_gpu_queue_depth` and `voidcode_gpu_slots_in_use` were defined with a `set_queue_gauges`
    helper that nothing invoked, so both reported 0.0 for the life of the process. That is worse
    than not having them: a dashboard would show an empty queue and an idle fleet during a pile-up,
    and the graph would look like the system was working.

    Found by scraping `/metrics` on a running instance, not by any test -- which is why there is now
    a test.
    """

    async def test_scraping_reports_the_real_depth_and_occupancy(
        self, sessionmaker_np, monkeypatch
    ):
        from src import metrics

        monkeypatch.setattr(config, "GPU_QUEUE_ENABLED", True)

        held = await _fill_every_slot(sessionmaker_np)
        caller = _Caller()
        async with sessionmaker_np() as db:
            await queue_service.enqueue(db, caller.user_id, "chatcmpl-g1", max_depth=50)
            await queue_service.enqueue(db, caller.user_id, "chatcmpl-g2", max_depth=50)

        await main.prometheus_metrics()

        body, _ = metrics.render()
        text = body.decode()
        depth = next(
            float(line.split()[1]) for line in text.splitlines()
            if line.startswith("voidcode_gpu_queue_depth ")
        )
        in_use = next(
            float(line.split()[1]) for line in text.splitlines()
            if line.startswith("voidcode_gpu_slots_in_use ")
        )
        assert depth == 2.0, f"queue depth scraped as {depth} with two tickets waiting"
        assert in_use == float(len(held)), (
            f"occupancy scraped as {in_use} with {len(held)} slots held"
        )

    async def test_a_database_failure_does_not_break_the_metrics_endpoint(self, monkeypatch):
        """The endpoint that reports trouble must not become a source of it.

        A scrape that 500s when the database is unreachable takes the dashboard down at exactly the
        moment somebody is looking at it to find out why.
        """
        monkeypatch.setattr(config, "GPU_QUEUE_ENABLED", True)

        def exploding_session():
            raise RuntimeError("database is gone")

        monkeypatch.setattr(main, "AsyncSessionLocal", exploding_session)
        response = await main.prometheus_metrics()
        assert response.status_code == 200
