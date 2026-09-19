"""Issue, redeem and revoke single-use auth tokens.

The rules here are the difference between a password reset and an account takeover, so each one has
its reason next to it rather than in a commit message.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config
from ..models.auth_token import (
    PURPOSE_DESKTOP_SESSION,
    PURPOSE_EMAIL_VERIFY,
    PURPOSE_PASSWORD_RESET_CODE,
    AuthToken,
)
from ..models.user import User

logger = logging.getLogger(__name__)

#: 32 bytes from the OS CSPRNG. `secrets`, not `random` — `random` is a Mersenne Twister seeded from
#: the clock, so its output is predictable from a handful of observed values, and predicting a reset
#: token is account takeover.
TOKEN_BYTES = 32


def generate_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """SHA-256 hex. See `models/auth_token.py` for why this is not argon2id."""
    return hashlib.sha256(token.encode()).hexdigest()


async def issue(
    session: AsyncSession, user: User, purpose: str, *, revoke_existing: bool = True
) -> str:
    """Create a token for `user` and return the RAW value, which is never stored.

    Existing unspent tokens for the same purpose are revoked first. Otherwise requesting a second
    reset leaves the first link live, so an attacker who triggered a reset an hour ago still holds a
    working link after the real owner requests their own.

    `revoke_existing=False` is for the one purpose where that reasoning inverts. A desktop session
    is a credential a person holds on a machine, not a link sent to their inbox: revoking on issue
    would mean signing in on a laptop silently signed them out of their desktop, which reads as a
    bug rather than as security. The reset and verification flows keep the old behaviour.
    """
    if revoke_existing:
        await revoke_all(session, user.id, purpose)

    token = generate_token()
    if purpose == PURPOSE_DESKTOP_SESSION:
        ttl = timedelta(days=config.DESKTOP_SESSION_TTL_DAYS)
    else:
        ttl = timedelta(hours=config.VERIFY_TOKEN_TTL_HOURS)

    session.add(AuthToken(
        user_id=user.id,
        token_hash=hash_token(token),
        purpose=purpose,
        expires_at=datetime.utcnow() + ttl,
        # Snapshot of where it was sent — see the model docstring on why this is denormalised.
        sent_to_email=user.email,
    ))
    await session.flush()
    return token


class TokenError(Exception):
    """Why a token was refused. The message is safe to show a user."""


async def redeem(session: AsyncSession, token: str, purpose: str) -> User:
    """Consume `token` and return its user, or raise `TokenError`.

    Marks the row spent BEFORE the caller changes anything. A caller that updated the password first
    and consumed the token afterwards leaves a window where two concurrent requests both redeem the
    same link.
    """
    row = (await session.execute(
        select(AuthToken).where(
            AuthToken.token_hash == hash_token(token),
            AuthToken.purpose == purpose,
        )
    )).scalar_one_or_none()

    if row is None:
        # Same message for "never existed" and "wrong purpose". Distinguishing them tells an
        # attacker probing tokens which guesses were closer.
        raise TokenError("This link is not valid. Request a new one.")

    if row.is_spent:
        # Distinguishable from invalid ON PURPOSE. A second click on a link you already used is the
        # commonest way to reach this, and "already used" lets the user stop looking for a typo.
        # It leaks only that a token existed, to someone who already had it.
        raise TokenError("This link has already been used. Request a new one.")

    if row.is_expired():
        raise TokenError("This link has expired. Request a new one.")

    user = await session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise TokenError("This link is not valid. Request a new one.")

    if user.email.strip().lower() != row.sent_to_email.strip().lower():
        # The account's address changed after the link was mailed. If the change was made by an
        # attacker who then requested a reset, honouring this would complete the takeover; if the
        # real owner changed it, a link sent to their old provider should not still work.
        logger.warning("token for user %s was sent to a since-changed address", user.id)
        raise TokenError("This link is no longer valid. Request a new one.")

    row.used_at = datetime.utcnow()
    await session.flush()
    return user


async def revoke_all(session: AsyncSession, user_id, purpose: str) -> int:
    """Spend every outstanding token of `purpose` for this user. Returns how many.

    Called on password change as well as on issue. A changed password must kill every reset link in
    flight — otherwise a link an attacker obtained earlier survives the very action taken to lock
    them out, which is the opposite of what changing a password is for.
    """
    result = await session.execute(
        update(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.used_at.is_(None),
        )
        .values(used_at=datetime.utcnow())
    )
    return result.rowcount or 0


# `issue_email_verification` STOOD HERE. Its only caller was a test that wanted `issue`'s
# revoke-the-previous-one behaviour and reached for the nearest wrapper; the email it existed to
# accompany was never sent by anything. That test now calls `issue` with the purpose directly, which
# is what it was actually testing.
#
# `PURPOSE_EMAIL_VERIFY` itself stays: it is a value in `auth_token.py`, and the suites use it as a
# representative non-session purpose.


async def issue_desktop_session(session: AsyncSession, user: User) -> str:
    """A long-lived credential for a signed-in desktop client. Does not revoke other devices."""
    return await issue(session, user, PURPOSE_DESKTOP_SESSION, revoke_existing=False)


async def user_id_for_session(session: AsyncSession, token: str) -> uuid.UUID | None:
    """Who this desktop session belongs to, or None. DOES NOT CONSUME THE TOKEN.

    `redeem()` next door marks a token spent, which is right for a link that may be used once and
    catastrophic for a credential presented on every request -- the first API call would sign the
    person out.

    Returns None for every refusal rather than raising or distinguishing them. A client holding a
    token that has expired, been revoked, or never existed does the same thing in all three cases:
    sign in again. Telling them which would only help somebody probing tokens.

    A DEACTIVATED ACCOUNT'S SESSIONS STOP WORKING HERE, not only at sign-in. Before this join,
    `is_active` was checked when a session was issued and never again, so switching an account off
    stopped new sign-ins and left every device already signed in fully working for up to 90 days —
    which is the opposite of what deactivating an account is for. Joined rather than looked up
    separately so it stays one indexed query on a path every authenticated request takes.
    """
    row = (
        await session.execute(
            select(AuthToken)
            .join(User, User.id == AuthToken.user_id)
            .where(
                AuthToken.token_hash == hash_token(token),
                AuthToken.purpose == PURPOSE_DESKTOP_SESSION,
                User.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()

    if row is None or row.is_spent or row.is_expired():
        return None
    return row.user_id


async def revoke_desktop_session(session: AsyncSession, token: str) -> bool:
    """Sign out this one device. True when a live session was ended.

    Scoped to the presented token rather than to the user, so signing out on a laptop does not sign
    the person out of their desktop -- the mirror of why issuing does not revoke.
    """
    result = await session.execute(
        update(AuthToken)
        .where(
            AuthToken.token_hash == hash_token(token),
            AuthToken.purpose == PURPOSE_DESKTOP_SESSION,
            AuthToken.used_at.is_(None),
        )
        .values(used_at=datetime.utcnow())
    )
    return (result.rowcount or 0) > 0


async def revoke_desktop_sessions(
    session: AsyncSession, user_id, *, except_hash: str | None = None
) -> int:
    """Sign a person out of every device, optionally keeping the one making the request.

    Used when a password is reset or changed, and for "sign out everywhere". Before this, neither a
    reset nor a change touched desktop sessions: a person who reset their password because a laptop
    was stolen left that laptop signed in for the rest of its 90 days.

    `except_hash` keeps the caller's own session when they changed the password themselves — making
    them sign straight back in on the device they just proved they control reads as a bug.
    """
    conditions = [
        AuthToken.user_id == user_id,
        AuthToken.purpose == PURPOSE_DESKTOP_SESSION,
        AuthToken.used_at.is_(None),
    ]
    if except_hash is not None:
        conditions.append(AuthToken.token_hash != except_hash)
    result = await session.execute(
        update(AuthToken).where(*conditions).values(used_at=datetime.utcnow())
    )
    return result.rowcount or 0


# ── Password reset by six-digit code ─────────────────────────────────────────


def reset_code_hash(row_id: uuid.UUID, code: str) -> str:
    """HMAC-SHA256 of the code, keyed with a server secret and bound to its own row.

    NOT `hash_token`. A plain SHA-256 is right for a 32-byte link, where there is nothing to guess; a
    six-digit code has one million values, so a leaked `auth_tokens` table would give up every
    outstanding code by trying them all. The key lives in config, not in the database.

    Bound to the ROW id rather than the user id because `ix_auth_tokens_hash` is unique across every
    token ever issued and spent rows are kept: keyed by user, the same person drawing the same code
    twice would collide with their own revoked row and fail the insert.
    """
    return hmac.new(
        config.AUTH_CODE_SECRET.encode(), f"{row_id}:{code}".encode(), hashlib.sha256
    ).hexdigest()


async def issue_reset_code(session: AsyncSession, user: User) -> str:
    """Create a six-digit code for `user`, revoking any earlier one. Returns the code; never stored.

    `secrets.randbelow`, zero-padded — `random` would make the next code predictable from a few
    observed ones, and an unpadded number would make codes below 100000 shorter and easier to guess.
    """
    await revoke_all(session, user.id, PURPOSE_PASSWORD_RESET_CODE)

    code = f"{secrets.randbelow(10**6):06d}"
    row_id = uuid.uuid4()
    session.add(AuthToken(
        id=row_id,
        user_id=user.id,
        token_hash=reset_code_hash(row_id, code),
        purpose=PURPOSE_PASSWORD_RESET_CODE,
        expires_at=datetime.utcnow() + timedelta(minutes=config.PASSWORD_RESET_CODE_TTL_MINUTES),
        sent_to_email=user.email,
        attempts=0,
    ))
    await session.flush()
    return code


CODE_OK = "ok"
CODE_WRONG = "wrong"
CODE_LOCKED = "locked"
CODE_NONE = "none"


async def check_reset_code(session: AsyncSession, user: User, code: str) -> str:
    """Test `code` against this person's live code. Returns one of `CODE_*`.

    THE ATTEMPT IS COUNTED BEFORE THE COMPARISON, IN THE DATABASE, UNDER A ROW LOCK.
      * Before: a counter bumped only on a mismatch can be raced — fire fifty guesses at once and
        every one reads `attempts = 0` before any of them writes.
      * Under `FOR UPDATE`: the same race at the row level.
      * In the database: the rate limiter fails open when Redis is down; a lockout must not.

    THE CALLER MUST COMMIT BEFORE RAISING. `get_db` rolls back when a handler raises, so an attempt
    recorded and then followed by an HTTP 400 would be silently undone — unlimited guessing, with a
    counter that looks correct in every unit test. `routers/auth.py` commits explicitly, and
    `test_password_reset_code_postgres.py` proves wrong guesses accumulate across real requests.

    On success the code is spent. On the final wrong guess it is spent too — it cannot be used again
    even with the right digits, which is what "locked" has to mean.
    """
    row = (await session.execute(
        select(AuthToken)
        .where(
            AuthToken.user_id == user.id,
            AuthToken.purpose == PURPOSE_PASSWORD_RESET_CODE,
            AuthToken.used_at.is_(None),
        )
        .order_by(AuthToken.created_at.desc())
        .limit(1)
        .with_for_update()
    )).scalar_one_or_none()

    if row is None or row.is_expired():
        return CODE_NONE

    row.attempts = (row.attempts or 0) + 1
    await session.flush()

    if row.attempts > config.PASSWORD_RESET_CODE_MAX_ATTEMPTS:
        row.used_at = datetime.utcnow()
        await session.flush()
        return CODE_LOCKED

    if user.email.strip().lower() != row.sent_to_email.strip().lower():
        # Same rule as links: a code mailed to an address the account no longer has is dead.
        row.used_at = datetime.utcnow()
        await session.flush()
        return CODE_NONE

    matches = hmac.compare_digest(row.token_hash, reset_code_hash(row.id, code))
    if matches:
        row.used_at = datetime.utcnow()
        await session.flush()
        return CODE_OK

    if row.attempts >= config.PASSWORD_RESET_CODE_MAX_ATTEMPTS:
        row.used_at = datetime.utcnow()
        await session.flush()
        return CODE_LOCKED
    return CODE_WRONG
