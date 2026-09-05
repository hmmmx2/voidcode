"""
Shared fixtures for the API test suite.

WHY THE APP IS ASSEMBLED HERE RATHER THAN IMPORTED FROM `main`

`apps/api/src/main.py` imports torch and transformers at module scope and
injects `llm/scripts` onto `sys.path` to reach `prompts.py`. Importing it to
test a router would make the suite depend on the whole inference stack being
installed, and would take tens of seconds per run. The routers themselves have
light dependencies (httpx, sqlalchemy), so the tests build a minimal app around
the router under test. That also keeps the blast radius honest: a failure here
is a failure in the router, not in model loading.

WHY POSTGRES AND NOT SQLITE

The models use `sqlalchemy.dialects.postgresql.UUID` and JSON columns. SQLite
cannot compile those, and shimming them would mean the tests exercise different
column types than production — which is exactly the class of difference that
lets a bug through. The DB-backed tests therefore need a real Postgres and are
marked `requires_postgres`; they skip cleanly when one is not reachable and run
in CI where it is a service container.

The pure grading tests need none of this and always run. That split is
deliberate: every defect this module has had lived in a pure function, so the
tests that matter most are the ones with no infrastructure between them and the
logic.
"""

import os
import socket
from urllib.parse import urlparse

import pytest

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://alwin:alwin_dev@localhost:5433/alwin_tutor",
)


def _postgres_reachable(url: str, timeout: float = 1.5) -> bool:
    """A TCP probe, not a connection — we only need to decide skip vs run."""
    parsed = urlparse(url.replace("+asyncpg", ""))
    host, port = parsed.hostname or "localhost", parsed.port or 5432
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


POSTGRES_AVAILABLE = _postgres_reachable(TEST_DATABASE_URL)

requires_postgres = pytest.mark.skipif(
    not POSTGRES_AVAILABLE,
    reason=(
        f"no Postgres at {TEST_DATABASE_URL} — start it with "
        "`docker compose up -d postgres`"
    ),
)


# ── Judge0 fake ─────────────────────────────────────────────────
#
# Judge0 needs a privileged container and takes seconds per submission. The
# tests care about what the router does with a result, never about Judge0's own
# behaviour, so a fake keeps them fast and hermetic.


class FakeJudge0:
    """
    Records calls and replays scripted results.

    `by_stdin` lets a test say "when you run against THIS input, return THAT" —
    which is what the exfiltration test needs, since it has to simulate a
    program echoing its own stdin back.
    """

    def __init__(self, default=None, by_stdin=None):
        self.default = default or self.accepted("")
        self.by_stdin = by_stdin or {}
        self.calls = []

    @staticmethod
    def accepted(stdout: str, **overrides) -> dict:
        result = {
            "stdout": stdout,
            "stderr": None,
            "compile_output": None,
            "status_id": 3,
            "status_description": "Accepted",
            "time": "0.010",
            "memory": 3200,
            "exit_code": 0,
        }
        result.update(overrides)
        return result

    async def submit(self, **kwargs):
        self.calls.append(kwargs)
        stdin = kwargs.get("stdin")
        if stdin in self.by_stdin:
            return self.by_stdin[stdin]
        if callable(self.default):
            return self.default(**kwargs)
        return self.default


@pytest.fixture
def fake_judge0(monkeypatch):
    """Replace the Judge0 singleton for the duration of one test."""

    def _install(default=None, by_stdin=None) -> FakeJudge0:
        fake = FakeJudge0(default=default, by_stdin=by_stdin)
        from src.routers import execution as execution_module
        from src.services import judge0_client as judge0_module

        monkeypatch.setattr(judge0_module, "judge0_client", fake)
        monkeypatch.setattr(execution_module, "judge0_client", fake)
        return fake

    return _install


@pytest.fixture
def anyio_backend():
    return "asyncio"
