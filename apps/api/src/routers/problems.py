"""
Problems Router

Provides endpoints for retrieving problem data.
- GET /v1/problems           — list all published problems
- GET /v1/problems/{slug}    — full problem detail with test cases + code templates
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..models.problem import Problem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/problems", tags=["problems"])


@router.get("")
async def list_problems(db: AsyncSession = Depends(get_db)):
    """
    List all published curriculum problems (summary only).

    `origin == "curriculum"` is not optional. Interview questions own a
    `problems` row so they can reuse Judge0 and the grading pipeline unchanged,
    and without this filter all 40 would appear in the problem catalogue and
    shift every problem's position in the navigator.

    `get_problem` below filters too — see the note there. It is the more
    important of the two.
    """
    result = await db.execute(
        select(Problem)
        .where(Problem.is_published.is_(True), Problem.origin == "curriculum")
        .order_by(Problem.order_index)
    )
    problems = result.scalars().all()

    return {
        "problems": [
            {
                "id": str(problem.id),
                "slug": problem.slug,
                "title": problem.title,
                "difficulty": problem.difficulty,
                "categories": problem.categories or [],
                "order_index": problem.order_index,
            }
            for problem in problems
        ]
    }


@router.get("/{slug}")
async def get_problem(slug: str, db: AsyncSession = Depends(get_db)):
    """
    Full problem detail with test cases and code templates.

    CURRICULUM ONLY, AND THIS FILTER IS A SECURITY BOUNDARY, NOT TIDINESS.

    This response includes every visible case's `expected_output`. That is
    correct for the catalogue, where seeing what a passing run looks like is
    part of learning. It is exactly wrong for an interview question, whose whole
    premise is that you find out at submit time.

    Interview questions are served by `GET /v1/interviews/{slug}/workspace`,
    which returns the same shape with `expected_output` nulled. Without the
    filter here, that withholding would be theatre: the answers stay one
    guessable URL away, and the slug is in the page source.
    """
    result = await db.execute(
        select(Problem)
        .where(
            Problem.slug == slug,
            Problem.is_published.is_(True),
            Problem.origin == "curriculum",
        )
        .options(
            selectinload(Problem.test_cases),
            selectinload(Problem.code_templates),
        )
    )
    problem = result.scalar_one_or_none()

    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    return {
        "id": str(problem.id),
        "slug": problem.slug,
        "title": problem.title,
        "difficulty": problem.difficulty,
                "categories": problem.categories or [],
        "description": problem.description,
        "examples": problem.examples,
        "constraints": problem.constraints,
        "hints": problem.hints,
        "order_index": problem.order_index,
        "test_cases": [
            {
                "id": str(tc.id),
                "label": tc.label,
                "inputs": tc.inputs,
                "stdin": tc.stdin,
                "expected_output": tc.expected_output,
                "order_index": tc.order_index,
                "is_hidden": tc.is_hidden,
            }
            for tc in sorted(problem.test_cases, key=lambda t: t.order_index)
            if not tc.is_hidden
        ],
        "code_templates": [
            {
                "id": str(ct.id),
                "language": ct.language,
                "judge0_language_id": ct.judge0_language_id,
                "template_code": ct.template_code,
                "driver_code": ct.driver_code,
            }
            for ct in problem.code_templates
        ],
    }
