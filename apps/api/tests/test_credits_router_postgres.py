"""The read-only credits API, against a real Postgres.

Assembled as a minimal app around the router rather than importing `main`, per the conftest rule:
`main` pulls torch at module scope and the suite must not depend on the inference stack.
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import dataclasses

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src import identity
from src.database import get_db
from src.models.gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.routers import credits as credits_router
from src.services import credit_packs, gpu_pricing, gpu_wallet_service as wallet

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
        # Not cascaded from the wallet, deliberately -- see `GpuGrantKey`.
        await db.execute(delete(GpuGrantKey).where(GpuGrantKey.user_id == user_id))
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
    app.dependency_overrides[identity.require_user] = lambda: learner
    # `/checkout` resolves a full Caller rather than a bare id, because it has to refuse an
    # anonymous or unverified buyer. Overriding only `current_user_id` left it 401ing.
    app.dependency_overrides[identity.resolve_caller] = lambda: identity.Caller(user_id=learner)

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
        app.dependency_overrides[identity.require_user] = lambda: learner
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


class TestWhoMayRead:
    """The per-person reads refuse an unauthenticated caller.

    THE DEFECT THIS CLOSES. All three read paths took `current_user_id`, which resolves a caller
    with no credential to the SHARED anonymous user -- the same identity every other signed-out
    caller gets. So a signed-out request read one wallet and one ledger, and the moment anything
    credited or charged that identity, every signed-out caller would have been shown it. It is the
    same shape as the reading progress that became one record shared by everybody, on the money
    path. `/checkout` and `/vouchers/redeem` have always refused anonymous, with a comment saying
    why; the reads should never have differed.
    """

    @pytest_asyncio.fixture
    async def anonymous(self, sessionmaker_np):
        """A client with no credential at all -- `resolve_caller`'s answer for one is anonymous."""
        app = FastAPI()
        app.include_router(credits_router.router)

        async def _db():
            async with sessionmaker_np() as session:
                yield session

        app.dependency_overrides[get_db] = _db
        # Deliberately NOT overriding `require_user`: the real dependency is what is under test, and
        # it is fed the anonymous Caller that an unauthenticated request actually produces.
        app.dependency_overrides[identity.resolve_caller] = lambda: identity.Caller(
            user_id=identity.ANONYMOUS_USER_ID
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
            yield ac

    @pytest.mark.parametrize("path", ["/v1/credits", "/v1/credits/ledger", "/v1/credits/usage"])
    async def test_an_unauthenticated_caller_reads_no_wallet(self, anonymous, path):
        response = await anonymous.get(path)
        assert response.status_code == 401, path

    async def test_the_pack_list_is_still_public(self, anonymous):
        """The one read here that is not per-person, and it has to stay reachable.

        A price list is not somebody's data, and the sign-in dialog's own copy says what an account
        is for -- which is hard to write if the application cannot say what a pack costs until
        after you have one.
        """
        response = await anonymous.get("/v1/credits/packs")
        assert response.status_code == 200
        assert len(response.json()["packs"]) > 0


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


class TestARetiredPackCannotBeBoughtButStillCredits:
    """The asymmetry `credit_packs` documents, asserted for the first time.

    `pack_by_code()` deliberately resolves retired packs so a webhook arriving after a pack was
    pulled still credits the buyer -- money was taken, and dropping it would be theft with a plausible
    excuse. `/checkout` must do the opposite and refuse, or a stale price stays purchasable forever
    through a hand-made request.

    Nothing tested either half, and it was not reachable to test: all three rows in `PACKS` take the
    `on_sale=True` default, so `not pack.on_sale` in `routers/credits.py` was dead code in every
    run. The retired row is created here rather than shipped, so retiring a real pack later needs no
    change to this test.
    """

    async def test_checkout_refuses_a_pack_that_is_no_longer_on_sale(
        self, client, monkeypatch
    ):
        live = credit_packs.packs_on_sale()[0]
        retired = dataclasses.replace(live, code="my-retired-test", on_sale=False)
        monkeypatch.setattr(credit_packs, "PACKS", credit_packs.PACKS + (retired,))
        monkeypatch.setattr("src.config.PAYMENTS_ENABLED", True)

        response = await client.post(
            "/v1/credits/checkout", json={"pack_code": "my-retired-test"}
        )

        assert response.status_code == 404, (
            f"a retired pack was purchasable ({response.status_code}). Its price is frozen at "
            "whatever it was when it was pulled."
        )

    async def test_a_retired_pack_still_resolves_for_a_late_webhook(self, monkeypatch):
        """The other half. A purchase started before the pack was pulled must still credit."""
        live = credit_packs.packs_on_sale()[0]
        retired = dataclasses.replace(live, code="my-retired-test", on_sale=False)
        monkeypatch.setattr(credit_packs, "PACKS", credit_packs.PACKS + (retired,))

        found = credit_packs.pack_by_code("my-retired-test")
        assert found is not None, (
            "a retired pack stopped resolving, so a webhook for a purchase made before it was "
            "pulled would take the money and grant nothing"
        )
        assert found.credits_micro == live.credits_micro
        assert retired not in credit_packs.packs_on_sale(), "a retired pack is still on display"


class TestWhatABalanceIsWorth:
    """A balance in credits is not a number anybody can act on.

    "1,200 credits" tells a buyer nothing about whether to buy. The conversion needs the live rate,
    which is a dated row, so it is done on the server -- a rate shipped to the browser can be served
    stale from a cached bundle and would render an old price as a promise.
    """

    async def test_the_balance_says_roughly_how_much_generation_it_buys(
        self, client, sessionmaker_np, learner
    ):
        rate = gpu_pricing.rate_for().rate_micro_per_slot_second
        async with sessionmaker_np() as db:
            await wallet.grant(db, learner, amount_micro=rate * 600, idempotency_key=f"g:minutes:{uuid.uuid4()}")

        body = (await client.get("/v1/credits")).json()

        assert body["rateMicroPerSlotSecond"] == rate, (
            "the rate is returned so the figure can be checked by whoever reads it, rather than "
            "asserted"
        )
        assert body["estimatedMinutes"] == 10, (
            f"600 slot-seconds of credit should read as 10 minutes, got "
            f"{body['estimatedMinutes']}"
        )

    async def test_it_is_floored_like_the_credits_figure(self, client, sessionmaker_np, learner):
        """59 seconds of credit is nought minutes, not one.

        Rounding up here promises generation the balance cannot pay for, which is the same mistake
        as rounding `availableCredits` up -- and it lands at exactly the moment a learner is
        deciding whether they still need to top up.
        """
        rate = gpu_pricing.rate_for().rate_micro_per_slot_second
        async with sessionmaker_np() as db:
            await wallet.grant(db, learner, amount_micro=rate * 119, idempotency_key=f"g:floor:{uuid.uuid4()}")

        body = (await client.get("/v1/credits")).json()
        assert body["estimatedMinutes"] == 1

    async def test_an_empty_wallet_reads_as_no_time_rather_than_failing(self, client):
        """Nought divided into nought minutes, not a 500 and not a missing key."""
        body = (await client.get("/v1/credits")).json()
        assert body["estimatedMinutes"] == 0
        assert body["rateMicroPerSlotSecond"] > 0

    async def test_the_figure_tracks_the_rate_rather_than_being_pinned(
        self, client, sessionmaker_np, learner
    ):
        """Doubling the price halves the time. Asserted as a relationship, not a constant.

        Pinning the minutes would fail on every deliberate reprice and teach whoever follows to
        update the expected number without thinking about whether it was right.
        """
        import dataclasses

        rate = gpu_pricing.rate_for().rate_micro_per_slot_second
        async with sessionmaker_np() as db:
            await wallet.grant(db, learner, amount_micro=rate * 600, idempotency_key=f"g:reprice:{uuid.uuid4()}")

        before = (await client.get("/v1/credits")).json()["estimatedMinutes"]

        dearer = tuple(
            dataclasses.replace(r, pod_micro_per_hour=r.pod_micro_per_hour * 2)
            for r in gpu_pricing.PRICING
        )
        original = gpu_pricing.PRICING
        try:
            gpu_pricing.PRICING = dearer
            after = (await client.get("/v1/credits")).json()["estimatedMinutes"]
        finally:
            gpu_pricing.PRICING = original

        assert after == before // 2, (
            f"the price doubled but the estimate went from {before} to {after} minutes; it is not "
            "reading the live pricing row"
        )

