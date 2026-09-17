"""Signing in from a native client, and what that credential may and may not do.

WHY A SECOND IDENTITY MECHANISM EXISTS AT ALL

The web app is a server talking to a server: Next.js authenticates a person, signs their user id
with a shared secret, and the API verifies the HMAC. That secret cannot be given to a desktop
client — shipping it inside an installable application hands every user the key to assert any
identity, which `services/gpu_wallet_service.py` calls the one place losing a race means charging
the wrong person.

So a native client gets a per-user, per-device token instead. These tests are mostly about the ways
that token must NOT behave, because it is the first long-lived credential in this codebase: the
other two token purposes are single-use links that live for an hour.
"""

import uuid
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src import identity
from src.database import get_db
from src.models.auth_token import (
    PURPOSE_DESKTOP_SESSION,
    PURPOSE_EMAIL_VERIFY,
    AuthToken,
)
from src.models.user import User
from src.routers import auth as auth_router
from src.services import token_service
from src.services.password_service import hash_password

from conftest import TEST_DATABASE_URL, requires_postgres

pytestmark = [requires_postgres, pytest.mark.asyncio]

PASSWORD = "correct horse battery staple"


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def learner(sessionmaker_np):
    user_id = uuid.uuid4()
    # `example.com`, not `.test`, and the difference is load-bearing here. Other suites insert
    # users straight into the database; this one signs in through the endpoint, where
    # `EmailStr` runs `email-validator` and refuses reserved TLDs like `.test` with a 422.
    email = f"desktop-{user_id.hex[:12]}@example.com"
    async with sessionmaker_np() as db:
        db.add(
            User(
                id=user_id,
                email=email,
                name="desktop test",
                role="student",
                password_hash=await hash_password(PASSWORD),
                is_active=True,
            )
        )
        await db.commit()
    yield user_id, email
    async with sessionmaker_np() as db:
        await db.execute(delete(AuthToken).where(AuthToken.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


@pytest_asyncio.fixture
async def client(sessionmaker_np, monkeypatch):
    # The limiter fails open without Redis and logs loudly; these tests are not about it.
    async def no_limit(*args, **kwargs):
        return None

    monkeypatch.setattr("src.ratelimit.check_email_and_ip", no_limit)

    app = FastAPI()
    app.include_router(auth_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


async def _sign_in(client, email: str, password: str = PASSWORD):
    return await client.post(
        "/v1/auth/desktop/session", json={"email": email, "password": password}
    )


class TestSigningIn:
    async def test_correct_credentials_return_a_token(self, client, learner):
        _, email = learner
        response = await _sign_in(client, email)

        assert response.status_code == 200
        body = response.json()
        assert len(body["token"]) > 30, "the token is too short to be 32 bytes of entropy"
        assert body["user"]["email"] == email

    async def test_the_raw_token_is_never_stored(self, client, sessionmaker_np, learner):
        """Same rule as a password reset link: the database holds a hash and nothing else.

        A token readable out of the database is a token any operator with read access can present
        as that user — and unlike a reset link, this one is valid for months.
        """
        user_id, email = learner
        token = (await _sign_in(client, email)).json()["token"]

        async with sessionmaker_np() as db:
            row = (
                await db.execute(select(AuthToken).where(AuthToken.user_id == user_id))
            ).scalar_one()
        assert row.token_hash != token
        assert row.token_hash == token_service.hash_token(token)
        assert row.purpose == PURPOSE_DESKTOP_SESSION

    async def test_a_wrong_password_and_an_unknown_address_are_indistinguishable(
        self, client, learner
    ):
        """The membership oracle this endpoint must not become.

        `/password-login` documents the reasoning at length; this asserts the same guarantee for
        the endpoint a native client uses, because a second sign-in surface is a second place to
        get it wrong.
        """
        _, email = learner
        wrong = await _sign_in(client, email, "not the password")
        missing = await _sign_in(client, f"nobody-{uuid.uuid4().hex}@example.com", PASSWORD)

        assert wrong.status_code == missing.status_code == 401
        assert wrong.json() == missing.json(), (
            "the two refusals differ, so this endpoint reports whether an address has an account"
        )

    async def test_a_deactivated_account_cannot_sign_in(self, client, sessionmaker_np, learner):
        user_id, email = learner
        async with sessionmaker_np() as db:
            await db.execute(update(User).where(User.id == user_id).values(is_active=False))
            await db.commit()

        assert (await _sign_in(client, email)).status_code == 401

    async def test_deactivating_an_account_ends_the_sessions_it_already_has(
        self, client, sessionmaker_np, learner
    ):
        """The half the test above does not cover, and the half that was broken.

        `is_active` used to be checked only when a session was ISSUED. A device signed in yesterday
        kept working after the account was switched off today, for the rest of its 90 days — so
        deactivating a compromised or abusive account stopped nobody who was already in.
        """
        user_id, email = learner
        token = (await _sign_in(client, email)).json()["token"]

        async with sessionmaker_np() as db:
            assert await token_service.user_id_for_session(db, token) == user_id
            await db.execute(update(User).where(User.id == user_id).values(is_active=False))
            await db.commit()

        async with sessionmaker_np() as db:
            assert await token_service.user_id_for_session(db, token) is None, (
                "a deactivated account's existing session still resolves"
            )

        # And it comes back when the account does: the session was refused, not destroyed.
        async with sessionmaker_np() as db:
            await db.execute(update(User).where(User.id == user_id).values(is_active=True))
            await db.commit()
        async with sessionmaker_np() as db:
            assert await token_service.user_id_for_session(db, token) == user_id


class TestTheTokenBehavesLikeASessionAndNotALink:
    async def test_using_it_does_not_consume_it(self, client, sessionmaker_np, learner):
        """THE ONE THAT MATTERS MOST.

        `token_service.redeem()` marks a token spent, which is correct for a link that may be used
        once and catastrophic for a credential presented on every request — the first API call
        would sign the person out. Verification is a separate function for exactly this reason.
        """
        _, email = learner
        token = (await _sign_in(client, email)).json()["token"]

        async with sessionmaker_np() as db:
            for attempt in range(3):
                resolved = await token_service.user_id_for_session(db, token)
                assert resolved is not None, f"the token stopped working after {attempt} use(s)"

    async def test_signing_in_twice_leaves_both_devices_working(
        self, client, sessionmaker_np, learner
    ):
        """`issue()` revokes prior tokens of the same purpose, and here it must not.

        A person signing in on a laptop must not be signed out on their desktop. That reads as a
        bug rather than as security, and it is the opposite of what a reset link needs.
        """
        _, email = learner
        first = (await _sign_in(client, email)).json()["token"]
        second = (await _sign_in(client, email)).json()["token"]
        assert first != second

        async with sessionmaker_np() as db:
            assert await token_service.user_id_for_session(db, first) is not None, (
                "signing in on a second device signed the first one out"
            )
            assert await token_service.user_id_for_session(db, second) is not None

    async def test_an_expired_token_resolves_to_nobody(self, client, sessionmaker_np, learner):
        user_id, email = learner
        token = (await _sign_in(client, email)).json()["token"]

        async with sessionmaker_np() as db:
            await db.execute(
                update(AuthToken)
                .where(AuthToken.user_id == user_id)
                .values(expires_at=datetime.utcnow() - timedelta(seconds=1))
            )
            await db.commit()
            assert await token_service.user_id_for_session(db, token) is None

    async def test_an_emailed_token_is_not_a_session(self, client, sessionmaker_np, learner):
        """Purposes are not interchangeable, and this is the pairing that would hurt.

        An emailed token is visible to anything that can read a mailbox. If it also authenticated
        API calls, reading somebody's email would be enough to spend their credit. The purpose used
        here is email verification because the reset LINK is gone — reset is a 6-digit code now
        (`test_web_auth_is_gone.py`) — but the rule under test is the purpose filter, not the flow.
        """
        user_id, _ = learner
        async with sessionmaker_np() as db:
            user = await db.get(User, user_id)
            emailed = await token_service.issue(db, user, PURPOSE_EMAIL_VERIFY)
            await db.commit()

            assert await token_service.user_id_for_session(db, emailed) is None


class TestSigningOut:
    async def test_it_ends_this_device_only(self, client, sessionmaker_np, learner):
        _, email = learner
        laptop = (await _sign_in(client, email)).json()["token"]
        desktop = (await _sign_in(client, email)).json()["token"]

        response = await client.request(
            "DELETE", "/v1/auth/desktop/session",
            headers={"Authorization": f"Bearer {laptop}"},
        )
        assert response.status_code == 200

        async with sessionmaker_np() as db:
            assert await token_service.user_id_for_session(db, laptop) is None
            assert await token_service.user_id_for_session(db, desktop) is not None, (
                "signing out on one device signed the other one out too"
            )

    async def test_signing_out_twice_says_the_same_thing(self, client, learner):
        """Reporting "there was nothing to revoke" tells a holder of a stale token that it is stale."""
        _, email = learner
        token = (await _sign_in(client, email)).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        first = await client.request("DELETE", "/v1/auth/desktop/session", headers=headers)
        second = await client.request("DELETE", "/v1/auth/desktop/session", headers=headers)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()


class TestTheBearerHeaderItself:
    @pytest.mark.parametrize(
        "header",
        [None, "", "Basic abc", "abc", "Bearer", "Bearer   "],
        ids=["absent", "empty", "basic", "no-scheme", "no-token", "blank-token"],
    )
    def test_nothing_that_is_not_a_bearer_token_is_read_as_one(self, header):
        """Treated as absent rather than rejected.

        An unrelated proxy adding an `Authorization` header should leave an anonymous visitor
        anonymous, not lock everybody out of the catalogue.
        """
        assert identity._bearer_from(header) is None

    def test_the_scheme_is_case_insensitive(self):
        assert identity._bearer_from("bearer abc") == "abc"
        assert identity._bearer_from("BEARER abc") == "abc"

    async def test_a_bad_token_is_refused_rather_than_treated_as_anonymous(self):
        """A client that sent a credential and got it wrong must be told.

        Falling through to anonymous would silently downgrade a signed-out desktop app into a free
        anonymous one — which would then be metered against the shared anonymous wallet, or refused
        for reasons that have nothing to do with the real cause.
        """
        from fastapi import HTTPException
        from starlette.requests import Request as StarletteRequest

        scope = {"type": "http", "method": "GET", "path": "/", "headers": []}
        with pytest.raises(HTTPException) as raised:
            await identity.resolve_caller(
                StarletteRequest(scope), authorization="Bearer not-a-real-token"
            )
        assert raised.value.status_code == 401
