"""The website's auth surface is gone, and must stay gone.

Sign-in moved into the desktop application. Five endpoints and one identity mechanism were removed
with the website's server-side proxy, and each of them was a way to be somebody without proving it:

  * `POST /v1/auth/login` — find-or-create by email, UNAUTHENTICATED. It existed so the website's
    NextAuth server could turn a Google profile into a user row. Anyone who could reach the API
    could mint or take over an account by naming an address.
  * `POST /v1/auth/register` and `POST /v1/auth/password-login` — the web-shaped pair, answering
    with a user row and no session because the website minted its own cookie.
  * `POST /v1/auth/forgot-password` and `POST /v1/auth/reset-password` — reset by emailed LINK,
    redeemable only by a web page that collects a new password. There is no such page now, and the
    desktop app uses a 6-digit code redeemed inside the app that asked for it.
  * `X-User-Id` + `X-Internal-Auth` — an id in a header, trusted either outright or via an HMAC
    with a secret shared with the proxy. A secret that authenticates a server cannot be shipped
    inside an installable application, which is why the desktop app got per-device session tokens.

THIS FILE REPLACES `test_identity.py` AND `test_billing_requires_real_identity.py`. Both tested the
mechanism above in detail — signature reuse, the two-phase rollout flag, the counter of unsigned
requests. Those tests passed because the mechanism worked; they are deleted because the mechanism is
deleted, and what has to be guarded now is the absence. The behavioural half below is the important
half: a source scan alone would pass if a header path came back somewhere new.
"""

from __future__ import annotations

import ast
import importlib
import uuid
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from src import config, identity

SRC = Path(__file__).resolve().parents[1] / "src"
ALICE = "11111111-1111-4111-a111-111111111111"


@pytest.fixture()
def client():
    """A minimal app carrying the real dependency, so this measures behaviour and not source."""
    app = FastAPI()

    @app.get("/whoami")
    def whoami(caller: identity.Caller = Depends(identity.resolve_caller)):
        return {"user_id": str(caller.user_id), "anonymous": caller.is_anonymous}

    return TestClient(app)


# ── the behaviour: one credential, and it is a bearer token ─────────────────


def test_an_unsigned_user_id_header_is_ignored_entirely(client) -> None:
    """THE test in this file. The header used to name the caller; now it names nobody.

    A source check cannot replace this: the header could be read again by a new dependency, a
    middleware, or a router that rolls its own helper, and only a request proves it is not.
    """
    response = client.get("/whoami", headers={"X-User-Id": ALICE})

    assert response.status_code == 200
    body = response.json()
    assert body["anonymous"] is True, "an unsigned X-User-Id header still names a caller"
    assert body["user_id"] != ALICE


def test_a_signed_looking_header_pair_is_ignored_too(client) -> None:
    """There is no verifier left, so a plausible signature must not buy anything either."""
    response = client.get(
        "/whoami",
        headers={"X-User-Id": ALICE, "X-Internal-Auth": "1700000000.deadbeef" * 2},
    )

    assert response.json()["anonymous"] is True


def test_no_credential_is_the_anonymous_user(client) -> None:
    body = client.get("/whoami").json()
    assert body["anonymous"] is True
    assert body["user_id"] == str(identity.ANONYMOUS_USER_ID)


def test_a_bearer_token_that_does_not_resolve_is_a_401(client) -> None:
    """Not anonymous: the client sent a credential and it is not good.

    Falling through to anonymous would silently downgrade a signed-out desktop app into a free
    anonymous one, which is how a revoked session keeps working.
    """
    response = client.get("/whoami", headers={"Authorization": "Bearer not-a-real-session"})
    assert response.status_code == 401


# ── the absence, in the source ──────────────────────────────────────────────


def _routes() -> set[str]:
    """Every path registered by a decorator in the auth router, read from the AST.

    The AST rather than importing the app: the router imports the world, and a route that is
    registered conditionally should still count as registered.
    """
    tree = ast.parse((SRC / "routers/auth.py").read_text(encoding="utf-8"))
    paths: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)):
            continue
        if func.value.id != "router":
            continue
        for arg in [*node.args, *(kw.value for kw in node.keywords)]:
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value.startswith("/"):
                paths.add(arg.value)
    return paths


@pytest.mark.parametrize(
    "path",
    ["/login", "/register", "/password-login", "/forgot-password", "/reset-password"],
)
def test_the_browser_endpoints_are_not_registered(path: str) -> None:
    assert path not in _routes(), (
        f"{path} is back. It served the website's NextAuth server; see this module's header for "
        "what it let a caller do."
    )


def test_the_auth_router_actually_imports() -> None:
    """The AST tests above pass on a module that cannot be imported, and that is not theoretical.

    Deleting the web endpoints took `PasswordLoginRequest` with them — a model `/desktop/session`
    still referenced — so `routers/auth.py` raised `NameError` at import. Every AST assertion in
    this file was green, because a name that does not resolve is still a syntactically valid
    annotation. Importing is the check that catches it.
    """
    from src.routers import auth as auth_router

    paths = {route.path for route in auth_router.router.routes}
    assert "/v1/auth/desktop/session" in paths
    for gone in ("/v1/auth/login", "/v1/auth/password-login", "/v1/auth/forgot-password"):
        assert gone not in paths


