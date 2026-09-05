"""Draft service — upsert and retrieve code drafts."""

import logging
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.draft import CodeDraft

logger = logging.getLogger(__name__)


async def upsert_draft(
    db: AsyncSession,
    user_id: uuid.UUID,
    problem_id: uuid.UUID,
    language: str,
    source_code: str,
) -> CodeDraft:
    """Insert or update a code draft (one per user+problem+language)."""
    try:
        stmt = pg_insert(CodeDraft).values(
            user_id=user_id,
            problem_id=problem_id,
            language=language,
            source_code=source_code,
            updated_at=datetime.utcnow(),
        ).on_conflict_do_update(
            constraint="uq_draft_user_problem_lang",
            set_={
                "source_code": source_code,
                "updated_at": datetime.utcnow(),
            },
        )
        await db.execute(stmt)
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        error_msg = str(e.orig) if e.orig else str(e)
        logger.error("Draft upsert integrity error: %s", error_msg)
        raise ValueError(f"Invalid reference: {error_msg}") from e
    except SQLAlchemyError as e:
        await db.rollback()
        logger.error("Draft upsert database error: %s", e)
        raise RuntimeError("Database error during draft save") from e

    # Return the upserted row
    result = await db.execute(
        select(CodeDraft).where(
            CodeDraft.user_id == user_id,
            CodeDraft.problem_id == problem_id,
            CodeDraft.language == language,
        )
    )
    return result.scalar_one()


async def get_draft(
    db: AsyncSession,
    user_id: uuid.UUID,
    problem_id: uuid.UUID,
    language: str,
) -> CodeDraft | None:
    """Get the current draft for a user+problem+language."""
    result = await db.execute(
        select(CodeDraft).where(
            CodeDraft.user_id == user_id,
            CodeDraft.problem_id == problem_id,
            CodeDraft.language == language,
        )
    )
    return result.scalar_one_or_none()
