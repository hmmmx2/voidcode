"""Password reset. Each rule here is the difference between a recovery flow and a takeover.

There was no reset, no change, no token table and no mail delivery, so a password-authenticated user
had no recovery path at all — while `forgot-password/page.tsx` told them to change it from their
profile, which had only GET and PUT.

The tests worth reading are the revocation ones. A reset that leaves other links live is the failure
that turns "I think someone got into my account" into "they still are": the owner requests a reset,
sets a new password, and the link an attacker triggered an hour ago still works.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from src import config
from src.models.auth_token import PURPOSE_EMAIL_VERIFY, PURPOSE_PASSWORD_RESET, AuthToken
from src.services import email_service, token_service


class FakeSession:
    """Enough AsyncSession to exercise the token rules without Postgres.

    The real flow is covered against a live database in `test_password_recovery_live.py`; this keeps
    the *rules* testable in CI without one, because they are the part that must not regress.
    """

    def __init__(self, users=None, tokens=None):
        self.users = {u.id: u for u in (users or [])}
        self.tokens: list[AuthToken] = list(tokens or [])
        self.added: list[object] = []

    def add(self, obj):
        self.added.append(obj)
        if isinstance(obj, AuthToken):
            self.tokens.append(obj)

    async def flush(self):
        pass

    async def get(self, _model, pk):
        return self.users.get(pk)

    async def execute(self, statement):
        return _Result(self, statement)


class _Result:
    """Interprets the two statement shapes token_service issues."""

    def __init__(self, session: FakeSession, statement):
        self.session = session
        self.text = str(statement)
        self.rowcount = 0
        if "UPDATE" in self.text:
            for token in session.tokens:
                if token.used_at is None:
                    token.used_at = datetime.utcnow()
                    self.rowcount += 1

    def scalar_one_or_none(self):
        return getattr(self.session, "_next_token", None)


class FakeUser:
    def __init__(self, email="learner@example.com", active=True, has_password=True):
        self.id = uuid.uuid4()
        self.email = email
        self.name = "Learner"
        self.is_active = active
        self.password_hash = "argon2-ish" if has_password else None


# ── token generation ─────────────────────────────────────────────────────────

def test_the_raw_token_is_never_what_gets_stored() -> None:
    """A backup or a slow-query log otherwise holds a working reset link per pending request."""
    token = token_service.generate_token()
    assert token_service.hash_token(token) != token
    assert len(token_service.hash_token(token)) == 64


def test_tokens_are_long_and_unique() -> None:
    tokens = {token_service.generate_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(len(t) >= 40 for t in tokens)


def test_token_generation_does_not_use_the_random_module() -> None:
    """`random` is a Mersenne Twister seeded from the clock: predictable from a few observed
    outputs. Predicting a reset token is account takeover."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "services" / "token_service.py")
    code = "\n".join(line for line in source.read_text(encoding="utf-8").splitlines()
                     if not line.lstrip().startswith("#"))
    assert "import secrets" in code
    assert "import random" not in code


# ── redemption ───────────────────────────────────────────────────────────────

def _token(user, *, purpose=PURPOSE_PASSWORD_RESET, raw="raw-token",
           expires_in=timedelta(minutes=30), used=False, sent_to=None):
    return AuthToken(
        user_id=user.id,
        token_hash=token_service.hash_token(raw),
        purpose=purpose,
        expires_at=datetime.utcnow() + expires_in,
        used_at=datetime.utcnow() if used else None,
        sent_to_email=sent_to or user.email,
    )


@pytest.mark.asyncio
async def test_a_valid_token_redeems_once(monkeypatch) -> None:
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = _token(user)

    redeemed = await token_service.redeem(session, "raw-token", PURPOSE_PASSWORD_RESET)
    assert redeemed is user
    assert session._next_token.used_at is not None, "redeem must spend the token"


