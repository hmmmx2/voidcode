"""
Code Execution Router

Provides endpoints for running and submitting code via Judge0.
- POST /v1/execute  — single code run (Run button)
- POST /v1/submit   — run against all test cases (Submit button)
- GET  /v1/submissions — list recent submissions for a problem
"""

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import identity, ratelimit
from ..database import AsyncSessionLocal
from ..models.problem import Problem, TestCase
from ..services.judge0_client import judge0_client
from ..services.submission_service import (
    get_submissions,
    save_submission,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["execution"])


# ── Request Models ──────────────────────────────────────────────

class ExecuteRequestModel(BaseModel):
    """
    The Run button. Executes once against caller-supplied stdin and grades
    nothing, which is why it has no `expected_output` field.

    It used to have one. It was never read — `execute_code` passed only `stdin`
    to Judge0 — and the web client never sent it. A dead field named
    `expected_output`, one line away from a `judge0_client.submit` call that
    accepts the same keyword, is an invitation to reintroduce client-side
    grading. Removed deliberately; do not add it back. Grading lives in
    /v1/submit and reads from the database.
    """

    source_code: str
    language_id: int
    stdin: str | None = None
    cpu_time_limit: float | None = Field(default=5, ge=1, le=15)
    memory_limit: int | None = Field(default=256000, ge=1024, le=512000)


class SubmitRequestModel(BaseModel):
    """
    The Submit button.

    `problem_id` is the ONLY grading input the client supplies. Test cases,
    their stdin and their expected outputs are all loaded server-side.

    This model used to carry a `test_cases: List[SubmitTestCaseModel]` where
    each entry included `expected_output`, and the server graded against those
    values. Anyone could POST their own expected outputs and be marked correct;
    an empty list was graded as a pass, because `passed == len(test_cases)` is
    `0 == 0`. Both are fixed, and `extra="forbid"` is what keeps them fixed: a
    stale client still sending `test_cases` gets a loud 422 rather than being
    quietly graded correctly by a path that no longer reads the field.
    """

    model_config = {"extra": "forbid"}

    source_code: str
    language_id: int
    problem_id: str                    # UUID string. Required.
    cpu_time_limit: float | None = Field(default=5, ge=1, le=15)
    memory_limit: int | None = Field(default=256000, ge=1024, le=512000)
    language: str | None = None     # "Python", "JavaScript", etc.


# ── Response Models ─────────────────────────────────────────────

class ExecutionResultModel(BaseModel):
    stdout: str | None = None
    stderr: str | None = None
    compile_output: str | None = None
    status_id: int
    status_description: str
    time: str | None = None
    memory: int | None = None
    exit_code: int | None = None


class TestCaseResultModel(BaseModel):
    test_case_id: str
    label: str = ""
    is_hidden: bool = False
    passed: bool
    execution_result: ExecutionResultModel
    # Optional because a hidden case's expected output is redacted before it
    # reaches the client. Internally it is always populated.
    expected_output: str | None = None
    actual_output: str | None = None


class SubmissionResultModel(BaseModel):
    total_tests: int
    passed_tests: int
    all_passed: bool
    test_case_results: list[TestCaseResultModel]
    overall_time: str | None = None
    overall_memory: int | None = None


# ── Submission list response ────────────────────────────────────

class SubmissionSummaryModel(BaseModel):
    id: str
    status: str
    language: str
    total_tests: int
    passed_tests: int
    overall_runtime_ms: float | None = None
    overall_memory_kb: int | None = None
    created_at: str
    source_code: str | None = None


class SubmissionListResponse(BaseModel):
    submissions: list[SubmissionSummaryModel]


# ── Grading primitives ──────────────────────────────────────────
#
# These are pure and separately unit-tested, deliberately. Every defect this
# module has had lived in one of them, and each was invisible inside the
# request handler: `0 == 0` reading as a pass, an expected value arriving from
# the caller, a hidden input echoed back through stdout. Pure functions can be
# asserted on directly, with no database and no Judge0.


def normalize_output(value: str | None) -> str:
    """
    Canonical form for comparing program output.

    Trailing whitespace is noise: it depends on the author's editor, and a
    Windows-authored seed file carries `\\r\\n` that no learner can see or fix.
    Everything else is significant.

    The second half of that sentence is the load-bearing half. It is tempting
    to "fix" flaky comparisons by stripping harder, and the end state of that
    is `[0, 1]` comparing equal to `[0,1]` — at which point the platform is
    accepting wrong answers. `test_internal_whitespace_is_significant` exists
    to make loosening this a test failure rather than a judgement call.
    """
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).rstrip("\n")


