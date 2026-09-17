"""Issue, redeem and revoke single-use auth tokens.

The rules here are the difference between a password reset and an account takeover, so each one has
its reason next to it rather than in a commit message.
"""
from __future__ import annotations

import hashlib
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
    PURPOSE_PASSWORD_RESET,
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
    if purpose == PURPOSE_PASSWORD_RESET:
        ttl = timedelta(minutes=config.RESET_TOKEN_TTL_MINUTES)
    elif purpose == PURPOSE_DESKTOP_SESSION:
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


async def revoke_password_resets(session: AsyncSession, user_id) -> int:
    return await revoke_all(session, user_id, PURPOSE_PASSWORD_RESET)


async def issue_password_reset(session: AsyncSession, user: User) -> str:
    return await issue(session, user, PURPOSE_PASSWORD_RESET)


async def issue_email_verification(session: AsyncSession, user: User) -> str:
    return await issue(session, user, PURPOSE_EMAIL_VERIFY)


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
