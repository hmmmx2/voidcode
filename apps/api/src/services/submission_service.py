"""Submission persistence — save, retrieve, and prune submissions."""

import logging
import uuid

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.submission import Submission, TestCaseResult
from ..services.notification_service import create_notification

logger = logging.getLogger(__name__)

DEFAULT_USER_ID = uuid.UUID("00000000-0000-4000-a000-000000000001")

MAX_SUBMISSIONS_PER_PROBLEM = 15


# ── Save a submission + test results ──────────────────────────────

async def save_submission(
    db: AsyncSession,
    user_id: uuid.UUID,
    problem_id: uuid.UUID,
    source_code: str,
    language: str,
    judge0_language_id: int,
    status: str,
    total_tests: int,
    passed_tests: int,
    overall_runtime_ms: float | None,
    overall_memory_kb: int | None,
    test_case_results: list[dict],
) -> Submission:
    """Create a Submission row with child TestCaseResult rows, then prune old ones."""

    submission = Submission(
        user_id=user_id,
        problem_id=problem_id,
        source_code=source_code,
        language=language,
        judge0_language_id=judge0_language_id,
        status=status,
        total_tests=total_tests,
        passed_tests=passed_tests,
        overall_runtime_ms=overall_runtime_ms,
        overall_memory_kb=overall_memory_kb,
    )
    db.add(submission)
    await db.flush()  # Get submission.id

    for tcr in test_case_results:
        tc_result = TestCaseResult(
            submission_id=submission.id,
            test_case_id=tcr.get("test_case_id"),
            passed=tcr["passed"],
            stdout=tcr.get("stdout"),
            stderr=tcr.get("stderr"),
            compile_output=tcr.get("compile_output"),
            status_id=tcr["status_id"],
            status_description=tcr["status_description"],
            runtime_ms=tcr.get("runtime_ms"),
            memory_kb=tcr.get("memory_kb"),
            expected_output=tcr["expected_output"],
            actual_output=tcr.get("actual_output"),
        )
        db.add(tc_result)

    await db.commit()

    # Prune old submissions beyond the limit
    await prune_submissions(db, user_id, problem_id)

    # ── Auto-create notification for submission result ─────────────
    try:
        if status == "accepted":
            await create_notification(
                db, user_id,
                type="submission_accepted",
                title="All Tests Passed!",
                message=f"Your submission passed all {total_tests} test cases.",
                reference_id=str(problem_id),
            )
        else:
            await create_notification(
                db, user_id,
                type="submission_failed",
                title="Submission Needs Work",
                message=f"Your submission passed {passed_tests}/{total_tests} test cases. Keep trying!",
                reference_id=str(problem_id),
            )
        await db.commit()
    except Exception as e:
        logger.warning(f"Failed to create submission notification: {e}")

    logger.info(
        f"Saved submission {submission.id} for problem {problem_id}: "
        f"{passed_tests}/{total_tests} ({status})"
    )
    return submission


# ── Prune old submissions beyond the limit ────────────────────────

async def prune_submissions(
    db: AsyncSession,
    user_id: uuid.UUID,
    problem_id: uuid.UUID,
) -> int:
    """Delete the oldest submissions beyond MAX_SUBMISSIONS_PER_PROBLEM.
    Returns number of deleted submissions."""

    # Get all submission IDs ordered by newest first
    result = await db.execute(
        select(Submission.id)
        .where(
            Submission.user_id == user_id,
            Submission.problem_id == problem_id,
        )
        .order_by(Submission.created_at.desc())
    )
    all_ids = [row[0] for row in result.all()]

    if len(all_ids) <= MAX_SUBMISSIONS_PER_PROBLEM:
        return 0

    # IDs to delete (beyond the limit)
    ids_to_delete = all_ids[MAX_SUBMISSIONS_PER_PROBLEM:]

    await db.execute(
        sa_delete(Submission).where(Submission.id.in_(ids_to_delete))
    )
    await db.commit()

    logger.info(f"Pruned {len(ids_to_delete)} old submission(s) for problem {problem_id}")
    return len(ids_to_delete)


# ── Retrieve recent submissions ───────────────────────────────────

async def get_submissions(
    db: AsyncSession,
    user_id: uuid.UUID,
    problem_id: uuid.UUID,
    limit: int = MAX_SUBMISSIONS_PER_PROBLEM,
) -> list[Submission]:
    """Get the most recent submissions for a user+problem, newest first."""

    result = await db.execute(
        select(Submission)
        .where(
            Submission.user_id == user_id,
            Submission.problem_id == problem_id,
        )
        .order_by(Submission.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())
