"""
Elite Interview Router

    GET  /v1/interviews              list + facet counts + this user's progress
    GET  /v1/interviews/{slug}       the prompt, and nothing that answers it
    POST /v1/interviews/{slug}/reveal  exchange a stage for its content
    PUT  /v1/interviews/{slug}/attempt save a self-rating and notes

THE ANSWER IS NOT IN THE DETAIL RESPONSE, AND THAT IS THE WHOLE DESIGN.

The page reveals the approach, then the model answer, then the follow-ups. If
the detail endpoint returned all of it, that sequence would be theatre — one
network tab and the exercise is over. Since the point of the module is to make
you attempt the answer before seeing it, the disclosure has to be enforced where
it cannot be inspected away, which means the server.

It also makes `revealed_answer` mean something. A self-rating of "solid" from
someone who never asked for the answer is a different signal from the same
rating after reading it, and that distinction only exists if the reveal is a
request rather than a CSS class.

Facet counts are computed over the *unfiltered* set on purpose — see the note on
`_facets`.
"""

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import config, identity
from ..database import get_db
from ..models.catalogue import InterviewAttempt, InterviewQuestion
from ..models.problem import Problem
from ..models.submission import Submission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/interviews", tags=["interviews"])


# Display order, not alphabetical: foundations first, then modality, then
# systems. Declared here so the UI never has to derive an order from whatever
# the rows happen to contain.
DOMAIN_ORDER = ["ml", "dl", "maths", "llm", "vlm", "cuda"]
DOMAIN_LABELS = {
    "ml": "Machine Learning",
    "dl": "Deep Learning",
    "maths": "Mathematics",
    "llm": "LLM",
    "vlm": "VLM",
    "cuda": "CUDA & Systems",
}
COMPANY_ORDER = ["Meta", "OpenAI", "Anthropic", "Google DeepMind", "NVIDIA"]
DIFFICULTY_ORDER = ["easy", "medium", "hard"]

# What the candidate physically does. Ordered by how most people revise:
# the maths, then the sizing, then the whiteboard code.
KIND_ORDER = ["derivation", "computation", "code"]
KIND_LABELS = {
    "derivation": "Derivation",
    "computation": "Computation",
    "code": "Code",
}




class RevealRequest(BaseModel):
    # Two stages, because the page reveals the shape of a good answer before the
    # answer itself. `follow_ups` and `red_flags` ride along with the answer:
    # they are commentary on it and are meaningless before it.
    stage: str = Field(pattern="^(approach|answer)$")


class AttemptRequest(BaseModel):
    # 1 = could not answer, 2 = shaky, 3 = solid. Bounded here as well as in the
    # model docstring so a client cannot write a 7 and skew every average.
    self_rating: int | None = Field(default=None, ge=1, le=3)
    notes: str | None = Field(default=None, max_length=10_000)
    # Client-reported. Bounded at 24h so a clock skew or a tab left open over a
    # weekend cannot write a nonsense number; `ge=0` because a negative elapsed
    # time is always a bug, never a value worth storing.
    elapsed_seconds: int | None = Field(default=None, ge=0, le=86_400)


def _preview(prompt: str, limit: int = 150) -> str:
    """
    A one-line taste of the prompt, for the catalogue cards.

    Safe to send with the list: the prompt is the *question*, which the detail
    page shows unprompted anyway. What is withheld is `approach` and
    `model_answer`, and neither can be reconstructed from this.

    Cut on a word boundary — a card ending "the interpol" reads as a rendering
    bug rather than as truncation.
    """
    flat = " ".join(prompt.split())
    if len(flat) <= limit:
        return flat
    cut = flat.rfind(" ", 0, limit)
    return flat[: cut if cut > 0 else limit].rstrip(",;:") + "…"


def _summary(question: InterviewQuestion, attempt: InterviewAttempt | None) -> dict:
    return {
        "slug": question.slug,
        "title": question.title,
        "promptPreview": _preview(question.prompt),
        "domain": question.domain,
        "domainLabel": DOMAIN_LABELS.get(question.domain, question.domain),
        "kind": question.kind,
        "kindLabel": KIND_LABELS.get(question.kind, question.kind),
        "difficulty": question.difficulty,
        "companies": question.companies,
        "categories": question.categories,
        "orderIndex": question.order_index,
        "selfRating": attempt.self_rating if attempt else None,
        "revealedAnswer": bool(attempt.revealed_answer) if attempt else False,
        "attempted": attempt is not None,
        # Whether an executable form exists yet. The catalogue uses this to
        # decide where a card links — the IDE, or the read-only view — so a
        # question part-way through Phase 2 authoring degrades instead of
        # landing the user on a 409.
        "hasWorkspace": question.problem_id is not None,
        "solved": bool(attempt.submitted_at) if attempt else False,
    }


