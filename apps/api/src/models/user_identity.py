"""A Google or Microsoft account linked to a VoidCode account.

WHY ACCOUNTS ARE LINKED BY PROVIDER SUBJECT AND NOT BY EMAIL

The website signed people in with Google and Microsoft through NextAuth, and the API found or created
the user by the email the website passed along. Two things made that safe only by accident: the API
was never publicly reachable, and nothing else ever called that endpoint. The desktop app calls the
API directly, so the email in a provider's token becomes the thing standing between a stranger and
somebody else's account.

An email claim is not an identity. Microsoft's multi-tenant `email` claim is set by whoever
administers the tenant, so anyone who creates a tenant can mint a token saying `ceo@yourcompany.com`
— the "nOAuth" account-takeover class. Google's `email_verified` is true for addresses Google once
confirmed but may no longer be controlled by the person holding the account. What a provider does
guarantee is its SUBJECT: stable, unique, and unassignable to anyone else. So a row here is keyed by
`(provider, subject)`, and once it exists the email in later tokens is never consulted again.

Email is used exactly once, to decide whether a FIRST sign-in may attach to an account that already
exists — and only when `services/account_linking.py` judges the provider's assertion trustworthy.
That decision is recorded in `email_trusted_at_link` so it can be audited later.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

PROVIDER_GOOGLE = "google"
PROVIDER_MICROSOFT = "microsoft"
PROVIDERS = (PROVIDER_GOOGLE, PROVIDER_MICROSOFT)


class UserIdentity(Base):
    __tablename__ = "user_identities"
    __table_args__ = (
        # THE invariant. One provider account can belong to exactly one VoidCode account; without
        # this, two rows could each claim the same Google subject and sign-in would pick whichever
        # the planner returned first.
        UniqueConstraint("provider", "subject", name="uq_user_identities_provider_subject"),
        # One Google account per VoidCode account. Linking a second would make "which Google account
        # signs me in" a question with two answers, and unlinking ambiguous.
        UniqueConstraint("user_id", "provider", name="uq_user_identities_user_provider"),
        Index("ix_user_identities_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)

    #: Google: `sub`. Microsoft: `"{tid}:{oid}"` — see `services/oidc.py` for why not Microsoft's `sub`.
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Microsoft tenant, for audit and for a future tenant allowlist. Null for Google.
    tenant_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    #: The address the provider asserted when the link was made, and whether it was trusted then.
    #: Audit only; never read to decide who signs in.
    email_at_link: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_trusted_at_link: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
