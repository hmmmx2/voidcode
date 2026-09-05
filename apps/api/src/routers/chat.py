"""
Chat History Router

Provides endpoints for managing VoidCode AI chat sessions and messages.
- POST   /v1/chat/sessions           — create a new session
- GET    /v1/chat/sessions           — list sessions (newest first)
- GET    /v1/chat/sessions/{id}      — load session with all messages
- POST   /v1/chat/sessions/{id}/messages — save a message
- DELETE /v1/chat/sessions/{id}      — delete session + cascade messages
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..redis_client import get_redis
from ..schemas.chat import (
    CreateSessionRequest,
    MessageResponse,
    SaveMessageRequest,
    SessionDetailResponse,
    SessionListResponse,
)
from ..services.chat_service import (
    create_session,
    delete_session,
    get_session_with_messages,
    list_sessions,
    save_message,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/chat", tags=["chat"])


def _get_redis_or_none():
    """Get Redis client, returning None if unavailable."""
    try:
        return get_redis()
    except RuntimeError:
        return None


@router.post("/sessions", response_model=SessionDetailResponse, status_code=201)
async def create_chat_session(
    request: CreateSessionRequest,
    db: AsyncSession = Depends(get_db),
    user_id: uuid.UUID = Depends(identity.current_user_id),
):
    """Create a new chat session."""
    redis = _get_redis_or_none()
    return await create_session(
        db=db,
        redis=redis,
        problem_id=request.problem_id,
        title=request.title,
        user_id=user_id,
    )


@router.get("/sessions", response_model=SessionListResponse)
async def list_chat_sessions(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user_id: uuid.UUID = Depends(identity.current_user_id),
):
    """List chat sessions with message counts, newest first."""
    redis = _get_redis_or_none()
    sessions, total = await list_sessions(
        db=db, redis=redis, limit=limit, offset=offset, user_id=user_id
    )
    return SessionListResponse(sessions=sessions, total=total)


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def get_chat_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Load a session with all its messages."""
    redis = _get_redis_or_none()
    detail = await get_session_with_messages(db=db, redis=redis, session_id=session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


@router.post(
    "/sessions/{session_id}/messages",
    response_model=MessageResponse,
    status_code=201,
)
async def save_chat_message(
    session_id: uuid.UUID,
    request: SaveMessageRequest,
    db: AsyncSession = Depends(get_db),
):
    """Save a message to a session."""
    redis = _get_redis_or_none()

    # Verify session exists
    detail = await get_session_with_messages(db=db, redis=redis, session_id=session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")

    return await save_message(
        db=db,
        redis=redis,
        session_id=session_id,
        role=request.role,
        content=request.content,
        detected_mode=request.detected_mode,
        thinking_content=request.thinking_content,
        thinking_token_count=request.thinking_token_count,
        thinking_budget_used=request.thinking_budget_used,
        prompt_tokens=request.prompt_tokens,
        completion_tokens=request.completion_tokens,
    )


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_chat_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Delete a chat session and all its messages."""
    redis = _get_redis_or_none()
    deleted = await delete_session(db=db, redis=redis, session_id=session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