def outputs_match(actual: str | None, expected: str | None) -> bool:
    """Compare one program's output against the expected output."""
    return normalize_output(actual) == normalize_output(expected)


ACCEPTED_STATUS_ID = 3  # Judge0 "Accepted" — the process ran to completion


def case_passed(status_id: int | None, actual: str | None,
                expected: str | None) -> bool:
    """
    A case passes only if the program *ran* and its output matches.

    The status check is not redundant. A program killed by the time limit can
    still have flushed matching output before it was killed, and a program that
    prints the right answer and then segfaults is not a correct solution.
    """
    return status_id == ACCEPTED_STATUS_ID and outputs_match(actual, expected)


def build_submission_result(
    test_case_results: list[TestCaseResultModel],
    overall_time: str | None = None,
    overall_memory: int | None = None,
) -> "SubmissionResultModel":
    """
    Aggregate per-case results into the submission verdict.

    `total > 0` is the whole point of this function existing. The previous
    expression was `passed_count == len(request.test_cases)`, which for an
    empty list is `0 == 0` — so a submission with no test cases was recorded as
    accepted. The router now refuses an empty set with a 409 before reaching
    here, but that is a *policy* and policies get refactored: a future "only run
    cases matching this language" filter could empty the list again. This is the
    invariant, and it is tested independently of the router.
    """
    total = len(test_case_results)
    passed = sum(1 for r in test_case_results if r.passed)
    return SubmissionResultModel(
        total_tests=total,
        passed_tests=passed,
        all_passed=total > 0 and passed == total,
        test_case_results=test_case_results,
        overall_time=overall_time,
        overall_memory=overall_memory,
    )


def redact_for_response(tcr: TestCaseResultModel) -> TestCaseResultModel:
    """
    Strip everything a hidden case must not reveal, at the response boundary.

    WHAT IS REMOVED, AND WHY EACH ONE

    `expected_output` — the answer. Obvious, and the least important of the three.

    `stdout` / `actual_output` — the *input*. This is the one that gets missed.
    Submit `print(sys.stdin.read())` and the hidden case's stdin comes straight
    back in `actual_output`; the learner then hardcodes against it. Redacting
    the expected answer while echoing the input defeats the entire exercise.

    `stderr` — the input again, by another route. Tracebacks quote the values
    that caused them: `ValueError: invalid literal for int() with base 10:
    '<hidden input>'`.

    WHAT IS DELIBERATELY KEPT

    `compile_output` is produced before the program runs, so it cannot contain
    stdin. Keeping it lets the tutor explain a compile error on a hidden case,
    which is genuinely useful and costs nothing. Over-redaction here would
    silently degrade the product with no security benefit —
    `test_hidden_compile_output_preserved` guards that direction.

    `passed` is kept. A one-bit oracle per hidden case is unavoidable in any
    system that reports a score, and it is what every competitive-programming
    judge ships.

    RESPONSE-ONLY. The persistence path stores full fidelity: that data is
    server-side, and per-case expected/actual is exactly what a later analytics
    or mastery phase needs. `test_persisted_expected_output_is_unredacted` pins
    that, so nobody "completes" the redaction by pushing it down into the DB.
    """
    if not tcr.is_hidden:
        return tcr

    return tcr.model_copy(update={
        "expected_output": None,
        "actual_output": None,
        "execution_result": tcr.execution_result.model_copy(update={
            "stdout": None,
            "stderr": None,
        }),
    })


# ── Helper: determine status enum from results ─────────────────

def _determine_status(test_case_results: list[TestCaseResultModel]) -> str:
    """Map Judge0 results to the submission_status_enum."""
    for tcr in test_case_results:
        sid = tcr.execution_result.status_id
        if sid == 6:                      # Compilation Error
            return "compilation_error"
        if sid == 5:                      # Time Limit Exceeded
            return "time_limit_exceeded"
        if sid in (11, 12):               # Runtime Error variants
            return "runtime_error"
        if sid == 13:                     # Internal Error
            return "internal_error"

    # If all ran, check pass/fail
    all_passed = all(tcr.passed for tcr in test_case_results)
    return "accepted" if all_passed else "wrong_answer"


