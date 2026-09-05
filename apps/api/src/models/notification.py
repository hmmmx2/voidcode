"""Notification model — per-user notifications for system events."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    # SQLAlchemy resolves these string annotations through its own registry at
    # runtime, so the code works without them -- but nothing else can follow the
    # reference, and ruff reads them as undefined names. Importing under
    # TYPE_CHECKING gives type checkers and editors the link with no runtime import,
    # so the model cycle these tables genuinely form cannot become an import cycle.
    from .user import User


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    type: Mapped[str] = mapped_column(
        SAEnum(
            "submission_accepted",
            "submission_failed",
            "welcome",
            "streak",
            "system",
            name="notification_type_enum",
        ),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # Optional reference to a related entity (e.g., problem_id for submission notifications)
    reference_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )

    # Composite index for the common query: "unread notifications for user, newest first"
    __table_args__ = (
        Index(
            "ix_notifications_user_unread",
            "user_id",
            "is_read",
            "created_at",
        ),
    )

    # Relationship
    user: Mapped["User"] = relationship(back_populates="notifications")