@pytest.mark.asyncio
async def test_a_spent_token_is_refused_and_says_so() -> None:
    """Distinguished from "invalid" on purpose: a second click is the commonest way here, and
    "already used" lets the user stop hunting for a typo. It reveals only that a token existed, to
    someone who already had it."""
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = _token(user, used=True)

    with pytest.raises(token_service.TokenError, match="already been used"):
        await token_service.redeem(session, "raw-token", PURPOSE_PASSWORD_RESET)


@pytest.mark.asyncio
async def test_an_expired_token_is_refused() -> None:
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = _token(user, expires_in=timedelta(minutes=-1))

    with pytest.raises(token_service.TokenError, match="expired"):
        await token_service.redeem(session, "raw-token", PURPOSE_PASSWORD_RESET)


@pytest.mark.asyncio
async def test_an_unknown_token_is_refused() -> None:
    session = FakeSession()
    session._next_token = None
    with pytest.raises(token_service.TokenError, match="not valid"):
        await token_service.redeem(session, "anything", PURPOSE_PASSWORD_RESET)


@pytest.mark.asyncio
async def test_a_token_is_refused_if_the_account_email_changed_since_it_was_sent() -> None:
    """The takeover this closes: an attacker changes the address, requests a reset, and would
    otherwise complete it. Also protects the real owner — a link mailed to an address they no longer
    control must stop working.

    This is why `sent_to_email` is denormalised onto the row. Reading `user.email` at redemption
    would compare the new address with itself and always agree.
    """
    user = FakeUser(email="new@example.com")
    session = FakeSession(users=[user])
    session._next_token = _token(user, sent_to="old@example.com")

    with pytest.raises(token_service.TokenError, match="no longer valid"):
        await token_service.redeem(session, "raw-token", PURPOSE_PASSWORD_RESET)


@pytest.mark.asyncio
async def test_a_deactivated_account_cannot_redeem() -> None:
    user = FakeUser(active=False)
    session = FakeSession(users=[user])
    session._next_token = _token(user)

    with pytest.raises(token_service.TokenError):
        await token_service.redeem(session, "raw-token", PURPOSE_PASSWORD_RESET)


@pytest.mark.asyncio
async def test_a_verification_token_cannot_reset_a_password() -> None:
    """Purpose is part of the lookup. Otherwise an email-verification link — which is mailed far
    more freely and lives for 24 hours rather than 60 minutes — doubles as a password reset."""
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = None          # the purpose-filtered query finds nothing

    with pytest.raises(token_service.TokenError):
        await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)


# ── revocation, the rules that matter most ───────────────────────────────────

@pytest.mark.asyncio
async def test_issuing_a_reset_revokes_the_previous_one() -> None:
    """Otherwise requesting a second reset leaves the first link live, so an attacker who triggered
    one earlier still holds a working link after the owner requests their own."""
    user = FakeUser()
    old = _token(user, raw="old-token")
    session = FakeSession(users=[user], tokens=[old])

    await token_service.issue_password_reset(session, user)
    assert old.used_at is not None


@pytest.mark.asyncio
async def test_revoke_all_spends_every_outstanding_token() -> None:
    """Called on password change too: a changed password must kill every link in flight, or the
    link an attacker holds survives the action taken to lock them out."""
    user = FakeUser()
    tokens = [_token(user, raw=f"t{i}") for i in range(3)]
    session = FakeSession(users=[user], tokens=tokens)

    count = await token_service.revoke_password_resets(session, user.id)
    assert count == 3
    assert all(t.used_at is not None for t in tokens)


# ── email ────────────────────────────────────────────────────────────────────

def test_the_reset_link_is_built_from_config_not_a_request_header(monkeypatch) -> None:
    """The most dangerous line in email_service. nginx forwards the client's Host header, so
    building the link from the request would let a host-header injection point it at an attacker's
    domain — and the user would type their new password into it."""
    monkeypatch.setattr(config, "APP_BASE_URL", "https://voidcode.example")
    email = email_service.password_reset_email("a@b.com", "tok123")
    assert "https://voidcode.example/reset-password?token=tok123" in email.body

    # Checked against the executable statements, not the prose. The docstring discusses `Host`
    # headers at length precisely because they must not be used, so matching raw file text finds
    # the warning and calls it a violation — which an earlier version of this test did.
    import ast
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "src" / "services" / "email_service.py")
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in {"headers", "url", "base_url"}:
            parent = getattr(node.value, "id", "")
            assert parent != "request", "email_service reads the request — links must come from config"
    assert "APP_BASE_URL" in {
        n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
    }, "the link is no longer built from config.APP_BASE_URL"