# ── Endpoints ───────────────────────────────────────────────────

@router.post("/execute", response_model=ExecutionResultModel)
async def execute_code(request: ExecuteRequestModel, http_request: Request):
    """
    Execute code once with optional stdin.
    Used by the "Run" button — runs code and returns stdout/stderr.
    """
    # Every call runs untrusted code in a sandbox container. The cost is CPU on the Judge0 workers,
    # so an unthrottled Run button is a denial-of-service surface against everyone else's runs.
    await ratelimit.check_ip(ratelimit.EXECUTE, http_request)

    request_id = f"exec-{int(time.time() * 1000)}"
    logger.info(f"[{request_id}] Execute: lang={request.language_id}")

    try:
        result = await judge0_client.submit(
            source_code=request.source_code,
            language_id=request.language_id,
            stdin=request.stdin,
            cpu_time_limit=request.cpu_time_limit,
            memory_limit=request.memory_limit,
        )
        return ExecutionResultModel(**result)

    except Exception as e:
        logger.exception(f"[{request_id}] Execution failed: {e}")
        raise HTTPException(status_code=502, detail=f"Judge0 error: {e!s}") from e


async def _load_test_cases(db, problem_uuid: uuid.UUID) -> list[TestCase]:
    """
    Load every test case for a published problem — hidden ones included.

    ORDER BY (order_index, id), not order_index alone. `order_index` carries no
    uniqueness constraint, and hidden cases are seeded at 100+ where collisions
    are easy. An unstable sort would not change the verdict, but it would make
    the per-case result list reorder between runs, which reads as flapping in
    the test console and makes submission history impossible to compare.

    An unpublished problem is a 404 rather than a 403: whether unpublished
    content exists is not something the endpoint should confirm.
    """
    problem = (
        await db.execute(
            select(Problem.id).where(
                Problem.id == problem_uuid,
                Problem.is_published.is_(True),
            )
        )
    ).scalar_one_or_none()

    if problem is None:
        raise HTTPException(status_code=404, detail="Problem not found")

    rows = (
        await db.execute(
            select(TestCase)
            .where(TestCase.problem_id == problem_uuid)
            .order_by(TestCase.order_index, TestCase.id)
        )
    ).scalars().all()

    if not rows:
        # Never fall through to grading. Zero cases previously produced
        # all_passed=True; now it is impossible to reach that state at all.
        raise HTTPException(
            status_code=409,
            detail="Problem has no test cases and cannot be graded",
        )

    return list(rows)


