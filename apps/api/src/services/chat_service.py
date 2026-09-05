"""Chat session persistence with Redis caching."""

import json
import logging
import uuid
from datetime import datetime

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models.chat import ChatMessage, ChatSession
from ..schemas.chat import (
    MessageResponse,
    SessionDetailResponse,
    SessionSummary,
)

logger = logging.getLogger(__name__)

DEFAULT_USER_ID = uuid.UUID("00000000-0000-4000-a000-000000000001")

# Redis TTLs (seconds)
SESSION_LIST_TTL = 300   # 5 minutes
SESSION_DETAIL_TTL = 600  # 10 minutes


# ── Redis helpers (graceful degradation) ─────────────────────────


async def _cache_get(redis, key: str) -> str | None:
    if redis is None:
        return None
    try:
        return await redis.get(key)
    except Exception:
        return None


async def _cache_set(redis, key: str, value: str, ttl: int) -> None:
    if redis is None:
        return
    try:
        await redis.setex(key, ttl, value)
    except Exception:
        pass


async def _cache_delete(redis, *keys: str) -> None:
    if redis is None:
        return
    try:
        await redis.delete(*keys)
    except Exception:
        pass


def _session_list_key(user_id: uuid.UUID) -> str:
    return f"chat:user:{user_id}:sessions"


def _session_detail_key(session_id: uuid.UUID) -> str:
    return f"chat:session:{session_id}:messages"


# ── Serializers ──────────────────────────────────────────────────


def _serialize_message(msg: ChatMessage) -> MessageResponse:
    return MessageResponse(
        id=str(msg.id),
        role=msg.role,
        content=msg.content,
        detected_mode=msg.detected_mode,
        thinking_content=msg.thinking_content,
        thinking_token_count=msg.thinking_token_count,
        thinking_budget_used=msg.thinking_budget_used,
        prompt_tokens=msg.prompt_tokens,
        completion_tokens=msg.completion_tokens,
        created_at=msg.created_at.isoformat(),
    )


def _serialize_session_summary(
    session: ChatSession, message_count: int
) -> SessionSummary:
    return SessionSummary(
        id=str(session.id),
        title=session.title,
        problem_id=str(session.problem_id) if session.problem_id else None,
        is_active=session.is_active,
        message_count=message_count,
        created_at=session.created_at.isoformat(),
        updated_at=session.updated_at.isoformat(),
    )


# ── Service functions ────────────────────────────────────────────


async def create_session(
    db: AsyncSession,
    redis,
    problem_id: str | None = None,
    title: str | None = None,
    user_id: uuid.UUID = DEFAULT_USER_ID,
) -> SessionDetailResponse:
    """Create a new chat session."""
    pid = None
    if problem_id:
        try:
            pid = uuid.UUID(problem_id)
        except ValueError:
            pid = None  # Ignore invalid UUIDs (e.g. mock data)

    session = ChatSession(
        user_id=user_id,
        problem_id=pid,
        title=title,
        is_active=True,
    )
    db.add(session)
    await db.flush()

    # Invalidate session list cache
    await _cache_delete(redis, _session_list_key(user_id))

    return SessionDetailResponse(
        id=str(session.id),
        title=session.title,
        problem_id=str(session.problem_id) if session.problem_id else None,
        is_active=session.is_active,
        created_at=session.created_at.isoformat(),
        updated_at=session.updated_at.isoformat(),
        messages=[],
    )