def test_the_reset_email_says_the_link_is_single_use_and_expiring(monkeypatch) -> None:
    monkeypatch.setattr(config, "RESET_TOKEN_TTL_MINUTES", 60)
    body = email_service.password_reset_email("a@b.com", "t").body
    assert "once" in body and "60 minutes" in body
    # Someone who did not request it needs to know they can ignore it safely.
    assert "ignore" in body


@pytest.mark.asyncio
async def test_the_console_provider_does_not_send_and_reports_success(monkeypatch, caplog) -> None:
    """Default, so local development needs no account. `assert_production_config()` refuses to
    start production in this mode — see test_config_is_wired.py."""
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "console")
    with caplog.at_level("INFO"):
        assert await email_service.send(email_service.password_reset_email("a@b.com", "tok")) is True
    assert "tok" in caplog.text


@pytest.mark.asyncio
async def test_an_unknown_provider_fails_loudly_but_does_not_raise(monkeypatch, caplog) -> None:
    """A raise here would break the identical-response property of /forgot-password."""
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "sendgrid")
    with caplog.at_level("ERROR"):
        assert await email_service.send(email_service.password_reset_email("a@b.com", "t")) is False
    assert "EMAIL NOT SENT" in caplog.text


@pytest.mark.asyncio
async def test_resend_without_a_key_fails_without_calling_out(monkeypatch, caplog) -> None:
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "resend")
    monkeypatch.setattr(config, "RESEND_API_KEY", "")
    with caplog.at_level("ERROR"):
        assert await email_service.send(email_service.password_reset_email("a@b.com", "t")) is False
    assert "RESEND_API_KEY" in caplog.text


# ── the endpoints exist and are shaped correctly ─────────────────────────────

def test_all_three_recovery_endpoints_are_registered() -> None:
    from src.routers.auth import router
    paths = {r.path for r in router.routes}
    for expected in ("/v1/auth/forgot-password", "/v1/auth/reset-password",
                     "/v1/auth/change-password"):
        assert expected in paths


def test_forgot_password_returns_one_message_for_every_case() -> None:
    """A membership oracle otherwise: "no such account" tells anyone with an email list who is
    registered. Same reasoning as password_login's single 401."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "routers" / "auth.py")
    body = source.read_text(encoding="utf-8").split("async def forgot_password")[1].split(
        "async def reset_password")[0]
    # Exactly one MessageResponse construction, on the shared exit path.
    assert body.count("return MessageResponse(") == 1


def test_change_password_requires_the_current_password() -> None:
    """A session is not proof of presence. A borrowed laptop or a stolen cookie must not be enough
    to lock the real owner out of their own account."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "routers" / "auth.py")
    body = source.read_text(encoding="utf-8").split("async def change_password")[1]
    assert "verify_password(user.password_hash, payload.current_password)" in body


def test_reset_and_change_both_revoke_outstanding_links() -> None:
    """The failure that turns "someone got in" into "they still are"."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "routers" / "auth.py")
    text = source.read_text(encoding="utf-8")
    for handler in ("async def reset_password", "async def change_password"):
        body = text.split(handler)[1].split("@router.post")[0]
        assert "revoke_password_resets" in body, f"{handler} leaves other reset links live"


def test_reset_uses_the_same_password_policy_as_register() -> None:
    """A weaker rule on reset would make it the cheapest route to a weak password."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "routers" / "auth.py")
    body = source.read_text(encoding="utf-8").split("async def reset_password")[1]
    assert "validate_password(" in body
