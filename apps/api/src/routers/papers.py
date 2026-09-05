"""
Research Papers Router

    GET  /v1/papers                     the library, with this user's progress
    GET  /v1/papers/{slug}              one paper, sections included
    POST /v1/papers/{slug}/read         mark a section read

NOTHING IS WITHHELD HERE, AND THAT IS THE DIFFERENCE FROM INTERVIEWS.

The interview router holds back the model answer because seeing it early
destroys the exercise. A paper breakdown is the opposite: it exists to be read,
and gating it behind a reveal would be ceremony with no pedagogy behind it. So
the detail response carries all four sections and the client renders them.

Progress is "which sections have you read", because that is the only thing about
reading a paper this platform can honestly measure. It cannot know whether you
understood it, and a percentage that implies otherwise would be a lie told in a
progress ring.
"""

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..models.catalogue import Paper, PaperProgress

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/papers", tags=["papers"])


# Fixed order, fixed keys. The UI renders exactly these four tabs, in this
# sequence: what it is, what you type, what it costs, why it works.
SECTION_ORDER = ["architecture", "implementation", "systems", "mathematics"]
SECTION_LABELS = {
    "architecture": "Architecture",
    "implementation": "Implementation",
    "systems": "System design",
    "mathematics": "Mathematics",
}




class ReadRequest(BaseModel):
    # Constrained to the four known keys so a client cannot inflate its own
    # progress by posting arbitrary strings into the array.
    section: str = Field(pattern="^(architecture|implementation|systems|mathematics)$")


def _summary(paper: Paper, progress: PaperProgress | None) -> dict:
    read = list(progress.sections_read) if progress else []
    return {
        "slug": paper.slug,
        "title": paper.title,
        "authors": paper.authors,
        "year": paper.year,
        "venue": paper.venue,
        "arxivId": paper.arxiv_id,
        "abstract": paper.abstract,
        "difficulty": paper.difficulty,
        "categories": paper.categories,
        "orderIndex": paper.order_index,
        "relatedProblemSlugs": paper.related_problem_slugs,
        "sectionsRead": read,
        "sectionCount": len(SECTION_ORDER),
        "completedAt": progress.completed_at.isoformat()
        if progress and progress.completed_at
        else None,
    }


async def _progress_by_paper(
    db: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, PaperProgress]:
    rows = await db.execute(
        select(PaperProgress).where(PaperProgress.user_id == user_id)
    )
    return {p.paper_id: p for p in rows.scalars()}


@router.get("")
async def list_papers(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    The whole library in one response.

    No pagination and no section bodies: the library is a handful of papers, and
    the summary omits `sections`, which is the only large field. Sending the
    full breakdowns for every paper on the index page would be megabytes to
    render a list of cards.
    """
    result = await db.execute(
        select(Paper)
        .where(Paper.is_published.is_(True))
        .order_by(Paper.order_index)
    )
    papers = list(result.scalars())
    progress = await _progress_by_paper(db, user_id)

    summaries = [_summary(p, progress.get(p.id)) for p in papers]
    total_sections = len(papers) * len(SECTION_ORDER)
    sections_read = sum(len(s["sectionsRead"]) for s in summaries)

    return {
        "papers": summaries,
        "sections": [
            {"key": k, "label": SECTION_LABELS[k]} for k in SECTION_ORDER
        ],
        "progress": {
            "papers": len(papers),
            "finished": len([s for s in summaries if s["completedAt"]]),
            "sectionsRead": sections_read,
            "sectionsTotal": total_sections,
        },
    }


async def _load(db: AsyncSession, slug: str) -> Paper:
    result = await db.execute(
        select(Paper).where(Paper.slug == slug, Paper.is_published.is_(True))
    )
    paper = result.scalar_one_or_none()
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


@router.get("/{slug}")
async def get_paper(
    slug: str,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """One paper, with every section body."""
    paper = await _load(db, slug)
    progress = (await _progress_by_paper(db, user_id)).get(paper.id)

    return {
        **_summary(paper, progress),
        "pdfUrl": paper.pdf_url,
        "keyEquations": paper.key_equations,
        "sections": [
            {
                "key": key,
                "label": SECTION_LABELS[key],
                "body": (paper.sections or {}).get(key, ""),
            }
            for key in SECTION_ORDER
        ],
    }


@router.post("/{slug}/read")
async def mark_section_read(
    slug: str,
    body: ReadRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Record that a section has been read. Idempotent.

    `completed_at` is set the moment all four are read and then never moved, so
    it means "when you first finished this", not "when you last touched it".
    """
    paper = await _load(db, slug)

    result = await db.execute(
        select(PaperProgress).where(
            PaperProgress.user_id == user_id,
            PaperProgress.paper_id == paper.id,
        )
    )
    progress = result.scalar_one_or_none()
    if progress is None:
        progress = PaperProgress(
            user_id=user_id, paper_id=paper.id, sections_read=[]
        )
        db.add(progress)

    # Reassign rather than append: SQLAlchemy does not track in-place mutation
    # of a JSON column, so `.append()` here would be a silent no-op that only
    # shows up as progress that never advances.
    if body.section not in progress.sections_read:
        progress.sections_read = [*list(progress.sections_read), body.section]

    if (
        len(progress.sections_read) >= len(SECTION_ORDER)
        and progress.completed_at is None
    ):
        progress.completed_at = datetime.utcnow()

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Unknown user") from None

    await db.refresh(progress)
    return {
        "slug": paper.slug,
        "sectionsRead": progress.sections_read,
        "completedAt": progress.completed_at.isoformat()
        if progress.completed_at
        else None,
    }
