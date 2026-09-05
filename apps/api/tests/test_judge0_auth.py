"""Judge0 is a privileged container that runs untrusted code. Its port is the sandbox boundary.

`docker-compose.yml` published `2358:2358` — every interface on the host — with no authentication
token configured. On a laptop behind NAT that is survivable; on any public host it means anyone who
can reach the port runs code inside a privileged container.

The failure mode these tests guard is quiet: a request that omits the token works perfectly until
Judge0 is configured to require one, and then only *some* calls break. The submit/poll pair is
exactly where that bites — I wrote `_headers` as a property so no call site could forget, and then
forgot the poll GET.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from src.services.judge0_client import Judge0Client

ROOT = Path(__file__).resolve().parents[3]
CLIENT_SOURCE = (Path(__file__).resolve().parents[1] / "src" / "services" / "judge0_client.py")


# ── the client sends the token on every call ─────────────────────────────────

def test_no_token_configured_sends_no_header() -> None:
    """Local development must keep working with no setup, and Judge0 ignores the header anyway."""
    assert Judge0Client(auth_token="")._headers == {}


def test_a_configured_token_is_sent() -> None:
    assert Judge0Client(auth_token="secret")._headers == {"X-Auth-Token": "secret"}


def test_every_judge0_request_passes_the_headers() -> None:
    """Counts call sites rather than trusting that they all remembered.

    There are three — submit POST, poll GET, health-check GET — and the poll was the one that
    shipped without it. An unauthenticated poll succeeds against an open Judge0 and fails only once
    the token is required, at which point runs submit fine and then never resolve.
    """
    source = CLIENT_SOURCE.read_text(encoding="utf-8")
    calls = re.findall(r"await client\.(?:get|post)\([^)]*\)", source, re.DOTALL)
    assert len(calls) == 3, f"expected 3 Judge0 calls, found {len(calls)} — update this test"
    for call in calls:
        assert "headers=self._headers" in call, f"call without auth headers: {call[:70]}"


# ── the compose files do not expose the sandbox ──────────────────────────────

def test_judge0_is_not_published_on_every_interface() -> None:
    """`"2358:2358"` binds all interfaces. `"127.0.0.1:2358:2358"` binds loopback only."""
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert '"2358:2358"' not in compose, (
        "judge0 is published on every interface again — bind 127.0.0.1 or drop the ports block")
    assert '"127.0.0.1:2358:2358"' in compose


def test_judge0_requires_a_token() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "AUTHN_HEADER: X-Auth-Token" in compose
    assert "AUTHN_TOKEN: ${JUDGE0_AUTH_TOKEN:-}" in compose


def test_the_admin_token_is_a_separate_secret() -> None:
    """AUTHZ guards endpoints that can read every submission ever made. Reusing the AUTHN value
    means a leaked run token is also an admin token."""
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "AUTHZ_TOKEN: ${JUDGE0_ADMIN_TOKEN:-}" in compose
    assert "AUTHZ_TOKEN: ${JUDGE0_AUTH_TOKEN:-}" not in compose


@pytest.mark.parametrize("compose_file", ["docker-compose.prod.yml", "docker-compose.gpu.yml"])
def test_the_api_service_receives_the_token(compose_file: str) -> None:
    """The API knowing JUDGE0_BASE_URL but not the token means every run comes back 401 — and it
    would look like Judge0 being broken rather than like a missing variable."""
    compose = (ROOT / compose_file).read_text(encoding="utf-8")
    urls = compose.count("JUDGE0_BASE_URL=http://judge0-server:2358")
    tokens = compose.count("JUDGE0_AUTH_TOKEN=${JUDGE0_AUTH_TOKEN:-}")
    assert tokens == urls, (
        f"{compose_file}: {urls} services know the Judge0 URL but {tokens} have the token")


def test_both_tokens_are_documented_and_empty() -> None:
    """A template that ships a value is a template someone deploys unchanged."""
    env = (ROOT / "apps" / "api" / ".env.example").read_text(encoding="utf-8")
    assert "JUDGE0_AUTH_TOKEN=\n" in env
    assert "JUDGE0_ADMIN_TOKEN=\n" in env


# ── the limits must be sent, not inherited ───────────────────────────────────

def test_every_security_limit_is_sent_explicitly() -> None:
    """`sandbox/adversarial.py` found the fork bomb, output flood and a sleeping process all
    stopped — and every one was stopped by a JUDGE0 DEFAULT this client never asked for.

    A security limit inherited from a server default changes when somebody edits an unrelated
    deployment, and nothing here would notice. Verified by measurement, not just by config: sending
    these moved the fork bomb from 58 forks to 28 and the sleep kill from 12.5 s to 5.2 s.
    """
    source = CLIENT_SOURCE.read_text(encoding="utf-8")
    payload = source[source.index("payload = {"):source.index("if stdin is not None")]
    for key in ("wall_time_limit", "max_processes_and_or_threads", "max_file_size",
                "stack_limit", "enable_network"):
        assert f'"{key}"' in payload, f"the submission payload no longer sends {key}"


def test_the_wall_clock_limit_is_separate_from_the_cpu_limit() -> None:
    """A submission that sleeps burns no CPU, so cpu_time_limit alone never fires — it just holds a
    worker. Measured at 25 s of sleep against a 2 s CPU limit."""
    source = CLIENT_SOURCE.read_text(encoding="utf-8")
    assert "WALL_TIME_MARGIN" in source
    assert '"wall_time_limit": min(' in source, (
        "wall_time_limit must be derived from cpu_time_limit, and capped")


def test_network_is_refused_at_the_container_too() -> None:
    """The client sending enable_network=false is one half. `allow_enable_network` was TRUE on the
    instance, so the capability existed and only the default was hiding it."""
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert 'ALLOW_ENABLE_NETWORK: "false"' in compose
