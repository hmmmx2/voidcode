"""User accounts and preferences."""

import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy import (
    Enum as SAEnum,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    # SQLAlchemy resolves these string annotations through its own registry at
    # runtime, so the code works without them -- but nothing else can follow the
    # reference, and ruff reads them as undefined names. Importing under
    # TYPE_CHECKING gives type checkers and editors the link with no runtime import,
    # so the model cycle these tables genuinely form cannot become an import cycle.
    from .chat import ChatSession
    from .notification import Notification
    from .submission import Submission


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(
        String(255), unique=True, index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(
        SAEnum("student", "instructor", "admin", name="user_role_enum"),
        default="student",
        nullable=False,
    )
    # Argon2id encoding, ~97 chars. NULL means the account has no password and
    # signs in through Google or Microsoft only — `verify_password` treats NULL
    # as "never authenticates", whatever is submitted.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # ── Auth state ────────────────────────────────────────────────
    #
    # These four are `DateTime(timezone=True)` while `created_at`/`updated_at`
    # below are naive. That inconsistency is deliberate: these are the first
    # timestamps here that get *compared* rather than displayed, and mixing a
    # naive with an aware datetime raises `TypeError` — which would surface in
    # the password-reset expiry check. Always write them with
    # `datetime.now(timezone.utc)`, never `datetime.utcnow()`.

    # NULL = unverified. Backfilled to `created_at` for every pre-existing
    # account, since completing an OAuth flow proves control of the mailbox.
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The value shown to the user is the one from the PREVIOUS sign-in, captured
    # before this one overwrites it — "last signed in: now" tells nobody anything.
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Bumped on password reset and change; a session carrying an older value is
    # invalid. This is the whole revocation mechanism — sessions are stateless
    # JWTs with no adapter, so there is nothing else to revoke.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    # ── Profile fields ────────────────────────────────────────────
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    occupation: Mapped[str | None] = mapped_column(String(200), nullable=True)
    profile_photo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    preferences: Mapped["UserPreferences | None"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    submissions: Mapped[list["Submission"]] = relationship(back_populates="user")
    chat_sessions: Mapped[list["ChatSession"]] = relationship(back_populates="user")
    notifications: Mapped[list["Notification"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Case-insensitive email uniqueness, declared HERE and not only in the
        # migration.
        #
        # Alembic autogenerate compares the model against the live schema. An
        # index that exists in the database but not in the model reads as
        # "removed", so the next `--autogenerate` emits `op.drop_index(...)` —
        # and applying that migration would silently delete the invariant that
        # stops `Alice@x.com` and `alice@x.com` becoming two accounts.
        #
        # This is not hypothetical: the drift check run immediately after
        # creating this index produced exactly that drop.
        Index("ix_users_email_lower", text("lower(email)"), unique=True),
    )


class UserPreferences(Base):
    __tablename__ = "user_preferences"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    theme: Mapped[str] = mapped_column(
        SAEnum("light", "dark", "system", name="theme_enum"),
        default="system",
    )
    preferred_language: Mapped[str] = mapped_column(String(30), default="Python")
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # ── Daily Challenge ──────────────────────────────────────────────────
    #
    # These live here rather than in their own table because that is what they
    # are: a user preference. A `daily_subscriptions` table would carry one row
    # per user, one-to-one with this one, and every read would join for nothing.
    #
    # Opt-in by default is `False`, deliberately. Nobody who signs up for an
    # interview-prep platform has consented to a daily email, and pre-ticking
    # the box is the behaviour that gets a sending domain blocklisted.
    daily_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Local hour, 0-23, interpreted in `daily_timezone`. Stored apart from the
    # timezone so changing location does not silently move the send time.
    daily_send_hour: Mapped[int] = mapped_column(Integer, default=9, nullable=False)
    daily_timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)

    # Guards against a double send when the job runs more than once in an hour.
    daily_last_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Long-lived and NOT single-use, unlike the deep-link token: an unsubscribe
    # link has to keep working from an old email months later. That is exactly
    # why it can only ever unsubscribe and never authenticate.
    daily_unsubscribe_token: Mapped[str | None] = mapped_column(
        String(64), unique=True, nullable=True, index=True
    )

    user: Mapped["User"] = relationship(back_populates="preferences")
