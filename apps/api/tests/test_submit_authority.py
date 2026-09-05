"""
`/v1/submit` end to end: the client cannot influence the verdict.

These need a real Postgres (see conftest for why SQLite is not an option) and
skip cleanly without one. The pure counterparts in `test_grading_semantics.py`
always run and cover the same invariants at the function level; these cover the
data flow, which is where the vulnerability actually lived — no single function
was wrong, the expected answer simply arrived from the wrong place.
"""

import uuid

import pytest
import pytest_asyncio
from conftest import TEST_DATABASE_URL, requires_postgres
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from src.models.problem import Problem

# Aliased: pytest tries to collect module-level `Test*` names as test classes.
from src.models.problem import TestCase as CaseRow
from src.routers import execution as execution_module

pytestmark = [requires_postgres, pytest.mark.asyncio]


VISIBLE_STDIN = "[2,7,11,15]\n9"
VISIBLE_EXPECTED = "[0, 1]"
HIDDEN_STDIN = "SECRET_HIDDEN_INPUT"
HIDDEN_EXPECTED = "SECRET_HIDDEN_ANSWER"


@pytest_asyncio.fixture
async def db_sessionmaker():
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=None)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


@pytest_asyncio.fixture
async def seeded_problem(db_sessionmaker, monkeypatch):
    """
    A published problem with one visible and one hidden case.

    Torn down explicitly rather than left behind: `test_cases` cascades from
    `problems`, so deleting the problem is sufficient.
    """
    monkeypatch.setattr(execution_module, "AsyncSessionLocal", db_sessionmaker)

    problem = Problem(
        id=uuid.uuid4(),
        slug=f"test-{uuid.uuid4().hex[:12]}",
        title="Fixture Problem",
        difficulty="easy",
        description="fixture",
        examples=[], constraints=[], hints=[],
        order_index=0,
        is_published=True,
    )
    visible = CaseRow(
        id=uuid.uuid4(), problem_id=problem.id, label="Case 1",
        inputs=[{"name": "nums", "value": "[2,7,11,15]"}],
        stdin=VISIBLE_STDIN, expected_output=VISIBLE_EXPECTED,
        order_index=0, is_hidden=False,
    )
    hidden = CaseRow(
        id=uuid.uuid4(), problem_id=problem.id, label="Hidden 1",
        inputs=[], stdin=HIDDEN_STDIN, expected_output=HIDDEN_EXPECTED,
        order_index=100, is_hidden=True,
    )

    async with db_sessionmaker() as db:
        db.add(problem)
        await db.flush()
        db.add_all([visible, hidden])
        await db.commit()

    yield problem

    async with db_sessionmaker() as db:
        obj = await db.get(Problem, problem.id)
        if obj is not None:
            await db.delete(obj)
            await db.commit()


@pytest_asyncio.fixture
async def client():
    app = FastAPI()
    app.include_router(execution_module.router)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _payload(problem_id, **overrides):
    body = {
        "source_code": "print('[0, 1]')",
        "language_id": 71,
        "problem_id": str(problem_id),
        "language": "Python",
    }
    body.update(overrides)
    return body


# ── The vulnerability, directly ─────────────────────────────────


async def test_client_cannot_supply_expected_output(client, seeded_problem, fake_judge0):
    """
    THE regression test for the forged pass.

    Before the fix, `test_cases` on the request body carried `expected_output`
    and the server graded against it — so this payload, whose expected outputs
    are whatever the submitted code happens to print, returned all_passed=true
    and persisted `accepted`.

    Now the field is rejected outright by `extra="forbid"`. A stale client fails
    loudly rather than being quietly graded by a path that no longer reads it.
    """
    fake_judge0()
    response = await client.post("/v1/submit", json=_payload(
        seeded_problem.id,
        test_cases=[{"id": "x", "stdin": "anything", "expected_output": "WRONG"}],
    ))
    assert response.status_code == 422


async def test_verdict_comes_from_the_database(client, seeded_problem, fake_judge0):
    """Correct output against the DB's expected values passes both cases."""
    from conftest import FakeJudge0

    fake_judge0(by_stdin={
        VISIBLE_STDIN: FakeJudge0.accepted(VISIBLE_EXPECTED),
        HIDDEN_STDIN: FakeJudge0.accepted(HIDDEN_EXPECTED),
    })
    body = (await client.post("/v1/submit", json=_payload(seeded_problem.id))).json()

    assert body["total_tests"] == 2, "the hidden case must be graded too"
    assert body["passed_tests"] == 2
    assert body["all_passed"] is True