def _facets(questions: list[InterviewQuestion]) -> dict:
    """
    Counts over every published question, not over the filtered result.

    Deliberate: a facet count that shrinks as you filter cannot tell you what
    selecting it would give you, and a facet showing 0 that you can still click
    is worse than one that never moves. These are "how much CUDA exists", which
    is a fixed property of the bank.
    """
    domains, companies, difficulties, kinds = {}, {}, {}, {}
    for q in questions:
        domains[q.domain] = domains.get(q.domain, 0) + 1
        difficulties[q.difficulty] = difficulties.get(q.difficulty, 0) + 1
        kinds[q.kind] = kinds.get(q.kind, 0) + 1
        for company in q.companies:
            companies[company] = companies.get(company, 0) + 1

    return {
        "domains": [
            {"key": d, "label": DOMAIN_LABELS[d], "total": domains.get(d, 0)}
            for d in DOMAIN_ORDER
        ],
        "companies": [
            {"key": c, "label": c, "total": companies.get(c, 0)}
            for c in COMPANY_ORDER
        ],
        "difficulties": [
            {"key": d, "label": d.title(), "total": difficulties.get(d, 0)}
            for d in DIFFICULTY_ORDER
        ],
        "kinds": [
            {"key": k, "label": KIND_LABELS[k], "total": kinds.get(k, 0)}
            for k in KIND_ORDER
        ],
    }


async def _commit(db: AsyncSession) -> None:
    """
    Commit, turning an unknown user into a 400 rather than a 500.

    `X-User-Id` is client-supplied, so a syntactically valid UUID that matches
    no row is a request anyone can make. Both write paths insert an
    `interview_attempts` row keyed on it, so without this the header alone
    produces a foreign-key violation and a stack trace — an uninformative 500
    for a request that is simply malformed.

    This is not authentication and does not pretend to be: it converts a bad
    identifier into a clear error. Verifying that the caller *is* that user is
    the separate, still-open X-User-Id trust problem.
    """
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Unknown user") from None


async def _attempts_by_question(
    db: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, InterviewAttempt]:
    rows = await db.execute(
        select(InterviewAttempt).where(InterviewAttempt.user_id == user_id)
    )
    return {a.question_id: a for a in rows.scalars()}


