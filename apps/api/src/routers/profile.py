"""
Profile Router — get and update user profile.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..schemas.profile import ProfileResponse, ProfileUpdateRequest
from ..services.profile_service import get_profile, update_profile

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/profile", tags=["profile"])





@router.get("", response_model=ProfileResponse)
async def get_user_profile(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    """Get the current user's profile."""
    profile = await get_profile(db, user_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")
    return profile


@router.put("", response_model=ProfileResponse)
async def update_user_profile(
    payload: ProfileUpdateRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    """Update the current user's profile."""
    profile = await update_profile(db, user_id, payload)
    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")
    return profile
