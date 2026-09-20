"""Reading progress belongs to a person, and a signed-out reader is not one.

Every caller with no credential resolves to the same anonymous user. The papers router read and
wrote progress for whatever id it was handed, so every signed-out reader wrote into ONE shared
`paper_progress` row and saw everybody else's ticks as their own. The library is meant to be public;
the per-person overlay on top of it is not.

The desktop app makes this reachable in a way the web app did not: the research library is browsable
signed out there, by design. So these pin both halves — the library still loads for anybody, and
progress is neither written nor shown without a real session.
"""

import uuid

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from src.database import get_db
from src.identity import ANONYMOUS_USER_ID
from src.models.auth_token import AuthToken
from src.models.catalogue import Paper, PaperProgress
from src.models.user import User
from src.routers import papers as papers_router
from src.services import token_service

pytestmark = [requires_postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def sessionmaker_np():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def paper(sessionmaker_np):
    paper_id = uuid.uuid4()
    slug = f"test-paper-{paper_id.hex[:10]}"
    async with sessionmaker_np() as db:
        db.add(
            Paper(
                id=paper_id,
                slug=slug,
                title="A test paper",
                authors="A. Author",
                year=2024,
                pdf_url="https://arxiv.org/pdf/0000.00000",
                abstract="Abstract.",
                sections={"architecture": "body"},
                is_published=True,
            )
        )
        await db.commit()
    yield paper_id, slug
    async with sessionmaker_np() as db:
        await db.execute(delete(PaperProgress).where(PaperProgress.paper_id == paper_id))
        await db.execute(delete(Paper).where(Paper.id == paper_id))
        await db.commit()


@pytest_asyncio.fixture
async def reader(sessionmaker_np):
    """A signed-in person and their desktop session token."""
    user_id = uuid.uuid4()
    async with sessionmaker_np() as db:
        user = User(
            id=user_id,
            email=f"reader-{user_id.hex[:12]}@example.com",
            name="reader",
            role="student",
            is_active=True,
        )
        db.add(user)
        await db.flush()
        token = await token_service.issue_desktop_session(db, user)
        await db.commit()
    yield user_id, token
    async with sessionmaker_np() as db:
        await db.execute(delete(PaperProgress).where(PaperProgress.user_id == user_id))
        await db.execute(delete(AuthToken).where(AuthToken.user_id == user_id))
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()


@pytest_asyncio.fixture
async def anonymous_user(sessionmaker_np):
    """The shared anonymous row, created only if this database lacks it and removed only if so.

    `main.py` seeds it at startup, and tests never import `main`. Deleting a row the application
    created would break whatever else in this database relies on it.
    """
    async with sessionmaker_np() as db:
        result = await db.execute(
            insert(User)
            .values(
                id=ANONYMOUS_USER_ID,
                email="anonymous@voidcode.local",
                name="Anonymous",
                role="student",
                is_active=True,
            )
            .on_conflict_do_nothing()
            .returning(User.id)
        )
        created = result.scalar_one_or_none() is not None
        await db.commit()
    yield ANONYMOUS_USER_ID
    if created:
        async with sessionmaker_np() as db:
            await db.execute(delete(User).where(User.id == ANONYMOUS_USER_ID))
            await db.commit()


@pytest_asyncio.fixture
async def client(sessionmaker_np, monkeypatch):
    # Bearer resolution does not go through `get_db`: `identity._user_for_bearer` opens the
    # application's own POOLED `AsyncSessionLocal`, deliberately (see `resolve_caller`). In a full run
    # that pool holds asyncpg connections created on earlier tests' event loops, and using one from
    # this loop fails with "attached to a different loop" — this test passed alone and failed after
    # others. Production has one loop; the test has many, so it supplies an unpooled factory.
    monkeypatch.setattr("src.database.AsyncSessionLocal", sessionmaker_np)

    app = FastAPI()
    app.include_router(papers_router.router)

    async def _db():
        async with sessionmaker_np() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


def _bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def _card(listing: dict, slug: str) -> dict:
    return next(p for p in listing["papers"] if p["slug"] == slug)


class TestSignedOutReaders:
    async def test_the_library_is_still_public(self, client, paper):
        _, slug = paper
        assert (await client.get("/v1/papers")).status_code == 200
        assert (await client.get(f"/v1/papers/{slug}")).status_code == 200

    async def test_cannot_mark_a_section_read(self, client, sessionmaker_np, paper, anonymous_user):
        paper_id, slug = paper
        response = await client.post(f"/v1/papers/{slug}/read", json={"section": "architecture"})

        assert response.status_code == 401
        async with sessionmaker_np() as db:
            rows = (
                await db.execute(
                    select(PaperProgress).where(
                        PaperProgress.paper_id == paper_id,
                        PaperProgress.user_id == ANONYMOUS_USER_ID,
                    )
                )
            ).scalars().all()
        assert rows == [], "a signed-out reader still wrote into the shared anonymous row"

    async def test_do_not_see_the_shared_anonymous_row(
        self, client, sessionmaker_np, paper, anonymous_user
    ):
        """Rows written before the fix still exist. Reading must not show them to anybody."""
        paper_id, slug = paper
        async with sessionmaker_np() as db:
            db.add(
                PaperProgress(
                    user_id=ANONYMOUS_USER_ID, paper_id=paper_id, sections_read=["architecture"]
                )
            )
            await db.commit()

        listing = (await client.get("/v1/papers")).json()
        assert _card(listing, slug)["sectionsRead"] == []
        detail = (await client.get(f"/v1/papers/{slug}")).json()
        assert detail["sectionsRead"] == []


class TestSignedInReaders:
    async def test_progress_is_recorded_and_shown_only_to_its_owner(self, client, paper, reader):
        _, slug = paper
        _, token = reader

        marked = await client.post(
            f"/v1/papers/{slug}/read", json={"section": "architecture"}, headers=_bearer(token)
        )
        assert marked.status_code == 200
        assert marked.json()["sectionsRead"] == ["architecture"]

        mine = (await client.get("/v1/papers", headers=_bearer(token))).json()
        assert _card(mine, slug)["sectionsRead"] == ["architecture"]

        signed_out = (await client.get("/v1/papers")).json()
        assert _card(signed_out, slug)["sectionsRead"] == [], (
            "a signed-out reader sees a signed-in person's progress"
        )
