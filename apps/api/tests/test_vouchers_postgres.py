"""Redeeming a voucher, against a real Postgres, including the race that mints money.

THE PROPERTY THIS FILE EXISTS FOR: ONE CODE GRANTS ONCE, UNDER CONCURRENCY.

Everything else here is bookkeeping. The reason it needs saying is that the obvious implementation
is next door and it is wrong for this purpose: `token_service.redeem()` selects the row, checks
`used_at` in Python, then assigns. Two concurrent requests both pass that check. For a password
reset link the consequence is nil, because redeeming one twice is idempotent in effect. For a
voucher the second redemption mints money.

So `voucher_service.redeem()` claims with a guarded single-statement UPDATE and decides on
`rowcount`. Every test here uses `asyncio.Barrier` and `NullPool` for the same reason
`test_gpu_wallet_postgres.py` does: with a shared pool two "concurrent" sessions can be handed the
same connection, which serialises them and makes the test pass for entirely the wrong reason.

WHY THERE ARE TWO SETS OF CONCURRENCY TESTS, WHICH LOOK REDUNDANT AND ARE NOT

Redemption has two independent guards -- the claim's predicate, and the uniqueness of
`voucher:{id}` in `gpu_ledger` and `gpu_grant_keys`. Either alone stops a double grant. That is the
point of having two, and it means an end-to-end test CANNOT tell you whether the claim works:
`redeem()` rewritten as a read-check-write passes `TestOneCodeGrantsOnce` in full, because the
ledger's unique key catches what the check let through. That was measured by planting the naive
version, not reasoned about.

`TestTheClaimAlone` therefore races `voucher_service.claim()` directly, with nothing behind it.
Those are the tests that fail when the guard stops being a single statement -- verified the same
way, by planting the mutation and watching three of them fail.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from src import identity
from src.database import get_db
from src.models.credit_voucher import CreditVoucher
from src.models.gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.routers import credits as credits_router
from src.services import voucher_service

pytestmark = [requires_postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _make_user(sessionmaker_np) -> uuid.UUID:
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"voucher-{user_id.hex[:12]}@example.test",
                name="voucher test",
                role="student",
            )
        )
        await db.flush()
        db.add(GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0))
        await db.commit()
    return user_id


async def _drop_user(sessionmaker_np, user_id) -> None:
    async with sessionmaker_np() as db:
        await db.execute(delete(GpuLedger).where(GpuLedger.wallet_user_id == user_id))
        await db.execute(delete(GpuGrantKey).where(GpuGrantKey.user_id == user_id))
        await db.execute(delete(GpuReservation).where(GpuReservation.wallet_user_id == user_id))
        await db.execute(delete(GpuWallet).where(GpuWallet.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


@pytest_asyncio.fixture
async def learner(sessionmaker_np):
    user_id = await _make_user(sessionmaker_np)
    yield user_id
    await _drop_user(sessionmaker_np, user_id)


@pytest_asyncio.fixture
async def other_learner(sessionmaker_np):
    user_id = await _make_user(sessionmaker_np)
    yield user_id
    await _drop_user(sessionmaker_np, user_id)


@pytest_asyncio.fixture
async def voucher(sessionmaker_np):
    """A 500-credit voucher. Yields `(voucher_id, raw_code)` and removes the row afterwards."""
    async with sessionmaker_np() as db:
        row, code = await voucher_service.issue(
            db, amount_micro=500_000_000, kind="beta", note="test"
        )
        voucher_id = row.id
        await db.commit()
    yield voucher_id, code
    async with sessionmaker_np() as db:
        await db.execute(delete(CreditVoucher).where(CreditVoucher.id == voucher_id))
        await db.commit()


async def _balance(sessionmaker_np, user_id) -> int:
    async with sessionmaker_np() as db:
        row = await db.get(GpuWallet, user_id)
        return row.balance_micro if row else 0


# ── The race ────────────────────────────────────────────────────────────────────────────────


class TestOneCodeGrantsOnce:
    async def test_two_people_redeeming_one_code_at_once_grant_once(
        self, sessionmaker_np, learner, other_learner, voucher
    ):
        """Two distinct users, two connections, released together: exactly one gets credit.

        NOTE WHAT THIS DOES AND DOES NOT PROVE. It proves the end-to-end property, which is the one
        that matters. It does NOT prove the guarded UPDATE works, because it cannot: rewriting
        `redeem()` as a read-check-write leaves this test green, since the ledger's unique key
        refuses the second grant regardless. Measured, not assumed -- the naive version was planted
        and passed.

        `TestTheClaimAlone` below is where the claim is actually held to account.
        """
        voucher_id, code = voucher
        barrier = asyncio.Barrier(2)

        async def attempt(user_id) -> str:
            async with sessionmaker_np() as db:
                await barrier.wait()
                try:
                    await voucher_service.redeem(db, code, user_id)
                    return "granted"
                except voucher_service.VoucherError:
                    return "refused"

        outcomes = sorted(await asyncio.gather(attempt(learner), attempt(other_learner)))
        assert outcomes == ["granted", "refused"], (
            f"one voucher produced {outcomes}; it was redeemed twice"
        )

        total = await _balance(sessionmaker_np, learner) + await _balance(
            sessionmaker_np, other_learner
        )
        assert total == 500_000_000, f"{total} micro granted from a 500-credit voucher"

        async with sessionmaker_np() as db:
            grants = (
                await db.execute(
                    select(GpuLedger).where(
                        GpuLedger.idempotency_key == f"voucher:{voucher_id}"
                    )
                )
            ).scalars().all()
        assert len(grants) == 1

    async def test_the_same_person_redeeming_twice_is_told_so(
        self, sessionmaker_np, learner, voucher
    ):
        """A second click is the commonest way to reach a refusal, so it gets its own message.

        "That code is not valid" here would send somebody to support over something that worked.
        """
        _, code = voucher
        async with sessionmaker_np() as db:
            await voucher_service.redeem(db, code, learner)

        async with sessionmaker_np() as db:
            with pytest.raises(voucher_service.VoucherError, match="already been redeemed"):
                await voucher_service.redeem(db, code, learner)

        assert await _balance(sessionmaker_np, learner) == 500_000_000

    async def test_a_ten_way_race_still_grants_once(self, sessionmaker_np, voucher):
        """Two can pass by luck. Ten cannot. Same caveat as above: this is the pair, not the claim."""
        _voucher_id, code = voucher
        users = [await _make_user(sessionmaker_np) for _ in range(10)]
        barrier = asyncio.Barrier(10)

        async def attempt(user_id) -> str:
            async with sessionmaker_np() as db:
                await barrier.wait()
                try:
                    await voucher_service.redeem(db, code, user_id)
                    return "granted"
                except voucher_service.VoucherError:
                    return "refused"

        try:
            outcomes = await asyncio.gather(*(attempt(u) for u in users))
            assert outcomes.count("granted") == 1, (
                f"{outcomes.count('granted')} of ten redemptions of one code succeeded"
            )
            total = sum([await _balance(sessionmaker_np, u) for u in users])
            assert total == 500_000_000
        finally:
            for user_id in users:
                await _drop_user(sessionmaker_np, user_id)



class TestTheClaimAlone:
    """The guarded UPDATE, with nothing behind it to cover for it.

    Every test that goes through `redeem()` passes with a read-check-write, because
    `uq_gpu_ledger_idempotency_key` catches the second grant. Two independent guards is the right
    design and it makes the end-to-end tests unable to distinguish one working guard from two.

    So these race `voucher_service.claim()` directly. If the claim stops being a single guarded
    statement, these fail and nothing else does.
    """

    async def test_two_concurrent_claims_admit_exactly_one(
        self, sessionmaker_np, learner, other_learner, voucher
    ):
        _voucher_id, code = voucher
        code_hash = voucher_service.hash_code(code)
        barrier = asyncio.Barrier(2)

        async def attempt(user_id):
            async with sessionmaker_np() as db:
                await barrier.wait()
                row = await voucher_service.claim(
                    db, code_hash, user_id, datetime.now(UTC)
                )
                await db.commit()
                return "claimed" if row is not None else "refused"

        outcomes = sorted(await asyncio.gather(attempt(learner), attempt(other_learner)))
        assert outcomes == ["claimed", "refused"], (
            f"the claim admitted {outcomes}. It is not a single guarded statement any more -- a "
            "read-check-write lets both callers past, and only the ledger's unique key would "
            "then stop the second grant."
        )

    async def test_ten_concurrent_claims_admit_exactly_one(self, sessionmaker_np, voucher):
        """Two can serialise by accident. Ten will not."""
        _voucher_id, code = voucher
        code_hash = voucher_service.hash_code(code)
        users = [await _make_user(sessionmaker_np) for _ in range(10)]
        barrier = asyncio.Barrier(10)

        async def attempt(user_id):
            async with sessionmaker_np() as db:
                await barrier.wait()
                row = await voucher_service.claim(
                    db, code_hash, user_id, datetime.now(UTC)
                )
                await db.commit()
                return row is not None

        try:
            results = await asyncio.gather(*(attempt(u) for u in users))
            assert sum(results) == 1, f"{sum(results)} of ten concurrent claims succeeded"
        finally:
            for user_id in users:
                await _drop_user(sessionmaker_np, user_id)

    async def test_the_winner_is_the_one_recorded_on_the_row(
        self, sessionmaker_np, learner, other_learner, voucher
    ):
        """Whoever the claim admits is whoever `redeemed_by` names.

        Under a read-check-write both callers assign `redeemed_by`, so the row can end up naming
        somebody who was refused -- an audit trail pointing at the wrong person.
        """
        voucher_id, code = voucher
        code_hash = voucher_service.hash_code(code)
        barrier = asyncio.Barrier(2)

        async def attempt(user_id):
            async with sessionmaker_np() as db:
                await barrier.wait()
                row = await voucher_service.claim(
                    db, code_hash, user_id, datetime.now(UTC)
                )
                await db.commit()
                return user_id if row is not None else None

        winners = [u for u in await asyncio.gather(
            attempt(learner), attempt(other_learner)
        ) if u is not None]
        assert len(winners) == 1

        async with sessionmaker_np() as db:
            row = await db.get(CreditVoucher, voucher_id)
        assert row.redeemed_by == winners[0]

    async def test_an_expired_voucher_is_never_claimed(self, sessionmaker_np, learner):
        """Expiry is in the predicate, so there is no claim-then-rollback window."""
        async with sessionmaker_np() as db:
            row, code = await voucher_service.issue(
                db, amount_micro=100_000_000, kind="promo",
                expires_at=datetime.now(UTC) - timedelta(seconds=1),
            )
            voucher_id = row.id
            await db.commit()
        try:
            async with sessionmaker_np() as db:
                claimed = await voucher_service.claim(
                    db, voucher_service.hash_code(code), learner,
                    datetime.now(UTC),
                )
                await db.commit()
            assert claimed is None
            async with sessionmaker_np() as db:
                after = await db.get(CreditVoucher, voucher_id)
            assert after.redeemed_at is None, "an expired voucher was marked spent"
        finally:
            async with sessionmaker_np() as db:
                await db.execute(delete(CreditVoucher).where(CreditVoucher.id == voucher_id))
                await db.commit()

# ── Refusals ────────────────────────────────────────────────────────────────────────────────


class TestWhatIsRefused:
    async def test_an_unknown_code_grants_nothing(self, sessionmaker_np, learner):
        async with sessionmaker_np() as db:
            with pytest.raises(voucher_service.VoucherError, match="not valid"):
                await voucher_service.redeem(db, "no-such-code-at-all", learner)
        assert await _balance(sessionmaker_np, learner) == 0

    async def test_an_expired_voucher_grants_nothing(self, sessionmaker_np, learner):
        async with sessionmaker_np() as db:
            row, code = await voucher_service.issue(
                db, amount_micro=100_000_000, kind="promo",
                expires_at=datetime.now(UTC) - timedelta(seconds=1),
            )
            voucher_id = row.id
            await db.commit()

        try:
            async with sessionmaker_np() as db:
                with pytest.raises(voucher_service.VoucherError, match="expired"):
                    await voucher_service.redeem(db, code, learner)
            assert await _balance(sessionmaker_np, learner) == 0
        finally:
            async with sessionmaker_np() as db:
                await db.execute(delete(CreditVoucher).where(CreditVoucher.id == voucher_id))
                await db.commit()

    async def test_an_unknown_code_and_a_wrong_one_read_identically(
        self, sessionmaker_np, learner
    ):
        """Two refusals, one message.

        Distinguishing them tells somebody probing codes which guesses were closer, which is the
        only feedback a brute-force attempt needs.
        """
        async with sessionmaker_np() as db:
            with pytest.raises(voucher_service.VoucherError) as first:
                await voucher_service.redeem(db, "aaaaaaaaaaaaaaaaaaaaaaaa", learner)
        async with sessionmaker_np() as db:
            with pytest.raises(voucher_service.VoucherError) as second:
                await voucher_service.redeem(db, "bbbbbbbbbbbbbbbbbbbbbbbb", learner)
        assert str(first.value) == str(second.value)


# ── What is recorded ────────────────────────────────────────────────────────────────────────


class TestTheLedgerRecordsIt:
    async def test_a_redemption_is_a_grant_keyed_on_the_voucher(
        self, sessionmaker_np, learner, voucher
    ):
        voucher_id, code = voucher
        async with sessionmaker_np() as db:
            await voucher_service.redeem(db, code, learner)

        async with sessionmaker_np() as db:
            entry = (
                await db.execute(
                    select(GpuLedger).where(
                        GpuLedger.wallet_user_id == learner, GpuLedger.entry_type == "grant"
                    )
                )
            ).scalars().one()
        assert entry.amount_micro == 500_000_000
        assert entry.idempotency_key == f"voucher:{voucher_id}"

    async def test_the_key_does_not_contain_the_code(self, sessionmaker_np, learner, voucher):
        """The ledger is readable by anything that can read the ledger.

        Keying on the code rather than the voucher id would leave a spendable secret sitting in an
        audit table, which is the sort of thing that is obvious only after it has happened.
        """
        _, code = voucher
        async with sessionmaker_np() as db:
            await voucher_service.redeem(db, code, learner)

        async with sessionmaker_np() as db:
            keys = (
                await db.execute(
                    select(GpuLedger.idempotency_key).where(
                        GpuLedger.wallet_user_id == learner
                    )
                )
            ).scalars().all()
        for key in keys:
            assert code not in key

    async def test_the_row_records_who_redeemed_it_and_when(
        self, sessionmaker_np, learner, voucher
    ):
        voucher_id, code = voucher
        async with sessionmaker_np() as db:
            await voucher_service.redeem(db, code, learner)

        async with sessionmaker_np() as db:
            row = await db.get(CreditVoucher, voucher_id)
        assert row.redeemed_by == learner
        assert row.redeemed_at is not None

    async def test_the_raw_code_is_never_stored(self, sessionmaker_np, voucher):
        voucher_id, code = voucher
        async with sessionmaker_np() as db:
            row = await db.get(CreditVoucher, voucher_id)
        assert row.code_hash != code
        assert row.code_hash == voucher_service.hash_code(code)
        assert len(row.code_hash) == 64


# ── Over HTTP ───────────────────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def client(sessionmaker_np, learner):
    app = FastAPI()
    app.include_router(credits_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[identity.resolve_caller] = lambda: identity.Caller(user_id=learner)
    app.dependency_overrides[identity.current_user_id] = lambda: learner
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


class TestTheEndpoint:
    async def test_a_valid_code_credits_the_caller(
        self, client, sessionmaker_np, learner, voucher
    ):
        _, code = voucher
        response = await client.post("/v1/credits/vouchers/redeem", json={"code": code})

        assert response.status_code == 200
        assert response.json()["credited"] is True
        assert response.json()["credits"] == 500
        assert await _balance(sessionmaker_np, learner) == 500_000_000

    async def test_a_bad_code_is_a_400_and_not_a_500(self, client, sessionmaker_np, learner):
        response = await client.post(
            "/v1/credits/vouchers/redeem", json={"code": "definitely-not-a-code"}
        )
        assert response.status_code == 400
        assert await _balance(sessionmaker_np, learner) == 0

    async def test_an_empty_code_is_refused_before_any_lookup(self, client):
        response = await client.post("/v1/credits/vouchers/redeem", json={"code": "   "})
        assert response.status_code == 400

    async def test_the_response_never_echoes_the_code(self, client, voucher):
        """A code echoed into a response ends up in a log, a proxy trace, or a screenshot."""
        _, code = voucher
        response = await client.post("/v1/credits/vouchers/redeem", json={"code": code})
        assert code not in response.text

    async def test_the_body_cannot_name_the_wallet_to_credit(self, client, sessionmaker_np,
                                                             learner, other_learner, voucher):
        """The wallet is the resolved caller's. An extra field must not redirect the credit.

        Pydantic ignores unknown fields by default, so this asserts the consequence rather than
        trusting that it stays the default.
        """
        _, code = voucher
        response = await client.post(
            "/v1/credits/vouchers/redeem",
            json={"code": code, "user_id": str(other_learner)},
        )
        assert response.status_code == 200
        assert await _balance(sessionmaker_np, learner) == 500_000_000
        assert await _balance(sessionmaker_np, other_learner) == 0
