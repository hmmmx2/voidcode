"""A purchase, end to end into the ledger, against a real Postgres.

THE PROPERTY THIS EXISTS FOR: A REDELIVERED WEBHOOK CREDITS ONCE.

Every payment provider redelivers. It is not an error condition — it is how at-least-once delivery
works, and it happens on any timeout, any 5xx, any deploy that lands mid-request. If the second
delivery credits again, a buyer gets double credit for one payment and nothing in the data marks it
as wrong, because both grants are individually correct.

The guard is `uq_gpu_ledger_idempotency_key` with the provider's own event id in the key. That is a
database constraint rather than an application check, so it holds under concurrent redelivery, which
is exactly when a read-check-write would fail.
"""

import hashlib
import hmac
import json
import time
import uuid

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from src import config
from src.database import get_db
from src.models.gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet
from src.models.user import User
from src.routers import credits as credits_router
from src.services import credit_packs

pytestmark = [requires_postgres, pytest.mark.asyncio]

SECRET = "whsec_postgres_test_secret"


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def buyer(sessionmaker_np):
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=f"buyer-{user_id.hex[:12]}@example.test",
                name="buyer",
                role="student",
            )
        )
        await db.flush()
        db.add(GpuWallet(user_id=user_id, balance_micro=0, reserved_micro=0))
        await db.commit()
    yield user_id
    async with sessionmaker_np() as db:
        await db.execute(delete(GpuLedger).where(GpuLedger.wallet_user_id == user_id))
        # Deliberately not cascaded from the wallet -- see `GpuGrantKey`. Cleaned by hand.
        await db.execute(delete(GpuGrantKey).where(GpuGrantKey.user_id == user_id))
        await db.execute(delete(GpuReservation).where(GpuReservation.wallet_user_id == user_id))
        await db.execute(delete(GpuWallet).where(GpuWallet.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


@pytest_asyncio.fixture
async def client(sessionmaker_np, monkeypatch):
    monkeypatch.setattr(config, "STRIPE_WEBHOOK_SECRET", SECRET)
    app = FastAPI()
    app.include_router(credits_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


def _event(user_id: uuid.UUID, *, pack_code="my-starter-20", event_id=None) -> bytes:
    return json.dumps(
        {
            "id": event_id or f"evt_{uuid.uuid4().hex}",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": f"cs_{uuid.uuid4().hex[:16]}",
                    "payment_status": "paid",
                    "amount_total": 2000,
                    "currency": "myr",
                    "client_reference_id": str(user_id),
                    "metadata": {"pack_code": pack_code, "user_id": str(user_id)},
                }
            },
        }
    ).encode("utf-8")


def _headers(payload: bytes) -> dict:
    timestamp = int(time.time())
    signature = hmac.new(
        SECRET.encode("utf-8"), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return {"Stripe-Signature": f"t={timestamp},v1={signature}", "Content-Type": "application/json"}


async def _balance(sessionmaker_np, user_id) -> int:
    async with sessionmaker_np() as db:
        row = await db.get(GpuWallet, user_id)
        return row.balance_micro


class TestAPurchaseCredits:
    async def test_a_signed_payment_credits_the_pack_amount(
        self, client, sessionmaker_np, buyer
    ):
        payload = _event(buyer)
        response = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))

        assert response.status_code == 200
        assert response.json() == {"received": True, "credited": True}

        pack = credit_packs.pack_by_code("my-starter-20")
        assert await _balance(sessionmaker_np, buyer) == pack.credits_micro

    async def test_the_ledger_records_it_as_a_grant(self, client, sessionmaker_np, buyer):
        payload = _event(buyer)
        await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))

        async with sessionmaker_np() as db:
            entries = (
                await db.execute(select(GpuLedger).where(GpuLedger.wallet_user_id == buyer))
            ).scalars().all()
        assert len(entries) == 1
        assert entries[0].entry_type == "grant"
        # The key carries the provider's event id, which is what makes redelivery a no-op.
        assert entries[0].idempotency_key.startswith("purchase:evt_")


class TestRedeliveryCreditsOnce:
    async def test_the_same_event_delivered_twice_credits_once(
        self, client, sessionmaker_np, buyer
    ):
        """Not an error case. At-least-once delivery is how every provider works."""
        payload = _event(buyer)
        headers = _headers(payload)

        first = await client.post("/v1/credits/webhook", content=payload, headers=headers)
        second = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))

        assert first.json()["credited"] is True
        # 200 with credited=false, not an error: the provider must stop retrying, and from its point
        # of view the delivery succeeded.
        assert second.status_code == 200
        assert second.json()["credited"] is False

        pack = credit_packs.pack_by_code("my-starter-20")
        assert await _balance(sessionmaker_np, buyer) == pack.credits_micro

        async with sessionmaker_np() as db:
            grants = (
                await db.execute(
                    select(GpuLedger).where(
                        GpuLedger.wallet_user_id == buyer, GpuLedger.entry_type == "grant"
                    )
                )
            ).scalars().all()
        assert len(grants) == 1, "one payment produced two grants"

    async def test_two_genuinely_different_payments_both_credit(
        self, client, sessionmaker_np, buyer
    ):
        """The other side of it: idempotency must not swallow a real second purchase."""
        for _ in range(2):
            payload = _event(buyer)
            response = await client.post(
                "/v1/credits/webhook", content=payload, headers=_headers(payload)
            )
            assert response.json()["credited"] is True

        pack = credit_packs.pack_by_code("my-starter-20")
        assert await _balance(sessionmaker_np, buyer) == 2 * pack.credits_micro


