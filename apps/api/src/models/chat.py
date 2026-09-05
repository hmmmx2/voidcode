"""VoidCode AI chat sessions and messages."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
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
    from .user import User


class ChatSession(Base):
    """A conversation thread between a user and the VoidCode AI."""

    __tablename__ = "chat_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Optional link to the problem being discussed
    problem_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("problems.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Auto-generated from first user message, or user can rename

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    user: Mapped["User"] = relationship(back_populates="chat_sessions")
    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.created_at",
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    role: Mapped[str] = mapped_column(
        SAEnum("user", "assistant", "system", name="message_role_enum"),
        nullable=False,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # VoidCode AI metadata (only populated for assistant messages)
    detected_mode: Mapped[str | None] = mapped_column(
        SAEnum(
            "teaching",
            "debug",
            "explain",
            "followup",
            "general",
            name="tutor_mode_enum",
            create_constraint=False,
        ),
        nullable=True,
    )
    thinking_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    thinking_token_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thinking_budget_used: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Token usage tracking
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        index=True,
    )

    session: Mapped["ChatSession"] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_chat_messages_session_time", "session_id", "created_at"),
    )