@router.post("/submit", response_model=SubmissionResultModel)
async def submit_code(
    request: SubmitRequestModel,
    http_request: Request,
    user_id: uuid.UUID = Depends(identity.current_user_id),
):
    """
    Run code against every test case for a problem and grade it.

    The client sends `problem_id` and nothing else that affects the verdict.
    Test cases, their stdin and their expected outputs are read from the
    database here — see `SubmitRequestModel` for what this replaced.
    """
    # A submit runs every test case, so it is several sandbox containers per call — the most
    # expensive path in the execution router.
    await ratelimit.check_ip(ratelimit.EXECUTE, http_request)

    request_id = f"submit-{int(time.time() * 1000)}"

    try:
        problem_uuid = uuid.UUID(request.problem_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid problem_id UUID") from None

    async with AsyncSessionLocal() as db:
        test_cases = await _load_test_cases(db, problem_uuid)

    logger.info(
        f"[{request_id}] Submit: lang={request.language_id}, "
        f"tests={len(test_cases)} "
        f"({sum(1 for t in test_cases if t.is_hidden)} hidden)"
    )

    test_case_results: list[TestCaseResultModel] = []
    total_time = 0.0
    peak_memory = 0

    for tc in test_cases:
        try:
            # `expected_output` is deliberately NOT passed to Judge0. The
            # comparison happens here, in `case_passed`, against the value read
            # from the database — so the expected answer never leaves this
            # process, and comparison semantics live in exactly one function
            # rather than being split between us and a third-party service.
            result = await judge0_client.submit(
                source_code=request.source_code,
                language_id=request.language_id,
                stdin=tc.stdin,
                cpu_time_limit=request.cpu_time_limit,
                memory_limit=request.memory_limit,
            )

            if result["time"]:
                total_time += float(result["time"])
            if result["memory"]:
                peak_memory = max(peak_memory, result["memory"])

            test_case_results.append(TestCaseResultModel(
                test_case_id=str(tc.id),
                label=tc.label,
                is_hidden=tc.is_hidden,
                passed=case_passed(
                    result["status_id"], result["stdout"], tc.expected_output
                ),
                execution_result=ExecutionResultModel(**result),
                expected_output=tc.expected_output,
                actual_output=result["stdout"],
            ))

        except Exception as e:
            logger.error(f"[{request_id}] Test case {tc.id} failed: {e}")
            test_case_results.append(TestCaseResultModel(
                test_case_id=str(tc.id),
                label=tc.label,
                is_hidden=tc.is_hidden,
                passed=False,
                execution_result=ExecutionResultModel(
                    stdout=None,
                    stderr=str(e),
                    compile_output=None,
                    status_id=13,
                    status_description="Internal Error",
                    time=None,
                    memory=None,
                    exit_code=None,
                ),
                expected_output=tc.expected_output,
                actual_output=None,
            ))

    result_model = build_submission_result(
        test_case_results,
        overall_time=f"{total_time:.3f}" if total_time > 0 else None,
        overall_memory=peak_memory if peak_memory > 0 else None,
    )

    # ── Persist to DB (non-fatal) ─────────────────────────────────
    # Full fidelity, INCLUDING hidden cases' expected and actual output. This is
    # server-side data and it is exactly what a later analytics or mastery phase
    # needs. Redaction happens at the response boundary only — pinned by
    # `test_persisted_expected_output_is_unredacted`, so nobody "completes" the
    # redaction by pushing it down here.
    #
    # `test_case_id` is a real DB UUID now. It was hardcoded `None` for as long
    # as the client supplied the cases, because a client-side id was not a key
    # into anything; the FK on `test_case_results` has never been populated.
    try:
        tc_dicts = [
            {
                "test_case_id": uuid.UUID(tcr.test_case_id),
                "passed": tcr.passed,
                "stdout": tcr.execution_result.stdout,
                "stderr": tcr.execution_result.stderr,
                "compile_output": tcr.execution_result.compile_output,
                "status_id": tcr.execution_result.status_id,
                "status_description": tcr.execution_result.status_description,
                "runtime_ms": (
                    float(tcr.execution_result.time) * 1000
                    if tcr.execution_result.time else None
                ),
                "memory_kb": tcr.execution_result.memory,
                "expected_output": tcr.expected_output,
                "actual_output": tcr.actual_output,
            }
            for tcr in test_case_results
        ]

        async with AsyncSessionLocal() as db:
            await save_submission(
                db=db,
                user_id=user_id,
                problem_id=problem_uuid,
                source_code=request.source_code,
                language=request.language or "Unknown",
                judge0_language_id=request.language_id,
                status=_determine_status(test_case_results),
                total_tests=result_model.total_tests,
                passed_tests=result_model.passed_tests,
                overall_runtime_ms=total_time * 1000 if total_time > 0 else None,
                overall_memory_kb=peak_memory if peak_memory > 0 else None,
                test_case_results=tc_dicts,
            )
    except Exception as e:
        logger.error(f"[{request_id}] Failed to persist submission: {e}")

    # Redact last, so persistence above saw the real values.
    return result_model.model_copy(update={
        "test_case_results": [
            redact_for_response(tcr) for tcr in result_model.test_case_results
        ]
    })


@router.get("/submissions", response_model=SubmissionListResponse)
async def list_submissions(
    problem_id: str = Query(..., description="Problem UUID"),
    user_id: uuid.UUID = Depends(identity.current_user_id),
):
    """Get the 15 most recent submissions for the user + problem."""
    try:
        problem_uuid = uuid.UUID(problem_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid problem_id UUID") from None

    async with AsyncSessionLocal() as db:
        submissions = await get_submissions(db, user_id, problem_uuid)

    return SubmissionListResponse(
        submissions=[
            SubmissionSummaryModel(
                id=str(s.id),
                status=s.status,
                language=s.language,
                total_tests=s.total_tests,
                passed_tests=s.passed_tests,
                overall_runtime_ms=s.overall_runtime_ms,
                overall_memory_kb=s.overall_memory_kb,
                created_at=s.created_at.isoformat(),
                source_code=s.source_code,
            )
            for s in submissions
        ]
    )
