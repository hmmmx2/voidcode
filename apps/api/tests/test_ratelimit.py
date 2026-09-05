"""Rate limiting, and the two ways it silently does nothing.

`/v1/auth/password-login` and `/register` accepted unlimited attempts: unlimited credential stuffing
against a real password database, unlimited account creation, each costing an argon2id hash.

Both failure modes here are silent — the endpoint works, the limit reports healthy, and nobody is
actually limited:

  * **Trusting the leftmost `X-Forwarded-For` entry.** That list is appended to by each proxy, so
    the left end is whatever the client typed. `xff.split(",")[0]` is the obvious reading and it
    hands the attacker a fresh bucket per request.
  * **Refreshing the TTL on every request.** Slides the window forward forever under load, so a
    locked-out legitimate user never recovers.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from src import config, ratelimit


class FakeRedis:
    """In-memory stand-in. Records whether EXPIRE was called more than once per key."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expire_calls: dict[str, int] = {}
        self.fail = False

    async def incr(self, key: str) -> int:
        if self.fail:
            raise ConnectionError("redis is down")
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key: str, seconds: int) -> None:
        self.expire_calls[key] = self.expire_calls.get(key, 0) + 1

    async def ttl(self, key: str) -> int:
        return 42


@pytest.fixture()
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr("src.redis_client.get_redis", lambda: fake)
    monkeypatch.setattr(config, "RATELIMIT_PEPPER", "test-pepper")
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 0)
    return fake


def ip_app() -> FastAPI:
    app = FastAPI()

    @app.get("/ip")
    def read_ip(request: Request):
        return {"ip": ratelimit.client_ip(request)}

    return app


# ── the X-Forwarded-For trap ─────────────────────────────────────────────────

def test_a_spoofed_forwarded_header_is_ignored_when_no_proxy_is_declared(redis, monkeypatch) -> None:
    """TRUSTED_PROXY_HOPS defaults to 0 — trust nothing, use the socket address."""
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 0)
    client = TestClient(ip_app())
    body = client.get("/ip", headers={"X-Forwarded-For": "1.2.3.4"}).json()
    assert body["ip"] != "1.2.3.4"


def test_the_client_controlled_end_of_the_chain_is_never_used(redis, monkeypatch) -> None:
    """THE bug. With one real proxy, the trustworthy entry is the last one it appended.

    An attacker sends `X-Forwarded-For: <anything>` and the proxy appends their true address, giving
    `<spoof>, <real>`. Taking [0] reads the spoof and hands out a fresh bucket every request.
    """
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 1)
    client = TestClient(ip_app())
    body = client.get("/ip", headers={"X-Forwarded-For": "9.9.9.9, 203.0.113.7"}).json()
    assert body["ip"] == "203.0.113.7"
    assert body["ip"] != "9.9.9.9", "the leftmost entry is attacker-controlled"


def test_two_declared_hops_counts_from_the_right(redis, monkeypatch) -> None:
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 2)
    client = TestClient(ip_app())
    body = client.get("/ip", headers={"X-Forwarded-For": "evil, 203.0.113.7, 10.0.0.1"}).json()
    assert body["ip"] == "203.0.113.7"


def test_a_chain_shorter_than_declared_falls_back_to_the_socket(redis, monkeypatch) -> None:
    """A short chain means the request did not come through the proxies we believed, so nothing in
    the header is trustworthy — including any address an attacker put there."""
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 2)
    client = TestClient(ip_app())
    body = client.get("/ip", headers={"X-Forwarded-For": "1.2.3.4"}).json()
    assert body["ip"] != "1.2.3.4"


# ── counting ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_quota_is_enforced_and_then_refused(redis) -> None:
    from fastapi import HTTPException

    limit = ratelimit.Limit(max_requests=3, window_seconds=60, name="t")
    for _ in range(3):
        await ratelimit.check(limit, "someone")           # must not raise

    with pytest.raises(HTTPException) as exc:
        await ratelimit.check(limit, "someone")
    assert exc.value.status_code == 429
    assert "Retry-After" in exc.value.headers


@pytest.mark.asyncio
async def test_the_window_is_not_slid_forward_on_every_request(redis) -> None:
    """EXPIRE only on the first hit. Refreshing it per request means a counter under sustained load
    never resets, so a legitimate user locked out once stays locked out indefinitely."""
    limit = ratelimit.Limit(max_requests=10, window_seconds=60, name="t")
    for _ in range(5):
        await ratelimit.check(limit, "someone")

    key = ratelimit.bucket_key(limit, "someone")
    assert redis.expire_calls[key] == 1


@pytest.mark.asyncio
async def test_separate_identifiers_do_not_share_a_bucket(redis) -> None:
    limit = ratelimit.Limit(max_requests=1, window_seconds=60, name="t")
    await ratelimit.check(limit, "alice")
    await ratelimit.check(limit, "bob")                   # must not raise


@pytest.mark.asyncio
async def test_two_limits_on_one_identifier_do_not_share_a_bucket(redis) -> None:
    """Otherwise a spent login quota would also block registration, and the 429 would be baffling."""
    a = ratelimit.Limit(max_requests=1, window_seconds=60, name="alpha")
    b = ratelimit.Limit(max_requests=1, window_seconds=60, name="beta")
    await ratelimit.check(a, "someone")
    await ratelimit.check(b, "someone")                   # must not raise


# ── the key never holds a plaintext address ──────────────────────────────────

def test_the_email_never_appears_in_the_redis_key(redis) -> None:
    """`config.py:73-76`: Redis is an unencrypted cache whose dumps have no retention guarantee. An
    unhashed key set is a plaintext list of every address anyone tried to sign in as."""
    key = ratelimit.bucket_key(ratelimit.LOGIN, "email:someone@example.com")
    assert "someone@example.com" not in key
    assert "example" not in key


def test_the_pepper_changes_the_key(redis, monkeypatch) -> None:
    """Without a pepper the hash is reversible by guessing common addresses."""
    first = ratelimit.bucket_key(ratelimit.LOGIN, "email:a@b.com")
    monkeypatch.setattr(config, "RATELIMIT_PEPPER", "a-different-pepper")
    assert ratelimit.bucket_key(ratelimit.LOGIN, "email:a@b.com") != first


# ── availability trade, stated rather than buried ────────────────────────────

@pytest.mark.asyncio
async def test_redis_being_down_allows_the_request(redis) -> None:
    """Fails OPEN on purpose. Failing closed would make a cache outage a total authentication
    outage. The cost is real and belongs in the risk register: an attacker who can take Redis down
    can bypass the limit, which is why the failure path logs at ERROR."""
    redis.fail = True
    await ratelimit.check(ratelimit.LOGIN, "someone")     # must not raise


# ── the endpoints are actually wired ─────────────────────────────────────────

def test_the_expensive_endpoints_all_call_a_limiter() -> None:
    """A limiter nothing calls is the state this replaced: RATELIMIT_PEPPER existed for months and
    was read by nothing."""
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src"
    expected = {
        "routers/auth.py": ["ratelimit.REGISTER", "ratelimit.LOGIN"],
        "routers/execution.py": ["ratelimit.EXECUTE"],
        "main.py": ["ratelimit.CHAT"],
    }
    for relative, limits in expected.items():
        source = (src / relative).read_text(encoding="utf-8")
        for limit in limits:
            assert limit in source, f"{relative} does not apply {limit}"
