"""
Notifications Router — list, count, manage notifications, and SSE stream.
"""

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..redis_client import get_redis
from ..schemas.notification import MarkReadRequest, NotificationListResponse
from ..services.notification_service import (
    get_notifications,
    get_unread_count,
    mark_notifications_read,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/notifications", tags=["notifications"])





@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> NotificationListResponse:
    """List notifications for the current user, newest first."""
    notifications, unread_count, total = await get_notifications(
        db, user_id, limit=limit, unread_only=unread_only
    )
    return NotificationListResponse(
        notifications=notifications,
        unread_count=unread_count,
        total=total,
    )


@router.get("/count")
async def notification_count(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Lightweight endpoint for the notification badge count."""
    count = await get_unread_count(db, user_id)
    return {"unread_count": count}


@router.get("/stream")
async def notification_stream(
    user_id: uuid.UUID = Depends(identity.current_user_id),
) -> StreamingResponse:
    """
    SSE stream — pushes a notification event the instant one is created.

    The client keeps this connection open permanently. Events:
      - connected  : sent once on connect to confirm the stream is live
      - heartbeat  : sent every 30 s so the connection stays alive through
                     proxies / load balancers that close idle connections
      - notification: the full notification payload, published by
                      notification_service.create_notification() via Redis

    Uses Redis pub/sub so events work correctly in a multi-node cluster —
    a submission handled on Node A will reach a client connected to Node B.
    """
    async def event_generator():
        channel = f"user:{user_id}:notifications"
        r = get_redis()
        pubsub = r.pubsub()
        await pubsub.subscribe(channel)
        logger.info(f"SSE stream opened for user {user_id}")
        try:
            # Confirm connection immediately
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"

            while True:
                # Block up to 30 s waiting for a Redis message.
                # timeout=30.0 means: if nothing arrives in 30 s, return None
                # so we can send a heartbeat and loop back.
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=30.0
                )
                if msg and msg["type"] == "message":
                    yield f"data: {msg['data'].decode()}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

                # Yield to the event loop so other tasks can run
                await asyncio.sleep(0)

        except (asyncio.CancelledError, GeneratorExit):
            # Client disconnected — clean up quietly
            pass
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
            logger.info(f"SSE stream closed for user {user_id}")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # tells nginx not to buffer SSE chunks
            "Connection": "keep-alive",
        },
    )


@router.patch("/read")
async def mark_read(
    payload: MarkReadRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark notifications as read. Empty list = mark ALL as read."""
    updated = await mark_notifications_read(
        db, user_id, payload.notification_ids or None
    )
    return {"updated": updated}
