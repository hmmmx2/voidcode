"""Single-use emailed tokens, and changing a password while signed in.

Each rule here is the difference between a recovery flow and a takeover. The tests worth reading are
the revocation ones: a flow that leaves other tokens live is the failure that turns "I think someone
got into my account" into "they still are".

THIS FILE USED TO BE ABOUT RESET-BY-LINK, which went with the website. A link is redeemable only by
a web page that collects a new password, and there is no such page now — the desktop app uses a
6-digit code redeemed inside the app that asked for it (`test_desktop_accounts_postgres.py` covers
that flow end to end, and `test_web_auth_is_gone.py` holds the endpoints gone).

What remains here is the machinery both flows share, exercised through the one single-use LINK
purpose left — email verification — plus the change-password rule. `token_service.redeem`, its
purpose filter, its single-use semantics and its revocation are the same code either way.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from src import config
from src.models.auth_token import PURPOSE_DESKTOP_SESSION, PURPOSE_EMAIL_VERIFY, AuthToken
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

def _token(user, *, purpose=PURPOSE_EMAIL_VERIFY, raw="raw-token",
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

    redeemed = await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)
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
        await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)


@pytest.mark.asyncio
async def test_an_expired_token_is_refused() -> None:
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = _token(user, expires_in=timedelta(minutes=-1))

    with pytest.raises(token_service.TokenError, match="expired"):
        await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)


@pytest.mark.asyncio
async def test_an_unknown_token_is_refused() -> None:
    session = FakeSession()
    session._next_token = None
    with pytest.raises(token_service.TokenError, match="not valid"):
        await token_service.redeem(session, "anything", PURPOSE_EMAIL_VERIFY)


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
        await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)


@pytest.mark.asyncio
async def test_a_deactivated_account_cannot_redeem() -> None:
    user = FakeUser(active=False)
    session = FakeSession(users=[user])
    session._next_token = _token(user)

    with pytest.raises(token_service.TokenError):
        await token_service.redeem(session, "raw-token", PURPOSE_EMAIL_VERIFY)


@pytest.mark.asyncio
async def test_a_token_cannot_be_redeemed_for_another_purpose() -> None:
    """Purpose is part of the lookup. Otherwise a token mailed for one thing authorises another —
    a verification link, which is sent far more freely, standing in for a credential."""
    user = FakeUser()
    session = FakeSession(users=[user])
    session._next_token = None          # the purpose-filtered query finds nothing

    with pytest.raises(token_service.TokenError):
        await token_service.redeem(session, "raw-token", PURPOSE_DESKTOP_SESSION)


# ── revocation, the rules that matter most ───────────────────────────────────

@pytest.mark.asyncio
async def test_issuing_a_token_revokes_the_previous_one() -> None:
    """Otherwise requesting a second one leaves the first live, so an attacker who triggered one
    earlier still holds something that works after the owner requests their own."""
    user = FakeUser()
    old = _token(user, raw="old-token")
    session = FakeSession(users=[user], tokens=[old])

    await token_service.issue_email_verification(session, user)
    assert old.used_at is not None


@pytest.mark.asyncio
async def test_revoke_all_spends_every_outstanding_token() -> None:
    """Called on password change too: a changed password must kill every link in flight, or the
    link an attacker holds survives the action taken to lock them out."""
    user = FakeUser()
    tokens = [_token(user, raw=f"t{i}") for i in range(3)]
    session = FakeSession(users=[user], tokens=tokens)

    count = await token_service.revoke_all(session, user.id, PURPOSE_EMAIL_VERIFY)
    assert count == 3
    assert all(t.used_at is not None for t in tokens)


# ── email ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_console_provider_does_not_send_and_reports_success(monkeypatch, caplog) -> None:
    """Default, so local development needs no account. `assert_production_config()` refuses to
    start production in this mode — see test_config_is_wired.py."""
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "console")
    with caplog.at_level("INFO"):
        assert await email_service.send(email_service.password_reset_code_email("a@b.com", "123456")) is True
    assert "123456" in caplog.text


@pytest.mark.asyncio
async def test_an_unknown_provider_fails_loudly_but_does_not_raise(monkeypatch, caplog) -> None:
    """A raise here would break the identical-response property of /forgot-password."""
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "sendgrid")
    with caplog.at_level("ERROR"):
        assert await email_service.send(email_service.password_reset_code_email("a@b.com", "123456")) is False
    assert "EMAIL NOT SENT" in caplog.text


@pytest.mark.asyncio
async def test_resend_without_a_key_fails_without_calling_out(monkeypatch, caplog) -> None:
    monkeypatch.setattr(config, "EMAIL_PROVIDER", "resend")
    monkeypatch.setattr(config, "RESEND_API_KEY", "")
    with caplog.at_level("ERROR"):
        assert await email_service.send(email_service.password_reset_code_email("a@b.com", "123456")) is False
    assert "RESEND_API_KEY" in caplog.text


# ── the endpoints exist and are shaped correctly ─────────────────────────────

def test_change_password_requires_the_current_password() -> None:
    """A session is not proof of presence. A borrowed laptop or a stolen cookie must not be enough
    to lock the real owner out of their own account."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "src" / "routers" / "auth.py")
    body = source.read_text(encoding="utf-8").split("async def change_password")[1]
    assert "verify_password(user.password_hash, payload.current_password)" in body
