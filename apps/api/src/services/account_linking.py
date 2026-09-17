"""Who a verified Google or Microsoft identity signs in as.

`services/oidc.py` proves a token is genuine. This module decides which VoidCode account it belongs
to, and that decision is where account takeover happens or does not.

THE RULES, IN THE ORDER THEY ARE TRIED

1. An identity row for `(provider, subject)` exists → that account. The email in the token is not
   consulted at all: a person can change their Google address, and an attacker can put any address
   in a Microsoft token. The subject is the identity.

2. Otherwise the email must be TRUSTED (`oidc` decides what trusted means per provider). An untrusted
   address never touches an existing account, and the refusal is worded identically whether or not
   an account exists, so it cannot be used to test which addresses are registered.

3. A trusted email matching an existing account → link and sign in. This is also how people who used
   Google or Microsoft on the old website carry on: the website created their account by email and
   never stored a subject, so their first desktop sign-in is where the link gets written.

   PRE-HIJACKING GUARD. An attacker who knows someone's address can register it here with a password
   BEFORE the real owner ever signs in. When the owner later arrives through Google, rule 3 would
   hand them an account whose password the attacker still knows. So if the matched account's email
   was never verified AND it has a password, that password is removed and every session and reset
   token on the account is revoked. Only an account whose address was never proven is affected; the
   caller is told (`password_cleared`) so the app can explain.

4. No account → create one, with the terms version the app displayed.

LINK MODE (a signed-in person pressing "Connect Google") skips rules 2 to 4: a valid session is proof of
who is asking, so the provider account attaches regardless of what address it carries — unless it is
already attached to someone else.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..identity import ANONYMOUS_USER_ID
from ..models.auth_token import PURPOSE_PASSWORD_RESET_CODE
from ..models.user import User
from ..models.user_identity import UserIdentity
from . import token_service
from .notification_service import create_welcome_notification
from .oidc import VerifiedIdentity

logger = logging.getLogger(__name__)

PROVIDER_LABELS = {"google": "Google", "microsoft": "Microsoft"}


class AccountLinkError(Exception):
    """A refusal with a stable `code` and a message written for the person signing in.

    codes: `unverified_email`, `conflict`, `terms_required`, `inactive`.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class SignInOutcome:
    user: User
    created: bool
    password_cleared: bool


def _now() -> datetime:
    # The user and identity auth timestamps are timezone-aware; see `models/user.py`.
    return datetime.now(timezone.utc)


async def _identity_row(db: AsyncSession, provider: str, subject: str) -> UserIdentity | None:
    return (await db.execute(
        select(UserIdentity)
        .where(UserIdentity.provider == provider, UserIdentity.subject == subject)
        .with_for_update()
    )).scalar_one_or_none()