def test_the_desktop_endpoints_are_all_still_there() -> None:
    """The other direction, so "remove the web endpoints" cannot quietly remove too much."""
    assert {
        "/desktop/register",
        "/desktop/session",
        "/desktop/sessions",
        "/password-reset/request",
        "/password-reset/confirm",
        "/change-password",
        "/me",
    } <= _routes()


def test_the_provider_fields_are_gone_from_the_wire() -> None:
    """`password_cleared` and `providers` cannot come back, in either direction.

    Both were meaningful only while an account could have a provider attached. `password_cleared`
    meant "linking a provider removed a password set on this address without the address ever being
    proven"; `providers` was a list built by selecting from `user_identities`, a table this build
    drops. Left on the response models they would be permanently empty — a field that looks like a
    control and reports nothing, which `test_the_proxy_only_settings_are_gone` below is the
    precedent for refusing.

    ASSERTED ON THE MODEL FIELDS, not by scanning the text. A source scan would be satisfied by this
    test's own docstring naming them, and the whole point is what the API sends.
    """
    from src.routers import auth as auth_router

    assert "password_cleared" not in auth_router.DesktopSessionResponse.model_fields
    assert "providers" not in auth_router.AccountResponse.model_fields

    # And the fields that carry weight are still there, so "remove the provider fields" cannot
    # quietly remove the ones a signed-in desktop actually reads.
    assert {"token", "expires_at", "user", "created"} <= set(
        auth_router.DesktopSessionResponse.model_fields
    )
    assert {"id", "email", "name", "has_password", "email_verified", "created_at"} <= set(
        auth_router.AccountResponse.model_fields
    )


def test_the_provider_endpoint_did_not_come_back() -> None:
    """`/desktop/oauth/{provider}` was in the list above until Google and Microsoft sign-in went.

    It is asserted ABSENT rather than simply dropped from that set, because a deletion leaves nothing
    behind to notice a return. `services/oidc.py` and `services/account_linking.py` are gone and so
    is the `user_identities` table the handler wrote to, so re-registering this route would not fail
    at import — it would fail at request time, for a person trying to sign in, which is the worst
    place to find out.
    """
    assert "/desktop/oauth/{provider}" not in _routes()


def test_identity_has_no_signing_machinery_left() -> None:
    tree = ast.parse((SRC / "identity.py").read_text(encoding="utf-8"))
    names = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    for gone in ("sign_identity", "_signature_is_valid", "unverified_request_count"):
        assert gone not in names, f"identity.py defines {gone} again"

    resolve = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "resolve_caller"
    )
    args = {arg.arg for arg in resolve.args.args}
    assert args == {"request", "authorization"}, f"resolve_caller takes {sorted(args)}"


def test_the_proxy_only_settings_are_gone() -> None:
    """A knob nothing reads is worse than no knob: it looks like a control.

    `ENABLE_PASSWORD_AUTH` was exactly that even before this change — documented as the master
    switch for the password surface and read by nothing.
    """
    for gone in ("INTERNAL_API_SECRET", "INTERNAL_AUTH_ENFORCE", "ENABLE_PASSWORD_AUTH"):
        assert not hasattr(config, gone), f"config still defines {gone}"


def test_cors_does_not_advertise_an_identity_header() -> None:
    """Listing a header no browser should send advertises that trying is worthwhile."""
    for env in ("development", "production"):
        settings = importlib.import_module("src.config").cors_settings()
        assert "X-User-Id" not in settings["allow_headers"]
        assert "X-Internal-Auth" not in settings["allow_headers"]
        del env  # the settings are read from the imported module either way


def test_no_router_rolls_its_own_identity_helper() -> None:
    """Carried over from `test_identity.py`, where it was the most durable test in the file.

    Nine routers each had a `_get_user_id` that read the header directly. One shared dependency is
    the only way the rule above can hold — a private copy re-opens it in one file at a time.
    """
    offenders: list[str] = []
    for path in sorted((SRC / "routers").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and "user_id" in node.name:
                if node.name not in {"current_user_id", "require_user"}:
                    offenders.append(f"{path.name}:{node.name}")
    assert offenders == [], f"routers defining their own identity helper: {offenders}"


def test_metering_refuses_the_shared_anonymous_identity() -> None:
    """Read from source: `main.py` imports torch, so tests may never import it.

    The gate used to need two conditions — not anonymous, and signed. Only the first is left, and
    it is the one that stops a wallet being created for the one identity every signed-out caller
    shares.
    """
    source = (SRC / "main.py").read_text(encoding="utf-8")
    gate = next(
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_begin_metering"
    )
    # Statements only, with the docstring dropped: that docstring explains that `caller.verified`
    # was removed, so a scan of the text would trip on its own explanation.
    statements = [n for n in gate.body if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))]
    code = chr(10).join(ast.get_source_segment(source, n) or "" for n in statements)
    assert "is_anonymous" in code, "metering no longer excludes the anonymous identity"
    assert "caller.verified" not in code, "the removed `verified` field is being read again"


def test_an_anonymous_caller_cannot_be_a_real_user() -> None:
    """The invariant the gate above depends on, stated once."""
    assert identity.Caller(user_id=identity.ANONYMOUS_USER_ID).is_anonymous is True
    assert identity.Caller(user_id=uuid.uuid4()).is_anonymous is False
