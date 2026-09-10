"""The read-only credits API, against a real Postgres.

Assembled as a minimal app around the router rather than importing `main`, per the conftest rule:
`main` pulls torch at module scope and the suite must not depend on the inference stack.
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src import identity
from src.database import get_db
from src.models.gpu_billing import GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.routers import credits as credits_router
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
async def learner(sessionmaker_np):
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"gpu-api-{user_id.hex[:12]}@example.test",
                name="credits api test",
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


@pytest_asyncio.fixture
async def client(sessionmaker_np, learner):
    app = FastAPI()
    app.include_router(credits_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[identity.current_user_id] = lambda: learner

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


class TestBalance:
    async def test_a_user_with_no_wallet_gets_zeroes_not_a_404(self, sessionmaker_np, learner):
        """A learner who has never been granted credit has a balance. It is nought.

        A 404 would make the client distinguish "no wallet" from "no credit", which is a difference
        they cannot act on.
        """
        async with sessionmaker_np() as db:
            await db.execute(delete(GpuWallet).where(GpuWallet.user_id == learner))
            await db.commit()

        app = FastAPI()
        app.include_router(credits_router.router)

        async def _db():
            async with sessionmaker_np() as session:
                yield session

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[identity.current_user_id] = lambda: learner
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            response = await ac.get("/v1/credits")
        assert response.status_code == 200
        assert response.json()["availableMicro"] == 0

        # Put it back so the fixture teardown has something to delete in FK order.
        async with sessionmaker_np() as db:
            db.add(GpuWallet(user_id=learner, balance_micro=0, reserved_micro=0))
            await db.commit()

    async def test_available_excludes_what_is_held(self, sessionmaker_np, learner, client):
        """The number that matters. Showing `balance` alone promises credit already spoken for."""
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=10_000, idempotency_key=f"g:{uuid.uuid4()}"
            )
        async with sessionmaker_np() as db:
            await wallet.reserve(
                db, learner, hold_micro=4_000, request_id="chatcmpl-x", kind="chat",
                backend="hf", rate_micro_per_slot_second=RATE,
            )

        body = (await client.get("/v1/credits")).json()
        assert body["balanceMicro"] == 10_000
        assert body["reservedMicro"] == 4_000
        assert body["availableMicro"] == 6_000

    async def test_whole_credits_are_floored_never_rounded(self, sessionmaker_np, learner, client):
        """Showing 1 credit when 0.99 is spendable invites a refusal the learner was told
        would not happen."""
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=1_999_999, idempotency_key=f"g:{uuid.uuid4()}"
            )
        body = (await client.get("/v1/credits")).json()
        assert body["availableCredits"] == 1


class TestLedgerAndUsage:
    async def test_the_ledger_is_ordered_by_id_not_timestamp(
        self, sessionmaker_np, learner, client
    ):
        """Two rows written in one transaction share a `created_at` to the microsecond.

        An audit that cannot order them is not an audit, which is why the primary key is a
        BigInteger identity rather than a UUID.
        """
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=50_000, idempotency_key=f"g:{uuid.uuid4()}"
            )
        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=4_000, request_id="chatcmpl-x", kind="chat",
                backend="hf", rate_micro_per_slot_second=RATE,
            )
        async with sessionmaker_np() as db:
            await wallet.settle(db, reservation.id, slot_ms=2000)

        entries = (await client.get("/v1/credits/ledger")).json()["entries"]
        ids = [e["id"] for e in entries]
        assert ids == sorted(ids, reverse=True), "newest first, by id"
        assert [e["type"] for e in entries][0] == "charge"
        assert entries[0]["amountMicro"] == -2_000

    async def test_usage_shows_what_a_request_occupied_and_what_it_cost(
        self, sessionmaker_np, learner, client
    ):
        """`slotMs` is exposed on purpose.

        The unit is unfamiliar — learners expect to pay per message — so the interface has to be
        able to show why one question cost more than another, and the honest answer is that it held
        the model longer.
        """
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=50_000, idempotency_key=f"g:{uuid.uuid4()}"
            )
        async with sessionmaker_np() as db:
            reservation = await wallet.reserve(
                db, learner, hold_micro=9_000, request_id="chatcmpl-x", kind="chat",
                backend="hf", rate_micro_per_slot_second=RATE,
            )
        async with sessionmaker_np() as db:
            await wallet.settle(db, reservation.id, slot_ms=3500)

        requests = (await client.get("/v1/credits/usage")).json()["requests"]
        assert len(requests) == 1
        assert requests[0]["slotMs"] == 3500
        assert requests[0]["chargedMicro"] == 3_500
        assert requests[0]["rateMicroPerSlotSecond"] == RATE

    async def test_a_held_request_is_not_listed_as_usage(
        self, sessionmaker_np, learner, client
    ):
        """In-flight is not usage. Listing it would show a charge that has not happened and may
        never happen at that amount."""
        async with sessionmaker_np() as db:
            await wallet.grant(
                db, learner, amount_micro=50_000, idempotency_key=f"g:{uuid.uuid4()}"
            )
        async with sessionmaker_np() as db:
            await wallet.reserve(
                db, learner, hold_micro=9_000, request_id="chatcmpl-inflight", kind="chat",
                backend="hf", rate_micro_per_slot_second=RATE,
            )
        assert (await client.get("/v1/credits/usage")).json()["requests"] == []
