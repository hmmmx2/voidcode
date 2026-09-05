"""Profile service — read and update user profile data."""

import logging
import uuid
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.user import User
from ..schemas.profile import ProfileResponse, ProfileUpdateRequest

logger = logging.getLogger(__name__)


def _compute_age(birth_date: date | None) -> int | None:
    """Compute age in years from birth_date."""
    if birth_date is None:
        return None
    today = date.today()
    age = today.year - birth_date.year
    # Subtract 1 if birthday hasn't happened yet this year
    if (today.month, today.day) < (birth_date.month, birth_date.day):
        age -= 1
    return age


def _user_to_profile(user: User) -> ProfileResponse:
    """Convert a User ORM object to a ProfileResponse."""
    return ProfileResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        bio=user.bio,
        birth_date=user.birth_date.isoformat() if user.birth_date else None,
        age=_compute_age(user.birth_date),
        country=user.country,
        occupation=user.occupation,
        profile_photo_url=user.profile_photo_url,
        timezone=user.timezone,
        # Presence only. The hash never leaves the server.
        has_password=user.password_hash is not None,
        created_at=user.created_at.isoformat() if user.created_at else "",
        updated_at=user.updated_at.isoformat() if user.updated_at else "",
    )


async def get_profile(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> ProfileResponse | None:
    """Fetch user profile by ID."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        return None
    return _user_to_profile(user)


async def update_profile(
    db: AsyncSession,
    user_id: uuid.UUID,
    updates: ProfileUpdateRequest,
) -> ProfileResponse | None:
    """Update user profile fields (only non-None values)."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        return None

    # Apply updates — only set fields that were explicitly provided
    update_data = updates.model_dump(exclude_unset=True)

    if "name" in update_data and update_data["name"] is not None:
        user.name = update_data["name"]
    if "bio" in update_data:
        user.bio = update_data["bio"]
    if "birth_date" in update_data:
        if update_data["birth_date"]:
            user.birth_date = date.fromisoformat(update_data["birth_date"])
        else:
            user.birth_date = None
    if "country" in update_data:
        user.country = update_data["country"]
    if "occupation" in update_data:
        user.occupation = update_data["occupation"]
    if "profile_photo_url" in update_data:
        user.profile_photo_url = update_data["profile_photo_url"]
    if "timezone" in update_data:
        user.timezone = update_data["timezone"]

    # Manually touch updated_at
    user.updated_at = datetime.utcnow()

    await db.flush()
    logger.info(f"Updated profile for user {user_id}: {list(update_data.keys())}")

    return _user_to_profile(user)
