"""Draft Router — save and retrieve code drafts (autosave)."""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..schemas.draft import DraftResponse, DraftUpsertRequest
from ..services.draft_service import get_draft, upsert_draft

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/drafts", tags=["drafts"])





@router.put("", response_model=DraftResponse)
async def save_draft(
    payload: DraftUpsertRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Upsert a code draft (one per user+problem+language)."""
    try:
        problem_uuid = uuid.UUID(payload.problem_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid problem_id") from None

    try:
        draft = await upsert_draft(db, user_id, problem_uuid, payload.language, payload.source_code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return DraftResponse(
        id=str(draft.id),
        problem_id=str(draft.problem_id),
        language=draft.language,
        source_code=draft.source_code,
        updated_at=draft.updated_at.isoformat(),
    )


@router.get("")
async def load_draft(
    problem_id: str = Query(...),
    language: str = Query(default="Python"),
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get the current draft for a problem+language."""
    try:
        problem_uuid = uuid.UUID(problem_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid problem_id") from None

    try:
        draft = await get_draft(db, user_id, problem_uuid, language)
    except Exception as e:
        logger.error("Failed to load draft: %s", e)
        raise HTTPException(status_code=500, detail="Failed to load draft") from e

    if draft is None:
        return {"draft": None}
    return {
        "draft": DraftResponse(
            id=str(draft.id),
            problem_id=str(draft.problem_id),
            language=draft.language,
            source_code=draft.source_code,
            updated_at=draft.updated_at.isoformat(),
        )
    }
