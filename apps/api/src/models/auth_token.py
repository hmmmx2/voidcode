"""Single-use tokens for password reset and email verification.

WHY A TABLE AND NOT A SIGNED, STATELESS TOKEN
------------------------------------------------
A JWT carrying `{user_id, purpose, exp}` needs no storage and is tempting. It cannot be revoked, and
revocation is the whole point here: a reset link must stop working the moment it is used, and every
outstanding link must die when the password changes. A stateless token stays valid until it expires,
so a link forwarded, logged by a mail scanner, or sitting in a mailbox someone else now reads is a
live credential for its whole lifetime.

WHY THE TOKEN IS STORED HASHED
---------------------------------
The column holds SHA-256 of the token, never the token. Anyone with read access to this table —
a backup, a log of a slow query, a support engineer — would otherwise hold a working password-reset
link for every pending request. The same reasoning as `password_hash` on `users`, for the same
reason: a database dump should not be a set of live credentials.

Plain SHA-256 rather than argon2id, unlike passwords. The input here is 32 bytes from
`secrets.token_urlsafe`, so there is nothing to brute-force and no dictionary to try; argon2's work
factor exists to slow down guessing at human-chosen secrets and would only add latency to a lookup
on the request path.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, SmallInteger, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

#: What a token authorises. Kept as a string column rather than a native enum so adding a purpose
#: later is a code change and not a migration that locks the table.
#:
#: `password_reset` — a single-use LINK, mailed to the address — was removed with the website: a
#: link is only redeemable by a web page that collects a new password, and there is no longer one.
#: The desktop app uses `password_reset_code` instead, which is redeemed inside the app that asked
#: for it. Rows written by the old flow expire on their own; nothing issues more.
PURPOSE_EMAIL_VERIFY = "email_verify"

#: A signed-in desktop client.
#:
#: The other two purposes are single-use links delivered by email and spent within the hour. This
#: one is a long-lived credential a native app holds in the OS keychain and presents on every
#: request, which changes three things about how it is handled: it is NOT consumed on use, issuing
#: a second one does NOT revoke the first (a person may sign in on a laptop and a desktop), and its
#: lifetime is measured in months rather than minutes.
#:
#: It exists because the web app's identity mechanism cannot be given to a desktop client. That is
#: an HMAC over the user id with a secret shared between the Next.js proxy and this API; shipping
#: it inside an installable application would hand every user the key to assert any identity.
PURPOSE_DESKTOP_SESSION = "desktop_session"

#: A six-digit password-reset code, typed into the desktop app.
#:
#: The link-based reset needs a web page to land on, and the desktop app has no website behind it.
#: A code the user types into the app that asked for it needs no page, no deep link and no CORS on
#: the public API. It is also the one safe way for an account that signs in with Google or Microsoft
#: to set a first password: receiving the code proves control of the mailbox.
#:
#: A six-digit code is guessable where a 32-byte token is not, which changes how it is stored and
#: checked — see `token_service.issue_reset_code` for the keyed hash and `attempts` below for the
#: lockout.
PURPOSE_PASSWORD_RESET_CODE = "password_reset_code"


class AuthToken(Base):
    """One row per issued token. Consumed by setting `used_at`, never by deleting.

    Keeping used rows is deliberate: a second click on a reset link must be distinguishable from a
    forged token, so the user gets "this link has already been used" rather than a bare "invalid".
    A row that vanished on use makes those two cases identical.
    """

    __tablename__ = "auth_tokens"
    __table_args__ = (
        # The lookup is always by hash, and it must be unique — two rows sharing one hash would
        # make `scalar_one()` raise on a valid link.
        Index("ix_auth_tokens_hash", "token_hash", unique=True),
        # Revoking every outstanding token for a user on password change scans by this pair.
        Index("ix_auth_tokens_user_purpose", "user_id", "purpose"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        # Cascade: a token for a deleted account authorises nothing, and leaving orphans means a
        # reset attempt resolves to a user_id with no row and fails as a 500 rather than a 400.
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )

    #: SHA-256 hex of the token. Never the token itself — see the module docstring.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)

    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    #: Set when consumed. Non-null means spent; the row is kept so a second click can be told apart
    #: from a forgery.
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    #: The address the token was sent to.
    #:
    #: Denormalised on purpose. A reset link must be invalidated if the account's email changes
    #: afterwards — otherwise a link mailed to a compromised old address still works. Comparing this
    #: against the user's current email at redemption is what makes that check possible; reading
    #: `user.email` at redemption would compare the new address with itself and always agree.
    sent_to_email: Mapped[str] = mapped_column(String(255), nullable=False)

    #: Wrong guesses made against this token. Only meaningful for `PURPOSE_PASSWORD_RESET_CODE`.
    #:
    #: A 32-byte link needs no counter — there is nothing to guess. A six-digit code has a million
    #: values, so without a per-code limit the only defence is the IP rate limit, which a botnet does
    #: not notice. Five guesses per code is what bounds an attacker, and it lives on the row rather
    #: than in Redis because the rate limiter fails OPEN when Redis is down, and a lockout must not.
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default="0")

    user: Mapped[User] = relationship()  # noqa: F821

    @property
    def is_spent(self) -> bool:
        return self.used_at is not None

    def is_expired(self, now: datetime | None = None) -> bool:
        return (now or datetime.utcnow()) >= self.expires_at