async def sign_in(
    db: AsyncSession,
    identity: VerifiedIdentity,
    *,
    terms_version: str | None,
    before_create: Callable[[], Awaitable[None]] | None = None,
) -> SignInOutcome:
    """Resolve, link or create. Flushes; the caller commits. See the module docstring for the rules.

    `before_create` runs only when an account is about to be created, which is where the
    registration rate limit belongs — signing in to an existing account should not spend it.
    """
    label = PROVIDER_LABELS.get(identity.provider, identity.provider)

    # ── 1. a known provider account ───────────────────────────────────────
    row = await _identity_row(db, identity.provider, identity.subject)
    if row is not None:
        user = await db.get(User, row.user_id, with_for_update=True)
        if user is None or not user.is_active:
            raise AccountLinkError("inactive", "This account can't be signed in to.")
        row.last_used_at = _now()
        await db.flush()
        return SignInOutcome(user=user, created=False, password_cleared=False)

    # ── 2. the address must be one the provider vouches for ───────────────
    if not identity.email_trusted or identity.email is None:
        raise AccountLinkError(
            "unverified_email",
            f"{label} didn't confirm this email address, so it can't be used to sign in. Sign in "
            f"with your email and password (or create an account), then connect {label} from your "
            "account settings.",
        )

    existing = (await db.execute(
        select(User).where(func.lower(User.email) == identity.email).with_for_update()
    )).scalar_one_or_none()

    # ── 3. link to the account that owns this address ─────────────────────
    if existing is not None:
        if existing.id == ANONYMOUS_USER_ID:
            # The shared anonymous row can never become a person's account.
            raise AccountLinkError("unverified_email", "This email address can't be used to sign in.")
        if not existing.is_active:
            raise AccountLinkError("inactive", "This account can't be signed in to.")

        already = (await db.execute(
            select(UserIdentity).where(
                UserIdentity.user_id == existing.id, UserIdentity.provider == identity.provider
            )
        )).scalar_one_or_none()
        if already is not None:
            # A DIFFERENT account from this provider is already attached (a same-subject one would
            # have matched rule 1). Two Google accounts on one VoidCode account is ambiguous.
            raise AccountLinkError(
                "conflict",
                f"This VoidCode account is already connected to a different {label} account.",
            )

        password_cleared = False
        if existing.email_verified_at is None and existing.password_hash is not None:
            existing.password_hash = None
            existing.password_changed_at = _now()
            await token_service.revoke_desktop_sessions(db, existing.id)
            await token_service.revoke_all(db, existing.id, PURPOSE_PASSWORD_RESET_CODE)
            password_cleared = True
            logger.warning(
                "cleared an unverified password on account %s when %s proved ownership of its address",
                existing.id, identity.provider,
            )

        if existing.email_verified_at is None:
            existing.email_verified_at = _now()

        db.add(_new_identity(existing.id, identity))
        await db.flush()
        return SignInOutcome(user=existing, created=False, password_cleared=password_cleared)

    # ── 4. a new account ──────────────────────────────────────────────────
    if not terms_version:
        raise AccountLinkError(
            "terms_required", "You need to accept the Terms of Use and Privacy Policy to create an account."
        )
    if before_create is not None:
        await before_create()

    now = _now()
    user = User(
        email=identity.email,
        name=(identity.name or identity.email.split("@", 1)[0])[:200],
        role="student",
        is_active=True,
        password_hash=None,
        email_verified_at=now,
        terms_accepted_at=now,
        terms_version=terms_version,
    )
    db.add(user)
    await db.flush()
    db.add(_new_identity(user.id, identity))
    await db.flush()
    await create_welcome_notification(db, user.id)
    return SignInOutcome(user=user, created=True, password_cleared=False)


async def link(db: AsyncSession, user: User, identity: VerifiedIdentity) -> None:
    """Attach a provider account to a signed-in person. Flushes; the caller commits.

    No email check: the session already proves who is asking, and people legitimately connect a
    Google account whose address differs from the one they registered with.
    """
    label = PROVIDER_LABELS.get(identity.provider, identity.provider)

    row = await _identity_row(db, identity.provider, identity.subject)
    if row is not None:
        if row.user_id == user.id:
            return  # already connected; connecting twice is not an error
        raise AccountLinkError(
            "conflict", f"That {label} account is already connected to another VoidCode account."
        )

    already = (await db.execute(
        select(UserIdentity).where(
            UserIdentity.user_id == user.id, UserIdentity.provider == identity.provider
        )
    )).scalar_one_or_none()
    if already is not None:
        raise AccountLinkError(
            "conflict", f"This VoidCode account is already connected to a different {label} account."
        )

    db.add(_new_identity(user.id, identity))
    await db.flush()


def _new_identity(user_id, identity: VerifiedIdentity) -> UserIdentity:
    now = _now()
    return UserIdentity(
        user_id=user_id,
        provider=identity.provider,
        subject=identity.subject,
        tenant_id=identity.tenant_id,
        email_at_link=identity.email,
        email_trusted_at_link=identity.email_trusted,
        created_at=now,
        last_used_at=now,
    )
