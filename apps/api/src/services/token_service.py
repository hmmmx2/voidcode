"""Issue, redeem and revoke single-use auth tokens.

The rules here are the difference between a password reset and an account takeover, so each one has
its reason next to it rather than in a commit message.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config
from ..models.auth_token import (
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


async def issue(session: AsyncSession, user: User, purpose: str) -> str:
    """Create a token for `user` and return the RAW value, which is never stored.

    Existing unspent tokens for the same purpose are revoked first. Otherwise requesting a second
    reset leaves the first link live, so an attacker who triggered a reset an hour ago still holds a
    working link after the real owner requests their own.
    """
    await revoke_all(session, user.id, purpose)

    token = generate_token()
    ttl = (
        timedelta(minutes=config.RESET_TOKEN_TTL_MINUTES)
        if purpose == PURPOSE_PASSWORD_RESET
        else timedelta(hours=config.VERIFY_TOKEN_TTL_HOURS)
    )

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
