"""The development session minter: it must work in development and do nothing at all in production.

It creates an account and signs it in without a password, which is exactly an account-takeover
primitive. The refusal is therefore the important test, and it asserts the database is never touched
— a refusal that printed a warning after opening a connection would be a refusal in name only.
"""

import asyncio
import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from scripts import mint_desktop_session as minter
from src.models.auth_token import AuthToken
from src.models.user import User
from src.services import token_service

from conftest import TEST_DATABASE_URL, requires_postgres


def test_production_is_refused_before_any_database_work(monkeypatch, capsys):
    monkeypatch.setattr(minter.config, "IS_PRODUCTION", True)

    class Untouchable:
        def __call__(self, *args, **kwargs):
            raise AssertionError("opened a database session in production")

    monkeypatch.setattr(minter, "AsyncSessionLocal", Untouchable())

    assert minter.main(["--email", "someone@example.com"]) == 2
    captured = capsys.readouterr()
    assert captured.out == "", "printed something that looks like a token while refusing"
    assert "production" in captured.err.lower()


@requires_postgres
def test_it_prints_a_session_that_resolves_to_the_account(monkeypatch, capsys):
    monkeypatch.setattr(minter.config, "IS_PRODUCTION", False)
    # The script's own `AsyncSessionLocal` is the application's POOLED engine, and `main` runs its
    # own `asyncio.run` loop. In a full suite that pool already holds asyncpg connections created on
    # other tests' loops, which cannot be used from this one — it failed only when run after them,
    # logging "Exception terminating connection". An unpooled factory makes it order-independent,
    # the same way every other Postgres test here builds its sessions.
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    monkeypatch.setattr(minter, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    email = f"Mint-{uuid.uuid4().hex[:10]}@Example.com"

    try:
        assert minter.main(["--email", email]) == 0
        token = capsys.readouterr().out.strip()
        assert token and "\n" not in token, "stdout must be exactly the token"

        async def check():
            engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
            async with async_sessionmaker(engine)() as db:
                user = (
                    await db.execute(select(User).where(User.email == email.lower()))
                ).scalar_one()
                assert await token_service.user_id_for_session(db, token) == user.id
            await engine.dispose()

        asyncio.run(check())
    finally:
        async def cleanup():
            engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
            async with async_sessionmaker(engine)() as db:
                ids = (
                    await db.execute(select(User.id).where(User.email == email.lower()))
                ).scalars().all()
                if ids:
                    await db.execute(delete(AuthToken).where(AuthToken.user_id.in_(ids)))
                    await db.execute(delete(User).where(User.id.in_(ids)))
                    await db.commit()
            await engine.dispose()

        asyncio.run(cleanup())
        asyncio.run(engine.dispose())
