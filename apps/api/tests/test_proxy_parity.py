"""The identity signature is implemented twice, in two languages. These tests keep them equal.

`apps/api/src/identity.py` verifies; `apps/web/src/app/api/proxy/[...path]/route.ts` produces. Both
compute `HMAC-SHA256(secret, userId + "\\n" + issuedAt)`, and nothing structural forces them to
agree — no shared schema, no generated code, different crypto libraries.

Two distinct failure modes, and only one of them is loud:

  * They **disagree** → every signed request 401s. Loud, and someone fixes it within a minute.
  * The proxy **forwards the client's own `X-User-Id`** → the forgery arrives carrying a valid
    signature, the backend trusts it, and every test of the signing logic still passes. Silent, and
    strictly worse than having no proxy at all.

The second is what `test_the_proxy_strips_client_supplied_identity_headers` is for. It reads the
route handler as source because `apps/web` has no JavaScript test runner — a weaker check than
executing it, but it catches the regression that matters.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from src import config, identity

ROUTE = (Path(__file__).resolve().parents[2] / "web" / "src" / "app" / "api" / "proxy"
         / "[...path]" / "route.ts")

SECRET = "parity-test-secret"
USER_ID = "11111111-1111-4111-a111-111111111111"
ISSUED_AT = 1700000000


# ── the two implementations must agree ───────────────────────────────────────

@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_the_node_and_python_signatures_are_identical(monkeypatch) -> None:
    """Fixed timestamp, so this is deterministic rather than a race against the clock."""
    monkeypatch.setattr(config, "INTERNAL_API_SECRET", SECRET)

    script = (
        "const { createHmac } = require('node:crypto');"
        f"const d = createHmac('sha256', {SECRET!r})"
        f".update({USER_ID!r} + '\\n' + {ISSUED_AT}).digest('hex');"
        f"process.stdout.write('{ISSUED_AT}.' + d);"
    )
    from_node = subprocess.run(["node", "-e", script], capture_output=True, text=True,
                               timeout=60, check=True).stdout.strip()

    assert identity.sign_identity(USER_ID, ISSUED_AT) == from_node


def test_the_route_signs_the_user_id_and_not_just_the_timestamp() -> None:
    """The id must be inside the HMAC message, or a signature can be lifted onto another user.

    `test_identity.py` proves the backend rejects that. This proves the producer never creates one:
    a proxy signing only the timestamp would mint tokens interchangeable between users.
    """
    source = ROUTE.read_text(encoding="utf-8")
    assert "${userId}\\n${issuedAt}" in source, (
        "the signed message no longer contains the user id — check signIdentity() in the proxy")


# ── the rule the proxy exists to enforce ─────────────────────────────────────

def test_the_proxy_strips_client_supplied_identity_headers() -> None:
    """Forwarding the caller's own X-User-Id and signing it would defeat the whole change."""
    source = ROUTE.read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("*")
                     and not line.strip().startswith("//"))

    for header in ('"x-user-id"', '"x-internal-auth"'):
        assert header in code, f"{header} is no longer in the proxy's STRIPPED set"

    # The id may only be set from the session-derived variable.
    assert 'headers.set("X-User-Id", userId)' in code
    assert 'request.headers.get("x-user-id")' not in code.lower().replace("'", '"'), (
        "the proxy reads the client's X-User-Id — it must come from the session only")


def test_the_secret_is_not_exposed_to_the_browser() -> None:
    """`NEXT_PUBLIC_` prefixed vars are inlined into the client bundle by Next.js.

    A `NEXT_PUBLIC_INTERNAL_API_SECRET` would ship the signing key to every visitor, at which point
    anyone can sign any identity and the backend check is decoration.
    """
    source = ROUTE.read_text(encoding="utf-8")
    assert "NEXT_PUBLIC_INTERNAL_API_SECRET" not in source
    assert "process.env.INTERNAL_API_SECRET" in source


def test_the_proxy_does_not_buffer_streaming_responses() -> None:
    """Two endpoints stream: the notification SSE feed and chat completions.

    `.json()` or `.text()` here would buffer both to completion — notifications would arrive in one
    batch when the connection closed, and the tutor would hang for the whole generation then dump
    its answer at once. Neither looks like a proxy bug from the outside.
    """
    source = ROUTE.read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("*")
                     and not line.strip().startswith("//"))
    assert "new Response(upstream.body" in code
    for buffering in ("upstream.json()", "upstream.text()", "await upstream.arrayBuffer()"):
        assert buffering not in code, f"{buffering} buffers the response and breaks streaming"


def test_the_browser_client_no_longer_sends_an_identity_header() -> None:
    """`makeHeaders` used to set X-User-Id from the session. The proxy makes that both pointless
    and misleading — a header that is stripped downstream reads as though it were trusted."""
    client = (Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "api" / "client.ts")
    source = client.read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines()
                     if not line.strip().startswith("*") and not line.strip().startswith("//"))
    assert 'headers["X-User-Id"]' not in code
    assert 'API_BASE = "/api/proxy"' in code, (
        "browser calls no longer go through the proxy — they would reach the API directly again")