async def test_passing_only_the_visible_case_is_not_a_pass(
    client, seeded_problem, fake_judge0
):
    """
    The reason hidden cases exist: a solution that satisfies the published
    example and nothing else must not be accepted.
    """
    from conftest import FakeJudge0

    fake_judge0(by_stdin={
        VISIBLE_STDIN: FakeJudge0.accepted(VISIBLE_EXPECTED),
        HIDDEN_STDIN: FakeJudge0.accepted("wrong"),
    })
    body = (await client.post("/v1/submit", json=_payload(seeded_problem.id))).json()

    assert body["all_passed"] is False
    assert body["passed_tests"] == 1


# ── Hidden-case confidentiality, end to end ─────────────────────


async def test_hidden_stdin_cannot_be_exfiltrated_via_stdout(
    client, seeded_problem, fake_judge0
):
    """
    Simulates `print(sys.stdin.read())` — the program echoes its own input.

    Asserted against the raw response BODY, so any channel that carries output
    is covered, not only the fields someone thought to null out.
    """
    from conftest import FakeJudge0

    fake_judge0(default=lambda **kw: FakeJudge0.accepted(kw.get("stdin") or ""))
    response = await client.post("/v1/submit", json=_payload(seeded_problem.id))

    assert HIDDEN_STDIN not in response.text
    assert HIDDEN_EXPECTED not in response.text

    # The visible case is deliberately NOT redacted — its input and expected
    # output are printed in the problem statement, so withholding them here
    # would break the test console for no benefit.
    visible = [r for r in response.json()["test_case_results"] if not r["is_hidden"]]
    assert visible[0]["expected_output"] == VISIBLE_EXPECTED


async def test_hidden_case_still_reports_pass_fail_and_label(
    client, seeded_problem, fake_judge0
):
    from conftest import FakeJudge0

    fake_judge0(default=lambda **kw: FakeJudge0.accepted("nope"))
    body = (await client.post("/v1/submit", json=_payload(seeded_problem.id))).json()

    hidden = [r for r in body["test_case_results"] if r["is_hidden"]]
    assert len(hidden) == 1
    assert hidden[0]["passed"] is False
    assert hidden[0]["label"] == "Hidden 1"
    assert hidden[0]["expected_output"] is None


# ── Request validation ──────────────────────────────────────────


async def test_missing_problem_id_is_422(client, seeded_problem, fake_judge0):
    fake_judge0()
    body = _payload(seeded_problem.id)
    del body["problem_id"]
    assert (await client.post("/v1/submit", json=body)).status_code == 422


async def test_malformed_problem_id_is_400(client, seeded_problem, fake_judge0):
    fake_judge0()
    response = await client.post("/v1/submit", json=_payload("not-a-uuid"))
    assert response.status_code == 400


async def test_unknown_problem_is_404(client, seeded_problem, fake_judge0):
    fake_judge0()
    response = await client.post("/v1/submit", json=_payload(uuid.uuid4()))
    assert response.status_code == 404


async def test_unpublished_problem_is_404_not_403(
    client, seeded_problem, db_sessionmaker, fake_judge0
):
    """404, not 403 — the endpoint should not confirm that the problem exists."""
    fake_judge0()
    async with db_sessionmaker() as db:
        obj = await db.get(Problem, seeded_problem.id)
        obj.is_published = False
        await db.commit()

    response = await client.post("/v1/submit", json=_payload(seeded_problem.id))
    assert response.status_code == 404


async def test_problem_with_no_test_cases_is_409(
    client, seeded_problem, db_sessionmaker, fake_judge0
):
    """
    Never a 200. Zero cases previously produced all_passed=True via `0 == 0`;
    now grading is unreachable in that state.
    """
    fake_judge0()
    # A bulk DELETE, not `for tc in obj.test_cases`. Touching that relationship
    # would lazy-load it, and a lazy load on an AsyncSession raises
    # `MissingGreenlet` — the async equivalent of an implicit IO the caller
    # never asked for. `selectinload` would also work; a bulk statement is
    # simpler and is what the seeder does.
    async with db_sessionmaker() as db:
        await db.execute(sa_delete(CaseRow).where(CaseRow.problem_id == seeded_problem.id))
        await db.commit()

    response = await client.post("/v1/submit", json=_payload(seeded_problem.id))
    assert response.status_code == 409


# ── Judge0 no longer receives expected answers ──────────────────


async def test_expected_output_is_never_sent_to_judge0(
    client, seeded_problem, fake_judge0
):
    """
    Judge0 will grade for you if given `expected_output`, and we never used that
    verdict. Passing it only sent every answer to a third-party service.
    """
    from conftest import FakeJudge0

    fake = fake_judge0(default=lambda **kw: FakeJudge0.accepted("x"))
    await client.post("/v1/submit", json=_payload(seeded_problem.id))

    assert fake.calls, "Judge0 should have been called"
    for call in fake.calls:
        assert "expected_output" not in call