async def list_sessions(
    db: AsyncSession,
    redis,
    limit: int = 20,
    offset: int = 0,
    user_id: uuid.UUID = DEFAULT_USER_ID,
) -> tuple[list[SessionSummary], int]:
    """List chat sessions with message counts, newest first."""
    # Try cache first (only for first page with default limit)
    if offset == 0 and limit == 20:
        cached = await _cache_get(redis, _session_list_key(user_id))
        if cached:
            data = json.loads(cached)
            return [SessionSummary(**s) for s in data["sessions"]], data["total"]

    # Count total
    count_q = select(func.count()).select_from(ChatSession).where(
        ChatSession.user_id == user_id,
        ChatSession.is_active == True,  # noqa: E712
    )
    total = (await db.execute(count_q)).scalar() or 0

    # Fetch sessions with message counts
    msg_count_subq = (
        select(
            ChatMessage.session_id,
            func.count().label("msg_count"),
        )
        .group_by(ChatMessage.session_id)
        .subquery()
    )

    query = (
        select(ChatSession, func.coalesce(msg_count_subq.c.msg_count, 0))
        .outerjoin(msg_count_subq, ChatSession.id == msg_count_subq.c.session_id)
        .where(
            ChatSession.user_id == user_id,
            ChatSession.is_active == True,  # noqa: E712
        )
        .order_by(ChatSession.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )

    result = await db.execute(query)
    sessions = []
    for row in result.all():
        session_obj = row[0]
        msg_count = row[1]
        sessions.append(_serialize_session_summary(session_obj, msg_count))

    # Cache first page
    if offset == 0 and limit == 20:
        cache_data = json.dumps({
            "sessions": [s.model_dump() for s in sessions],
            "total": total,
        })
        await _cache_set(redis, _session_list_key(user_id), cache_data, SESSION_LIST_TTL)

    return sessions, total


async def get_session_with_messages(
    db: AsyncSession,
    redis,
    session_id: uuid.UUID,
) -> SessionDetailResponse | None:
    """Load a session with all its messages."""
    # Try cache
    cached = await _cache_get(redis, _session_detail_key(session_id))
    if cached:
        return SessionDetailResponse(**json.loads(cached))

    # DB query with eager-loaded messages
    query = (
        select(ChatSession)
        .options(selectinload(ChatSession.messages))
        .where(ChatSession.id == session_id)
    )
    result = await db.execute(query)
    session = result.scalar_one_or_none()

    if not session:
        return None

    detail = SessionDetailResponse(
        id=str(session.id),
        title=session.title,
        problem_id=str(session.problem_id) if session.problem_id else None,
        is_active=session.is_active,
        created_at=session.created_at.isoformat(),
        updated_at=session.updated_at.isoformat(),
        messages=[_serialize_message(m) for m in session.messages],
    )

    # Cache
    await _cache_set(
        redis,
        _session_detail_key(session_id),
        json.dumps(detail.model_dump()),
        SESSION_DETAIL_TTL,
    )

    return detail


async def save_message(
    db: AsyncSession,
    redis,
    session_id: uuid.UUID,
    role: str,
    content: str,
    detected_mode: str | None = None,
    thinking_content: str | None = None,
    thinking_token_count: int | None = None,
    thinking_budget_used: float | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    user_id: uuid.UUID = DEFAULT_USER_ID,
) -> MessageResponse:
    """Save a message to a session. Auto-titles session from first user message."""
    msg = ChatMessage(
        session_id=session_id,
        role=role,
        content=content,
        detected_mode=detected_mode,
        thinking_content=thinking_content,
        thinking_token_count=thinking_token_count,
        thinking_budget_used=thinking_budget_used,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
    db.add(msg)

    # Auto-title from first user message
    if role == "user":
        session = await db.get(ChatSession, session_id)
        if session and not session.title:
            clean = content.replace("\n", " ").strip()
            session.title = clean[:50] + ("..." if len(clean) > 50 else "")
        if session:
            session.updated_at = datetime.utcnow()

    await db.flush()

    # Invalidate caches
    await _cache_delete(
        redis,
        _session_detail_key(session_id),
        _session_list_key(user_id),
    )

    return _serialize_message(msg)


async def delete_session(
    db: AsyncSession,
    redis,
    session_id: uuid.UUID,
    user_id: uuid.UUID = DEFAULT_USER_ID,
) -> bool:
    """Delete a chat session and all its messages."""
    session = await db.get(ChatSession, session_id)
    if not session:
        return False

    await db.execute(
        sa_delete(ChatMessage).where(ChatMessage.session_id == session_id)
    )
    await db.delete(session)
    await db.flush()

    # Invalidate caches
    await _cache_delete(
        redis,
        _session_detail_key(session_id),
        _session_list_key(user_id),
    )

    return True
