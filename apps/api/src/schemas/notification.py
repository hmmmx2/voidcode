"""Pydantic schemas for the Notifications API."""

from pydantic import BaseModel


class NotificationResponse(BaseModel):
    id: str
    type: str
    title: str
    message: str
    is_read: bool
    reference_id: str | None = None
    created_at: str


class NotificationListResponse(BaseModel):
    notifications: list[NotificationResponse]
    unread_count: int
    total: int


class MarkReadRequest(BaseModel):
    notification_ids: list[str] = []  # empty = mark ALL as read
