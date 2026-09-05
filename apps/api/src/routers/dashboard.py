"""
Dashboard Router

One endpoint returning the user's progress, the problem list and the next
problem to attempt — all in a single call.

GET /v1/dashboard

WHAT CHANGED WHEN COURSES WERE REMOVED

This used to load published `Course` rows with their problems and return a
course-shaped tree. Problems now carry a `categories` array instead, so the
response is a flat problem list plus per-category counts.

CATEGORY COUNTS INTENTIONALLY OVERLAP. A problem tagged both DL and LLM counts
once in each, so summing `categories[].total` will exceed `total_problems`.
That is correct — they answer different questions ("how much DL is there"
versus "how many problems are there") — and any UI that adds the category
totals together to get a grand total is reading them wrong.
"""

import logging
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import identity
from ..database import get_db
from ..models.problem import Problem
from ..models.submission import Submission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/dashboard", tags=["dashboard"])


# The closed vocabulary, in display order.
#
# Declared here rather than derived from whatever the problems happen to carry,
# for two reasons: the order is deliberate (concept → modality → toolchain, not
# alphabetical), and a typo in a seed file should surface as an empty category
# rather than silently inventing a new one in the UI.
CATEGORY_ORDER = ["ML", "DL", "LLM", "VLM", "CUDA", "PyTorch", "TensorFlow"]




@router.get("")
async def get_dashboard(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Return aggregated dashboard data: problems, categories and progress."""

    # `origin == "curriculum"` excludes the problems rows owned by interview
    # questions. They are executed and graded by the same pipeline, so their
    # accepted submissions land in the same table — but they are not curriculum,
    # and counting them would inflate the progress ring and let "next unsolved
    # problem" point at an interview question.
    #
    # Only this query needs the filter. `accepted_problem_ids` below is
    # deliberately left unfiltered: it is intersected against these rows by id,
    # so an interview submission simply never matches. Filtering both would be
    # one more place to keep in step for no gain.
    problems_result = await db.execute(
        select(Problem)
        .where(
            Problem.is_published == True,  # noqa: E712 — SQLAlchemy needs ==
            Problem.origin == "curriculum",
        )
        .order_by(Problem.order_index)
    )
    problems = list(problems_result.scalars().all())

    accepted_result = await db.execute(
        select(Submission.problem_id).where(
            Submission.user_id == user_id,
            Submission.status == "accepted",
        )
    )
    accepted_problem_ids = set(accepted_result.scalars().all())

    problems_data = []
    current_question = None

    for problem in problems:
        is_solved = problem.id in accepted_problem_ids

        problems_data.append({
            "id": str(problem.id),
            "slug": problem.slug,
            "title": problem.title,
            "difficulty": problem.difficulty,
            "categories": problem.categories or [],
            "order_index": problem.order_index,
            "is_solved": is_solved,
        })

        # First unsolved problem in curriculum order. `order_index` is 1-based
        # and matches the `/problems/N` route, so the client links straight to
        # it without a lookup.
        if not is_solved and current_question is None:
            desc = problem.description or ""
            current_question = {
                "order_index": problem.order_index,
                "title": problem.title,
                "description_preview": desc[:200] + ("..." if len(desc) > 200 else ""),
                "problem_slug": problem.slug,
                "categories": problem.categories or [],
            }

    # Per-category counts, built from CATEGORY_ORDER so the response shape is
    # stable even before any problem carries a given tag — the UI renders a
    # consistent filter row rather than one that reflows as content is seeded.
    categories_data = [
        {
            "name": name,
            "total": len(tagged),
            "solved": sum(1 for p in tagged if p["is_solved"]),
        }
        for name, tagged in (
            (name, [p for p in problems_data if name in p["categories"]])
            for name in CATEGORY_ORDER
        )
    ]

    return {
        "problems": problems_data,
        "categories": categories_data,
        "current_question": current_question,
        "total_problems": len(problems_data),
        "solved_problems": sum(1 for p in problems_data if p["is_solved"]),
    }