@router.get("")
async def list_questions(
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Every published question, unfiltered.

    Filtering is not a query parameter here because the whole bank is 40 rows —
    a few hundred KB of summaries with no answer text. Sending it once lets the
    client filter instantly and keeps filter state in the URL without a request
    per keystroke. If this grew past a few hundred questions it would need to
    move server-side, and that is the signal to watch for.
    """
    result = await db.execute(
        select(InterviewQuestion)
        .where(InterviewQuestion.is_published.is_(True))
        .order_by(InterviewQuestion.order_index)
    )
    questions = list(result.scalars())
    attempts = await _attempts_by_question(db, user_id)

    summaries = [_summary(q, attempts.get(q.id)) for q in questions]
    rated = [s for s in summaries if s["selfRating"] is not None]

    return {
        "questions": summaries,
        "facets": _facets(questions),
        "progress": {
            "total": len(summaries),
            "attempted": len(rated),
            # "Solid" only. Counting shaky answers as progress would make the
            # ring flattering and useless, which defeats the point of an honest
            # self-assessment.
            "solid": len([s for s in rated if s["selfRating"] == 3]),
        },
    }


async def _load(db: AsyncSession, slug: str) -> InterviewQuestion:
    result = await db.execute(
        select(InterviewQuestion).where(
            InterviewQuestion.slug == slug,
            InterviewQuestion.is_published.is_(True),
        )
    )
    question = result.scalar_one_or_none()
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    return question


@router.get("/{slug}")
async def get_question(
    slug: str,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """The prompt and the user's own state. No approach, no answer."""
    question = await _load(db, slug)
    attempts = await _attempts_by_question(db, user_id)
    attempt = attempts.get(question.id)

    return {
        **_summary(question, attempt),
        "prompt": question.prompt,
        "notes": attempt.notes if attempt else None,
    }


@router.get("/{slug}/workspace")
async def get_workspace(
    slug: str,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Everything the IDE needs to open this question — and nothing that answers it.

    TEST CASES COME BACK WITHOUT `expected_output`, AND THAT IS THE FEATURE.

    The problems catalogue ships expected outputs to the browser so you can see
    what a passing run looks like. An interview screen does not work that way:
    you write against the written spec, and you find out whether you were right
    when you submit. Nulling the field here rather than hiding it in the UI is
    what makes that real — otherwise the answer is one devtools tab away, which
    is the same mistake the staged reveal exists to avoid.

    `stdin` is still sent. Run needs something to execute against, and the input
    is part of the question; only the answer is withheld.

    Opening also starts the timer, once. See `started_at` on the attempt.
    """
    result = await db.execute(
        select(InterviewQuestion)
        .where(
            InterviewQuestion.slug == slug,
            InterviewQuestion.is_published.is_(True),
        )
        .options(
            selectinload(InterviewQuestion.problem).selectinload(Problem.test_cases),
            selectinload(InterviewQuestion.problem).selectinload(
                Problem.code_templates
            ),
        )
    )
    question = result.scalar_one_or_none()
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")

    problem = question.problem
    if problem is None:
        # Authored but not yet made executable. A distinct code from 404 so the
        # client can say "not ready yet" rather than "does not exist".
        raise HTTPException(
            status_code=409, detail="This question has no executable form yet"
        )

    attempt = (await _attempts_by_question(db, user_id)).get(question.id)

    # Start the clock on first open and never restart it. Reopening the tab
    # tomorrow should not reset how long the question took you.
    if attempt is None:
        attempt = InterviewAttempt(
            user_id=user_id, question_id=question.id, started_at=datetime.utcnow()
        )
        db.add(attempt)
        await _commit(db)
    elif attempt.started_at is None:
        attempt.started_at = datetime.utcnow()
        await _commit(db)

    return {
        **_summary(question, attempt),
        "prompt": question.prompt,
        "notes": attempt.notes,
        "elapsedSeconds": attempt.elapsed_seconds,
        "submittedAt": attempt.submitted_at.isoformat()
        if attempt.submitted_at
        else None,
        "problem": {
            "id": str(problem.id),
            "slug": problem.slug,
            "title": question.title,
            "difficulty": problem.difficulty,
            "categories": problem.categories or [],
            "description": problem.description,
            "examples": problem.examples,
            "constraints": problem.constraints,
            # Hints are withheld for the same reason as the approach: they are a
            # graded-conditions giveaway, and the reveal panel already offers a
            # deliberate way to ask for help.
            "hints": [],
            "order_index": problem.order_index,
        },
        "testCases": [
            {
                "id": str(tc.id),
                "label": tc.label,
                "inputs": tc.inputs,
                "stdin": tc.stdin,
                "expected_output": None,  # withheld — see the docstring
                "order_index": tc.order_index,
                "is_hidden": tc.is_hidden,
            }
            for tc in sorted(problem.test_cases, key=lambda t: t.order_index)
            if not tc.is_hidden
        ],
        "codeTemplates": [
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


@router.post("/{slug}/reveal")
async def reveal(
    slug: str,
    body: RevealRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Exchange a stage for its content, and record that it happened.

    Revealing creates an attempt row if there is none. That is intentional: it
    means "looked at the answer" is recorded even for a user who never rates
    themselves, which is exactly the case a progress number would otherwise
    flatter.
    """
    question = await _load(db, slug)

    if body.stage == "approach":
        return {"stage": "approach", "approach": question.approach}

    result = await db.execute(
        select(InterviewAttempt).where(
            InterviewAttempt.user_id == user_id,
            InterviewAttempt.question_id == question.id,
        )
    )
    attempt = result.scalar_one_or_none()
    if attempt is None:
        attempt = InterviewAttempt(
            user_id=user_id, question_id=question.id, revealed_answer=True
        )
        db.add(attempt)
    else:
        attempt.revealed_answer = True

    await _commit(db)

    return {
        "stage": "answer",
        "modelAnswer": question.model_answer,
        "followUps": question.follow_ups,
        "redFlags": question.red_flags,
    }


class AssessRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=10_000)


@router.post("/{slug}/assess")
async def assess_answer(
    slug: str,
    body: AssessRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Have the tutor mark a written answer against the model answer.

    THE MODEL ANSWER NEVER LEAVES THE SERVER, AND THAT IS THE POINT.

    The obvious implementation sends the model answer to the browser and lets
    the existing tutor panel compare locally. That would undo the whole staged
    reveal in one step: the answer would sit in a network response for every
    question the moment you opened it, whether or not you asked to see it.

    So the grading prompt is assembled here, the comparison happens here, and
    what comes back is a verdict plus feedback. The answer text itself is only
    ever returned by `POST /reveal`, which records that you asked.

    DOES NOT GO THROUGH `/v1/chat/completions`, AND THAT IS A BUG FIX.

    The first version did, and produced hallucinated feedback: a candidate who
    typed "ewfwfe" was told their `random.shuffle` implementation was wrong.
    Cause — that endpoint calls `prepare_messages_hybrid`, which keyword-detects
    a mode and then **replaces the system prompt entirely**. The grading
    instructions below never reached the model; it received the fine-tuned DEBUG
    prompt, which expects source code as context, so it invented some.

    `generate_response` is the layer underneath and takes messages verbatim.
    Mode is passed as "explain" so the base model and its generation config are
    used rather than the tutoring LoRA — grading is not teaching, and the
    fine-tune pulls hard toward Socratic questions.
    """
    question = await _load(db, slug)

    # An answer too short to contain a claim gets rejected here rather than
    # sent to the model. Asking an LLM to grade "ewfwfe" invites it to invent
    # something to grade, which is exactly the failure this endpoint had.
    stripped = body.answer.strip()
    if len(stripped) < 40 or len(stripped.split()) < 8:
        return {
            "verdict": "too_short",
            "feedback": (
                "There is not enough here to assess yet. Write out your actual "
                "reasoning — a few sentences covering what you would do and why "
                "— and check it again."
            ),
        }

    # Imported here, not at module scope: `main` imports this router, so a
    # top-level import would be a cycle that breaks app startup.
    from ..main import generate_once

    system = (
        "You are grading one answer to a technical interview question. You are "
        "given the question, a reference answer, and the candidate's answer.\n\n"
        "RULES\n"
        "- Judge ONLY the candidate's answer text as written. Do not imagine "
        "code, variables or approaches the candidate did not mention.\n"
        "- If the candidate's answer is empty, nonsense, or unrelated to the "
        "question, say exactly that. Do not invent an attempt to critique.\n"
        "- Do not ask the candidate questions. You are grading, not teaching.\n"
        "- Do not reproduce the reference answer.\n\n"
        "Reply in exactly this format:\n"
        "VERDICT: correct|partial|incorrect\n"
        "SUMMARY: one sentence on what they got right or wrong\n"
        "MISSING: what the reference covers that they did not (or 'nothing')\n"
        "WRONG: anything they stated that is untrue (or 'nothing')"
    )
    user = (
        f"QUESTION\n{question.prompt}\n\nREFERENCE ANSWER\n{question.model_answer}\n\nCANDIDATE ANSWER\n{stripped}"
    )

    # THIS CALL USED TO HOLD NO PERMIT AND COST NOTHING, AND BOTH WERE BUGS.
    #
    # It reaches `generate_response` directly rather than through `/v1/chat/completions` -- and it
    # must, because `prepare_messages_hybrid` replaces the system prompt, which is what produced
    # hallucinated feedback and is documented above. But going around the endpoint also went around
    # the inference semaphore and the rate limiter.
    #
    # Without the permit, on the HuggingFace backend this ran `model.generate()` concurrently with
    # up to MAX_CONCURRENT_REQUESTS chat generations, outside the gate that exists to stop exactly
    # that exhausting VRAM. That is an out-of-memory risk that has nothing to do with billing.
    # Without the meter, grading was free GPU on the same card everything else is charged for.
    #
    # `gpu_slot` fixes both with one acquire, and is safe as a context manager here specifically
    # because the generation is a single `await` -- there is no generator to discard.
    from .. import metering
    from ..main import USE_SGLANG, USE_VLLM, _inference_semaphore
    from ..services import activity

    backend = "sglang" if USE_SGLANG else ("vllm" if USE_VLLM else "hf")
    try:
        async with metering.gpu_slot(
            _inference_semaphore,
            user_id,
            kind="interview_grade",
            backend=backend,
            max_slot_seconds=config.GPU_MAX_SLOT_SECONDS,
            floor_micro=config.GPU_FLOOR_MICRO,
            enforce=config.GPU_METERING_ENABLED,
        ):
            # `generate_once`, not `generate_response`: the latter is the HuggingFace path and
            # has no model to reach under USE_SGLANG, which made this endpoint 503 on every
            # attempt while reporting it as a busy tutor.
            # Assessment is GPU use too, and it does not go through the chat endpoint -- the
            # path that was dead for a week for exactly that reason. A learner grading answers
            # must keep the pod awake.
            await activity.touch()
            text, _pt, _ct, _think = await generate_once(
                [{"role": "system", "content": system},
                 {"role": "user", "content": user}],
                "explain",
                700,
                temperature=0.2,
            )
    except metering.SlotUnavailable:
        logger.warning("Assessment for %s could not get a serving slot", slug)
        raise HTTPException(
            status_code=503,
            detail="The tutor is busy. Your answer is saved — try assessing again shortly.",
        ) from None
    except Exception:
        logger.exception("Assessment failed for %s", slug)
        raise HTTPException(
            status_code=503,
            detail="The tutor is unavailable. Your answer is saved.",
        ) from None

    text = (text or "").strip()

    # Pull the verdict out of the prose and drop that line from the feedback:
    # the client renders it as a badge, so leaving it in shows the same word
    # twice, once as a heading and once as a label.
    verdict = "unknown"
    kept = []
    for line in text.splitlines():
        if verdict == "unknown" and line.upper().lstrip("*# ").startswith("VERDICT:"):
            value = line.split(":", 1)[1].strip().lower().strip("*` ")
            for candidate in ("correct", "partial", "incorrect"):
                if value.startswith(candidate):
                    verdict = candidate
                    break
            continue
        kept.append(line)

    return {"verdict": verdict, "feedback": "\n".join(kept).strip()}


@router.post("/{slug}/submitted")
async def mark_submitted(
    slug: str,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Record that this user has submitted, which is what unlocks the tutor.

    DERIVED FROM `submissions`, NOT TAKEN ON TRUST.

    The client calls this after a submit, but the client is not the authority —
    a request here with no matching submission row would otherwise unlock the
    tutor for someone who never wrote anything. So the flag is set only if a
    submission actually exists against the linked problem.

    Idempotent, and `submitted_at` is never overwritten: it is the time of the
    *first* submit, which is what the timer is measuring against.
    """
    question = await _load(db, slug)
    if question.problem_id is None:
        raise HTTPException(status_code=409, detail="Question is not executable")

    submitted = (
        await db.execute(
            select(Submission.id)
            .where(
                Submission.user_id == user_id,
                Submission.problem_id == question.problem_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()

    if submitted is None:
        raise HTTPException(status_code=409, detail="No submission for this question")

    result = await db.execute(
        select(InterviewAttempt).where(
            InterviewAttempt.user_id == user_id,
            InterviewAttempt.question_id == question.id,
        )
    )
    attempt = result.scalar_one_or_none()
    if attempt is None:
        attempt = InterviewAttempt(user_id=user_id, question_id=question.id)
        db.add(attempt)

    if attempt.submitted_at is None:
        attempt.submitted_at = datetime.utcnow()
    await _commit(db)

    return {"submittedAt": attempt.submitted_at.isoformat()}


@router.put("/{slug}/attempt")
async def save_attempt(
    slug: str,
    body: AttemptRequest,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Upsert this user's rating and notes.

    Notes are saved here rather than kept in the browser so they survive a
    machine change — the point of writing an answer down is to reread it before
    an interview, possibly months later and probably not on the same laptop.
    """
    question = await _load(db, slug)

    result = await db.execute(
        select(InterviewAttempt).where(
            InterviewAttempt.user_id == user_id,
            InterviewAttempt.question_id == question.id,
        )
    )
    attempt = result.scalar_one_or_none()
    if attempt is None:
        attempt = InterviewAttempt(user_id=user_id, question_id=question.id)
        db.add(attempt)

    # `exclude_unset` so a request sending only notes cannot blank an existing
    # rating by omission — the two fields are saved by different interactions.
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(attempt, key, value)

    await _commit(db)
    await db.refresh(attempt)

    return {
        "slug": question.slug,
        "selfRating": attempt.self_rating,
        "notes": attempt.notes,
        "revealedAnswer": attempt.revealed_answer,
    }
