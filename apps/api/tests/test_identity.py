"""The `X-User-Id` trust problem, and the tests that decide whether it is actually fixed.

Nine routers derived identity from an unsigned client-supplied header, and `NEXT_PUBLIC_API_URL` is
public, so the browser reaches this API directly. `curl -H "X-User-Id: <someone-else>"` read and
wrote their chat history, drafts and profile.

The test that matters most is `test_a_signature_cannot_be_reused_for_a_different_user`: HMAC over a
timestamp alone would let a legitimate caller lift its own signature onto somebody else's id, and
that mistake produces working software indistinguishable from a correct implementation.
"""
from __future__ import annotations

import time

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from src import config, identity

ALICE = "11111111-1111-4111-a111-111111111111"
BOB = "22222222-2222-4222-a222-222222222222"
SECRET = "test-secret-not-a-real-one"


@pytest.fixture()
def client(monkeypatch):
    """A minimal app carrying the real dependency.

    Attributes are patched on the config MODULE rather than the environment: `identity` holds a
    reference to the module object, so reloading config would leave `identity.config` pointing at
    the old one and every test would silently exercise stale settings.
    """
    monkeypatch.setattr(config, "INTERNAL_API_SECRET", SECRET)
    monkeypatch.setattr(config, "INTERNAL_AUTH_ENFORCE", True)
    monkeypatch.setattr(identity, "_unverified_requests", 0)

    app = FastAPI()

    @app.get("/whoami")
    def whoami(caller: identity.Caller = Depends(identity.resolve_caller)):
        return {"user_id": str(caller.user_id), "verified": caller.verified}

    return TestClient(app)


def signed(user_id: str, issued_at: int | None = None) -> dict[str, str]:
    return {"X-User-Id": user_id, "X-Internal-Auth": identity.sign_identity(user_id, issued_at)}


# ── the attack the whole module exists to stop ───────────────────────────────

def test_a_forged_header_alone_is_rejected(client) -> None:
    """The exact `curl` that used to work."""
    response = client.get("/whoami", headers={"X-User-Id": ALICE})
    assert response.status_code == 401


def test_a_signature_cannot_be_reused_for_a_different_user(client) -> None:
    """The subtle version, and the one a timestamp-only HMAC would allow.

    Alice is a legitimate caller with a legitimate signature. If the signature covers only the
    timestamp, she can pair it with Bob's id and read his data — and everything still looks like a
    working authentication system.
    """
    alice_auth = identity.sign_identity(ALICE)
    response = client.get("/whoami", headers={"X-User-Id": BOB, "X-Internal-Auth": alice_auth})
    assert response.status_code == 401


def test_a_tampered_digest_is_rejected(client) -> None:
    issued_at, _, digest = identity.sign_identity(ALICE).partition(".")
    flipped = ("0" if digest[0] != "0" else "1") + digest[1:]
    response = client.get("/whoami",
                          headers={"X-User-Id": ALICE, "X-Internal-Auth": f"{issued_at}.{flipped}"})
    assert response.status_code == 401


def test_a_stale_signature_is_rejected(client) -> None:
    """Bounds how long a captured header stays useful."""
    old = int(time.time()) - identity.MAX_SIGNATURE_AGE_SECONDS - 5
    assert client.get("/whoami", headers=signed(ALICE, old)).status_code == 401


def test_a_future_dated_signature_is_rejected(client) -> None:
    """Symmetry matters: without it, a far-future timestamp never expires."""
    ahead = int(time.time()) + identity.MAX_SIGNATURE_AGE_SECONDS + 5
    assert client.get("/whoami", headers=signed(ALICE, ahead)).status_code == 401


def test_a_signature_from_the_wrong_secret_is_rejected(client, monkeypatch) -> None:
    header = identity.sign_identity(ALICE)
    monkeypatch.setattr(config, "INTERNAL_API_SECRET", "a-different-secret")
    response = client.get("/whoami", headers={"X-User-Id": ALICE, "X-Internal-Auth": header})
    assert response.status_code == 401


def test_no_secret_configured_verifies_nothing(client, monkeypatch) -> None:
    """Unconfigured must mean unauthenticated, not trusted.

    The inverse — treating an empty secret as "skip the check" — is the classic way a security
    control disappears in the environment that needs it most.
    """
    monkeypatch.setattr(config, "INTERNAL_API_SECRET", "")
    assert client.get("/whoami", headers={"X-User-Id": ALICE}).status_code == 401


# ── the legitimate paths still work ──────────────────────────────────────────

def test_a_correctly_signed_request_is_accepted(client) -> None:
    response = client.get("/whoami", headers=signed(ALICE))
    assert response.status_code == 200
    assert response.json() == {"user_id": ALICE, "verified": True}


def test_no_header_is_the_anonymous_visitor(client) -> None:
    """Unauthenticated browsing of the catalog must keep working."""
    body = client.get("/whoami").json()
    assert body["user_id"] == str(identity.ANONYMOUS_USER_ID)
    assert body["verified"] is True


def test_a_malformed_uuid_lands_on_anonymous_not_a_422(client) -> None:
    """Matches what all nine routers did. A garbled header is a bad request, not an attack."""
    body = client.get("/whoami", headers={"X-User-Id": "not-a-uuid"}).json()
    assert body["user_id"] == str(identity.ANONYMOUS_USER_ID)


# ── the two-phase rollout ────────────────────────────────────────────────────

def test_unenforced_mode_allows_but_marks_and_counts(client, monkeypatch) -> None:
    """Phase 1. The header must ship in the web app before this API starts rejecting, or sign-in
    breaks between two deploys — `config.py:63-67`. The count is the gate for flipping the flag."""
    monkeypatch.setattr(config, "INTERNAL_AUTH_ENFORCE", False)
    before = identity.unverified_request_count()

    body = client.get("/whoami", headers={"X-User-Id": ALICE}).json()

    assert body["user_id"] == ALICE
    assert body["verified"] is False, "an unsigned id must never be reported as verified"
    assert identity.unverified_request_count() == before + 1


def test_a_signed_request_is_not_counted_as_unverified(client, monkeypatch) -> None:
    """Otherwise the counter never reaches zero and the rollout gate never opens."""
    monkeypatch.setattr(config, "INTERNAL_AUTH_ENFORCE", False)
    before = identity.unverified_request_count()
    client.get("/whoami", headers=signed(ALICE))
    assert identity.unverified_request_count() == before


def test_the_anonymous_visitor_is_not_counted(client, monkeypatch) -> None:
    monkeypatch.setattr(config, "INTERNAL_AUTH_ENFORCE", False)
    before = identity.unverified_request_count()
    client.get("/whoami")
    assert identity.unverified_request_count() == before


# ── no router keeps its own copy ─────────────────────────────────────────────

def test_no_router_still_rolls_its_own_identity_helper() -> None:
    """Nine copies of the same six unsafe lines is how this survived review for months.

    A router that reintroduces one is not protected by anything above, and the failure is invisible:
    the endpoint works, for everybody, including for other people's data.
    """
    from pathlib import Path

    routers = Path(__file__).resolve().parents[1] / "src" / "routers"
    offenders = []
    for path in sorted(routers.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
        if "Header(default=None)" in code or "Header(None)" in code:
            if "x_user_id" in code:
                offenders.append(path.name)
    assert not offenders, (
        f"{offenders} read X-User-Id directly instead of using identity.current_user_id")
