"""Notification service — create, list, and manage user notifications."""

import json
import logging
import uuid
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.notification import Notification
from ..schemas.notification import NotificationResponse

logger = logging.getLogger(__name__)


def _notification_to_response(n: Notification) -> NotificationResponse:
    """Convert a Notification ORM object to a response schema."""
    return NotificationResponse(
        id=str(n.id),
        type=n.type,
        title=n.title,
        message=n.message,
        is_read=n.is_read,
        reference_id=n.reference_id,
        created_at=n.created_at.isoformat() if n.created_at else "",
    )


async def get_notifications(
    db: AsyncSession,
    user_id: uuid.UUID,
    limit: int = 50,
    unread_only: bool = False,
) -> tuple[list[NotificationResponse], int, int]:
    """
    Fetch notifications for a user, newest first.

    Returns: (notifications, unread_count, total)
    """
    # Build query
    query = select(Notification).where(Notification.user_id == user_id)
    if unread_only:
        query = query.where(Notification.is_read == False)  # noqa: E712
    query = query.order_by(Notification.created_at.desc()).limit(limit)

    result = await db.execute(query)
    notifications = [_notification_to_response(n) for n in result.scalars().all()]

    # Unread count
    unread_count = await get_unread_count(db, user_id)

    # Total count
    total_result = await db.execute(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id
        )
    )
    total = total_result.scalar() or 0

    return notifications, unread_count, total


async def get_unread_count(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> int:
    """Quick count of unread notifications for badge display."""
    result = await db.execute(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id,
            Notification.is_read == False,  # noqa: E712
        )
    )
    return result.scalar() or 0


async def create_notification(
    db: AsyncSession,
    user_id: uuid.UUID,
    type: str,
    title: str,
    message: str,
    reference_id: str | None = None,
) -> NotificationResponse:
    """Create a new notification for a user."""
    notification = Notification(
        user_id=user_id,
        type=type,
        title=title,
        message=message,
        reference_id=reference_id,
    )
    db.add(notification)
    await db.flush()
    logger.info(f"Created {type} notification for user {user_id}")

    # Publish to Redis so any open SSE stream for this user receives it instantly.
    # Wrapped in try/except — a Redis failure must never prevent DB notification creation.
    try:
        from ..redis_client import get_redis
        r = get_redis()
        payload = json.dumps({
            "type": "notification",
            "data": {
                "id": str(notification.id),
                "type": type,
                "title": title,
                "message": message,
                "is_read": False,
                "reference_id": reference_id,
                "created_at": notification.created_at.isoformat()
                if notification.created_at
                else datetime.utcnow().isoformat(),
            },
        })
        await r.publish(f"user:{user_id}:notifications", payload)
        logger.debug(f"Published notification to Redis for user {user_id}")
    except Exception as exc:
        logger.warning(f"Redis publish failed for user {user_id}: {exc}")

    return _notification_to_response(notification)


async def mark_notifications_read(
    db: AsyncSession,
    user_id: uuid.UUID,
    notification_ids: list[str] | None = None,
) -> int:
    """
    Mark notifications as read.

    If notification_ids is empty or None, mark ALL unread notifications as read.
    Otherwise mark only the specified IDs.
    """
    stmt = (
        update(Notification)
        .where(Notification.user_id == user_id, Notification.is_read == False)  # noqa: E712
    )

    if notification_ids:
        uuids = [uuid.UUID(nid) for nid in notification_ids]
        stmt = stmt.where(Notification.id.in_(uuids))

    stmt = stmt.values(is_read=True)
    result = await db.execute(stmt)
    updated = result.rowcount
    logger.info(f"Marked {updated} notifications as read for user {user_id}")
    return updated


async def create_welcome_notification(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> NotificationResponse:
    """Create a welcome notification for a newly created user."""
    return await create_notification(
        db,
        user_id,
        type="welcome",
        title="Welcome to VoidCode AI!",
        message="Start your journey by tackling your first programming challenge. Good luck!",
    )