class TestRedeliveryAfterTheWalletIsGone:
    """The redelivery guard must not be erasable by deleting the thing it protects.

    `uq_gpu_ledger_idempotency_key` is the only record that a grant already happened, and it lives on
    a row whose foreign key cascades from the wallet, which cascades from the user. So deleting a
    wallet deletes the proof — and Stripe redelivers for days after the fact, on any timeout, any
    5xx, any deploy that landed mid-request.

    A wallet gets deleted by support closing a billing account, by an erasure request, or by a
    cleanup script. None of those look like a payments change, which is why nobody would connect the
    second grant to them.
    """

    async def test_a_replay_after_the_wallet_is_deleted_does_not_credit_again(
        self, client, sessionmaker_np, buyer
    ):
        payload = _event(buyer)

        first = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))
        assert first.json()["credited"] is True

        # The wallet goes, and the ledger with it — `ondelete="CASCADE"` on
        # `gpu_ledger.wallet_user_id`. This is a DB-level cascade, so it happens whether the delete
        # comes from the ORM, a script, or psql.
        async with sessionmaker_np() as db:
            await db.execute(delete(GpuWallet).where(GpuWallet.user_id == buyer))
            await db.commit()

        second = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))

        assert second.status_code == 200
        assert second.json()["credited"] is False, (
            "the same payment credited twice. Deleting the wallet cascaded away the ledger row "
            "carrying the idempotency key, so the replay looked like a first delivery."
        )

        async with sessionmaker_np() as db:
            wallet = await db.get(GpuWallet, buyer)
        assert wallet is None, (
            f"a refused replay recreated the wallet with {wallet.balance_micro if wallet else 0} "
            "micro in it"
        )

class TestNothingElseCredits:
    async def test_a_forged_signature_credits_nothing(self, client, sessionmaker_np, buyer):
        payload = _event(buyer)
        response = await client.post(
            "/v1/credits/webhook",
            content=payload,
            headers={"Stripe-Signature": f"t={int(time.time())},v1={'0' * 64}"},
        )
        assert response.status_code == 400
        assert await _balance(sessionmaker_np, buyer) == 0

    async def test_an_unsigned_body_credits_nothing(self, client, sessionmaker_np, buyer):
        payload = _event(buyer)
        response = await client.post("/v1/credits/webhook", content=payload)
        assert response.status_code == 400
        assert await _balance(sessionmaker_np, buyer) == 0

    async def test_an_unpaid_session_credits_nothing(self, client, sessionmaker_np, buyer):
        payload = json.dumps(
            {
                "id": f"evt_{uuid.uuid4().hex}",
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "id": "cs_pending",
                        "payment_status": "unpaid",
                        "amount_total": 2000,
                        "currency": "myr",
                        "metadata": {"pack_code": "my-starter-20", "user_id": str(buyer)},
                    }
                },
            }
        ).encode("utf-8")
        response = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))
        assert response.status_code == 200
        assert response.json()["credited"] is False
        assert await _balance(sessionmaker_np, buyer) == 0

    async def test_an_unknown_pack_refuses_loudly_rather_than_crediting_a_guess(
        self, client, sessionmaker_np, buyer
    ):
        """Money has been taken and nothing can say how much credit it bought.

        A 500 is right: the provider retries, which costs nothing and buys time to restore the pack
        row. Crediting a default amount, or silently 200-ing, would either invent credit or lose the
        purchase with no trace.
        """
        payload = _event(buyer, pack_code="a-pack-that-was-deleted")
        response = await client.post("/v1/credits/webhook", content=payload, headers=_headers(payload))
        assert response.status_code == 500
        assert await _balance(sessionmaker_np, buyer) == 0


class TestNoRouteGrantsWithoutASignature:
    def test_only_the_webhook_and_the_voucher_redeem_can_add_credit(self):
        """Structural, because a future 'confirm purchase' endpoint reading a redirect parameter is
        exactly the mistake this design exists to prevent — and it would look reasonable in review.

        This asserted ONE granting route until vouchers landed. The list is spelled out rather than
        counted so that adding a third is a deliberate edit to this test with a reason attached,
        not a number quietly incremented.

        Why `redeem_voucher` is allowed here: the amount comes from the voucher row rather than
        from the request, the wallet is the resolved caller's rather than one the body names, and
        the claim is a guarded UPDATE so a replay is refused by the database. It takes nobody's word
        for anything, which is the property this test is really about.
        """
        import ast
        import pathlib

        source = pathlib.Path(credits_router.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)

        granting = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                body = ast.get_source_segment(source, node) or ""
                # `voucher_service.redeem()` grants indirectly, so match the service call
                # too — matching only the direct call would let a route launder a grant
                # through any helper and pass this test.
                if "gpu_wallet_service.grant(" in body or "voucher_service.redeem(" in body:
                    granting.append(node.name)

        assert sorted(granting) == ["payment_webhook", "redeem_voucher"], (
            f"these routes can add credit: {granting}. Only the signature-verified webhook and the "
            "voucher redemption may — and a new one needs a reason written into this test."
        )
