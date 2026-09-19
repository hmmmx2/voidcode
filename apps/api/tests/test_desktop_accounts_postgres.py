"""Desktop accounts, driven through real HTTP against a real database.

Registration into a session, password reset by emailed code, and the account itself. These go
through the router rather than calling services, because the mistake that matters most here only
exists at that level: a wrong-guess counter written by the service and then rolled back by `get_db`
when the handler raises — correct in every unit test, and unlimited guessing in production.

THIS FILE USED TO BE TWICE THIS SIZE. Google and Microsoft sign-in is gone, and with it
`TestProviderSignIn`, `TestConnectingAProvider`, the `oidc_fakes` provider and every assertion about
`user_identities` and linking. The second mistake this docstring used to name — "an identity
decision that is right in `account_linking` and bypassed by how the router calls it" — cannot happen
any more, because there is no identity decision to get wrong.

Reset by code is what carries the weight now. It is the ONLY route back in for an account that has
no password, which is exactly what a provider-created account is.

Rate limiting is replaced with a no-op (it has its own suite) and email sending is captured.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from conftest import TEST_DATABASE_URL, requires_postgres
from src import config
from src.database import get_db
from src.models.auth_token import PURPOSE_PASSWORD_RESET_CODE, AuthToken
from src.models.user import User
from src.routers import auth as auth_router
from src.services import email_service, token_service
from src.services.password_service import hash_password

pytestmark = [requires_postgres, pytest.mark.asyncio]

PASSWORD = "correct horse battery staple"
NEW_PASSWORD = "a different long passphrase"
TERMS = "2026-09-17"
PREFIX = "acct-test-"


def address(tag: str = "") -> str:
    # `example.com`, not `.test`: `EmailStr` rejects reserved TLDs with a 422.
    return f"{PREFIX}{tag}{uuid.uuid4().hex[:10]}@example.com"


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    # Every account these tests create starts with PREFIX; users cascade to tokens and identities.
    async with maker() as db:
        await db.execute(delete(User).where(User.email.like(f"{PREFIX}%")))
        await db.execute(delete(User).where(User.email.like("learner-%@gmail.com")))
        await db.commit()
    await engine.dispose()


@pytest.fixture
def mailbox(monkeypatch):
    sent: list[email_service.Email] = []

    async def capture(message):
        sent.append(message)
        return True

    monkeypatch.setattr(email_service, "send", capture)
    return sent


@pytest_asyncio.fixture
async def client(sessionmaker_np, monkeypatch):
    async def no_limit(*args, **kwargs):
        return None

    monkeypatch.setattr("src.ratelimit.check", no_limit)
    # Bearer resolution opens the application's own pooled factory; see test_papers_progress_postgres.
    monkeypatch.setattr("src.database.AsyncSessionLocal", sessionmaker_np)

    app = FastAPI()
    app.include_router(auth_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                # The production `get_db` rolls back when a handler raises. The test override must
                # too, or the rollback-undoes-the-attempt-count bug could never show up here.
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


def bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


async def make_user(sessionmaker_np, email: str, *, password: str | None = PASSWORD,
                    verified: bool = True, active: bool = True) -> uuid.UUID:
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        db.add(User(
            id=user_id, email=email, name="test", role="student", is_active=active,
            password_hash=await hash_password(password) if password else None,
            email_verified_at=datetime.now(timezone.utc) if verified else None,
        ))
        await db.commit()
    return user_id


async def sign_in(client, email: str, password: str = PASSWORD):
    return await client.post("/v1/auth/desktop/session", json={"email": email, "password": password})


async def me(client, token: str):
    return await client.get("/v1/auth/me", headers=bearer(token))


# ── Registration ─────────────────────────────────────────────────────────────


class TestRegistration:
    async def test_it_returns_a_working_session_and_records_the_terms(self, client, sessionmaker_np):
        email = address("reg-")
        response = await client.post("/v1/auth/desktop/register", json={
            "name": "New Learner", "email": email, "password": PASSWORD,
            "terms_accepted": True, "terms_version": TERMS})

        assert response.status_code == 201
        body = response.json()
        assert body["created"] is True
        assert (await me(client, body["token"])).json()["email"] == email

        async with sessionmaker_np() as db:
            user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert user.terms_version == TERMS
        assert user.terms_accepted_at is not None

    async def test_an_address_in_use_is_409_and_issues_nothing(self, client, sessionmaker_np):
        email = address("dup-")
        user_id = await make_user(sessionmaker_np, email)
        response = await client.post("/v1/auth/desktop/register", json={
            "name": "x", "email": email, "password": PASSWORD, "terms_accepted": True, "terms_version": TERMS})
        assert response.status_code == 409
        async with sessionmaker_np() as db:
            tokens = (await db.execute(select(AuthToken).where(AuthToken.user_id == user_id))).scalars().all()
        assert tokens == []

    async def test_refused_terms_or_a_weak_password_creates_nothing(self, client, sessionmaker_np):
        email = address("bad-")
        no_terms = await client.post("/v1/auth/desktop/register", json={
            "name": "x", "email": email, "password": PASSWORD, "terms_accepted": False, "terms_version": TERMS})
        weak = await client.post("/v1/auth/desktop/register", json={
            "name": "x", "email": email, "password": "password", "terms_accepted": True, "terms_version": TERMS})
        assert no_terms.status_code == 422 and weak.status_code == 422
        async with sessionmaker_np() as db:
            assert (await db.execute(select(User).where(User.email == email))).scalar_one_or_none() is None


# ── Password reset by code ───────────────────────────────────────────────────


async def request_code(client, mailbox, email: str) -> str | None:
    before = len(mailbox)
    response = await client.post("/v1/auth/password-reset/request", json={"email": email})
    assert response.status_code == 200
    if len(mailbox) == before:
        return None
    body = mailbox[-1].body
    return next(word for word in body.replace(".", " ").split() if word.isdigit() and len(word) == 6)


async def confirm(client, email: str, code: str, password: str = NEW_PASSWORD):
    return await client.post("/v1/auth/password-reset/confirm",
                             json={"email": email, "code": code, "new_password": password})


def wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


class TestResetByCode:
    async def test_a_known_and_an_unknown_address_get_the_same_answer(self, client, sessionmaker_np, mailbox):
        known = address("known-")
        await make_user(sessionmaker_np, known)
        a = await client.post("/v1/auth/password-reset/request", json={"email": known})
        b = await client.post("/v1/auth/password-reset/request", json={"email": address("nobody-")})
        assert (a.status_code, a.json()) == (b.status_code, b.json())
        assert len(mailbox) == 1 and mailbox[0].to == known

    async def test_the_code_is_stored_keyed_not_as_a_plain_hash(self, client, sessionmaker_np, mailbox):
        email = address("hash-")
        user_id = await make_user(sessionmaker_np, email)
        code = await request_code(client, mailbox, email)
        async with sessionmaker_np() as db:
            row = (await db.execute(select(AuthToken).where(
                AuthToken.user_id == user_id, AuthToken.purpose == PURPOSE_PASSWORD_RESET_CODE))).scalar_one()
        assert row.token_hash != hashlib.sha256(code.encode()).hexdigest()
        assert row.token_hash != token_service.hash_token(code)
        assert code not in (mailbox[0].subject or "")

    async def test_success_signs_in_and_signs_every_other_device_out(self, client, sessionmaker_np, mailbox):
        email = address("ok-")
        await make_user(sessionmaker_np, email, verified=False)
        old_device = (await sign_in(client, email)).json()["token"]
        code = await request_code(client, mailbox, email)

        response = await confirm(client, email, code)

        assert response.status_code == 200
        assert (await me(client, response.json()["token"])).status_code == 200
        assert (await me(client, old_device)).status_code == 401, "an old device survived a reset"
        assert (await sign_in(client, email, NEW_PASSWORD)).status_code == 200
        assert (await sign_in(client, email, PASSWORD)).status_code == 401
        async with sessionmaker_np() as db:
            user = (await db.execute(select(User).where(User.email == email))).scalar_one()
        assert user.email_verified_at is not None, "receiving the code proves the mailbox"

    async def test_wrong_guesses_accumulate_across_requests_and_lock_the_code(
        self, client, sessionmaker_np, mailbox
    ):
        """THE test for the rollback trap: each guess is a separate HTTP request, and the refusal is
        raised after the count is written. If the handler did not commit first, `get_db` would roll
        the count back and this would never lock."""
        email = address("lock-")
        user_id = await make_user(sessionmaker_np, email)
        code = await request_code(client, mailbox, email)

        for i in range(config.PASSWORD_RESET_CODE_MAX_ATTEMPTS - 1):
            response = await confirm(client, email, wrong(code))
            assert response.status_code == 400
            assert "Too many" not in response.json()["detail"], f"locked early, on guess {i + 1}"

        last = await confirm(client, email, wrong(code))
        assert "Too many attempts" in last.json()["detail"]

        # The right code is now useless.
        assert (await confirm(client, email, code)).status_code == 400
        assert (await sign_in(client, email, PASSWORD)).status_code == 200, "the password changed"

        async with sessionmaker_np() as db:
            row = (await db.execute(select(AuthToken).where(
                AuthToken.user_id == user_id, AuthToken.purpose == PURPOSE_PASSWORD_RESET_CODE))).scalar_one()
        assert row.attempts == config.PASSWORD_RESET_CODE_MAX_ATTEMPTS
        assert row.used_at is not None

    async def test_a_rejected_password_does_not_spend_a_guess(self, client, sessionmaker_np, mailbox):
        email = address("policy-")
        user_id = await make_user(sessionmaker_np, email)
        code = await request_code(client, mailbox, email)
        assert (await confirm(client, email, code, password="password")).status_code == 422
        async with sessionmaker_np() as db:
            row = (await db.execute(select(AuthToken).where(
                AuthToken.user_id == user_id, AuthToken.purpose == PURPOSE_PASSWORD_RESET_CODE))).scalar_one()
        assert row.attempts == 0
        assert (await confirm(client, email, code)).status_code == 200

    async def test_an_account_with_no_password_can_set_its_first_one(self, client, sessionmaker_np, mailbox):
        """Someone who signed up through Google on the website had no way to ever get a password."""
        email = address("oauthonly-")
        await make_user(sessionmaker_np, email, password=None)
        code = await request_code(client, mailbox, email)
        assert code is not None, "no code was sent to an account without a password"
        assert (await confirm(client, email, code)).status_code == 200
        assert (await sign_in(client, email, NEW_PASSWORD)).status_code == 200

    async def test_an_expired_code_is_refused(self, client, sessionmaker_np, mailbox):
        email = address("expired-")
        user_id = await make_user(sessionmaker_np, email)
        code = await request_code(client, mailbox, email)
        async with sessionmaker_np() as db:
            await db.execute(update(AuthToken).where(AuthToken.user_id == user_id)
                             .values(expires_at=datetime.utcnow() - timedelta(minutes=1)))
            await db.commit()
        assert (await confirm(client, email, code)).status_code == 400

    async def test_a_new_code_kills_the_old_one(self, client, sessionmaker_np, mailbox):
        email = address("reissue-")
        await make_user(sessionmaker_np, email)
        first = await request_code(client, mailbox, email)
        second = await request_code(client, mailbox, email)
        if first != second:
            assert (await confirm(client, email, first)).status_code == 400
        assert (await confirm(client, email, second)).status_code == 200


# ── The account ──────────────────────────────────────────────────────────────


class TestTheAccount:
    async def test_me_requires_a_session(self, client):
        assert (await client.get("/v1/auth/me")).status_code == 401

    async def test_changing_a_password_keeps_this_device_and_ends_the_others(self, client, sessionmaker_np):
        email = address("change-")
        await make_user(sessionmaker_np, email)
        this_device = (await sign_in(client, email)).json()["token"]
        other_device = (await sign_in(client, email)).json()["token"]

        response = await client.post("/v1/auth/change-password", headers=bearer(this_device),
                                     json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})

        assert response.status_code == 200
        assert (await me(client, this_device)).status_code == 200
        assert (await me(client, other_device)).status_code == 401

    async def test_a_wrong_current_password_is_a_form_error_not_an_ended_session(self, client, sessionmaker_np):
        """The desktop app signs a device out on any 401 from a request that carried its session.
        A mistyped current password is a field error; answering it with 401 signed out the very
        person who was signed in."""
        email = address("wrong-current-")
        await make_user(sessionmaker_np, email)
        token = (await sign_in(client, email)).json()["token"]

        response = await client.post("/v1/auth/change-password", headers=bearer(token),
                                     json={"current_password": "not-" + PASSWORD, "new_password": NEW_PASSWORD})

        assert response.status_code == 400
        assert response.json()["detail"]["field"] == "current_password"
        assert (await me(client, token)).status_code == 200

    async def test_sign_out_everywhere(self, client, sessionmaker_np):
        email = address("everywhere-")
        await make_user(sessionmaker_np, email)
        tokens = [(await sign_in(client, email)).json()["token"] for _ in range(3)]
        response = await client.delete("/v1/auth/desktop/sessions", headers=bearer(tokens[0]))
        assert response.status_code == 200
        for token in tokens:
            assert (await me(client, token)).status_code == 401
