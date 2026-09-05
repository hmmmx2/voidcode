"""What to work on next.

GET /v1/recommendations

The read path for `features/recommend.py`. Everything interesting lives there and is tested without
a database; this router's whole job is to turn four tables into that function's arguments and its
result into JSON.

WHY THE RESPONSE SAYS HOW IT WAS RANKED
------------------------------------------
`ranked_by` is `"model"` or `"mastery"`, and it is not decoration. The LambdaMART ranker refuses to
fit below two learners or ten examples — on this platform's current data (9 users, 2 submissions)
it returns None, and these recommendations come from the mastery heuristic instead.

Both paths return a well-formed, plausible list. Without this field they are indistinguishable at
the API boundary, and a heuristic served as a model's output is a personalisation claim nobody
measured. The UI should be able to say "based on your progress" versus "popular starting points"
without guessing, and `cold_start` exists for the same reason.

WHY THERE IS NO MODEL ON DISK YET
------------------------------------
`RANKER_PATH` is read if set and skipped if not. Training needs learners this platform does not yet
have, so the honest default is the heuristic — not a model fitted on simulated data and served to
real people as if it had learned from them.
"""
from __future__ import annotations

import logging
import os
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import calibration, difficulty_prior, identity
from ..database import get_db
from ..models.problem import Problem
from ..models.problem_concept import ProblemConcept
from ..models.submission import Submission

# `features/` lives at the repo root, outside the api package. main.py reaches it the same way.
_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/recommendations", tags=["recommendations"])


#: Cached across requests. Loading is the only expensive step and the file does not change while
#: the process runs. `False` distinguishes "not yet attempted" from "attempted and unavailable",
#: so a missing model is not retried on every request.
_ranker: object | None | bool = False




def _load_ranker():
    """The trained booster, or None. Never raises — a missing model is the expected state.

    Failing open matters here: the fallback is a real ranking, not a degraded one, so a corrupt or
    absent artefact should cost the `ranked_by` label and nothing else.
    """
    global _ranker
    if _ranker is not False:
        return _ranker

    path = os.getenv("RANKER_PATH")
    _ranker = None
    if path and Path(path).exists():
        try:
            import lightgbm as lgb

            _ranker = lgb.Booster(model_file=path)
            logger.info("ranker loaded from %s", path)
        except Exception as exc:
            logger.warning("ranker at %s could not be loaded, using mastery order: %s", path, exc)
    return _ranker


@router.get("")
async def get_recommendations(
    limit: int = Query(default=10, ge=1, le=50),
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
):
    from features.mastery import Attempt
    from features.recommend import ProblemMeta, recommend
    from features.taxonomy import get_taxonomy

    taxonomy = get_taxonomy()

    # One pass over the join, reused for both directions. The concept map is needed slug-by-slug to
    # attribute submissions and concept-by-slug to find candidates.
    rows = (await db.execute(
        select(Problem.id, Problem.slug, Problem.difficulty, ProblemConcept.concept_id)
        .join(ProblemConcept, ProblemConcept.problem_id == Problem.id)
    )).all()

    concepts_by_problem: dict[uuid.UUID, list[str]] = {}
    problems_by_concept: dict[str, list[str]] = {}
    difficulty_by_id: dict[uuid.UUID, str] = {}
    for pid, slug, difficulty, concept_id in rows:
        concepts_by_problem.setdefault(pid, []).append(concept_id)
        problems_by_concept.setdefault(concept_id, []).append(slug)
        difficulty_by_id[pid] = difficulty

    slug_by_id = {pid: slug for pid, slug, _, _ in rows}
    # Difficulty keyed by slug, because recommendations carry slugs while the join carries ids.
    # This is the only input the solve-probability prior takes from the problem side.
    difficulty_by_slug = {slug: difficulty for _, slug, difficulty, _ in rows}
    problem_meta = {
        slug_by_id[pid]: ProblemMeta(difficulty=difficulty_by_id[pid], n_concepts=len(cs))
        for pid, cs in concepts_by_problem.items()
    }

    submissions = (await db.execute(
        select(Submission).where(Submission.user_id == user_id).order_by(Submission.created_at)
    )).scalars().all()

    attempts = [
        Attempt(
            user_id=str(user_id),
            problem_id=str(s.problem_id),
            # Untagged problems contribute nothing rather than being attributed somewhere. See
            # features/mastery.py — quietly assigning them would be inventing data.
            concepts=tuple(concepts_by_problem.get(s.problem_id, ())),
            status=s.status,
            created_at=s.created_at,
        )
        for s in submissions
    ]
    solved = {slug_by_id[s.problem_id] for s in submissions
              if s.status == "accepted" and s.problem_id in slug_by_id}

    result = recommend(
        attempts=attempts,
        problems_by_concept=problems_by_concept,
        prereq_map={cid: c.prerequisites for cid, c in taxonomy.concepts.items()},
        problem_meta=problem_meta,
        all_concepts=sorted(taxonomy.concepts),
        solved_slugs=solved,
        model=_load_ranker(),
        limit=limit,
    )

    # Records whether a model or the heuristic actually ranked this response. Everything
    # served today is the heuristic; this is how anyone notices when that changes.
    from .. import metrics
    metrics.record_ranked_by(result.ranked_by)

    titles = dict((await db.execute(select(Problem.slug, Problem.title))).all())

    return {
        "ranked_by": result.ranked_by,
        "cold_start": result.cold_start,
        "weak_concepts": list(result.weak_concepts),
        "attempts_considered": len(attempts),
        "items": [
            {
                "slug": r.problem_slug,
                "title": titles.get(r.problem_slug),
                "concept_id": r.concept_id,
                "reasons": list(r.reasons),
                "explanation": r.explain(),
                "mastery": r.mastery,
                "score": r.score,
                # Prior P(solve). `score` and `mastery` are ranking quantities and are NOT
                # probabilities; this is the only field on the response that is one.
                #
                # It is a PRIOR, not a measurement — see `solve_probability_basis` below and
                # apps/api/src/difficulty_prior.py. The ordering it induces is meaningful; the
                # absolute value is a placeholder until the platform has submissions to fit on.
                "solve_probability": _solve_probability(
                    r.mastery, difficulty_by_slug.get(r.problem_slug)),
            }
            for r in result.items
        ],
        # Two separate reports, because they answer different questions and collapsing them is how
        # a placeholder gets quoted as a measurement:
        #   solve_probability_basis  what the numbers ABOVE are (a chosen prior, uncalibrated)
        #   calibration              the World A map, which is loaded and deliberately NOT applied
        "solve_probability_basis": difficulty_prior.status(),
        "calibration": calibration.status(),
    }


def _solve_probability(mastery: float | None, difficulty: str | None) -> float:
    """Prior P(solve) for one item. Always a float in [0, 1] — never None.

    Split out so it is one testable function rather than an expression inside a dict comprehension.

    `mastery` is None when the learner has never attempted this concept, which
    `difficulty_prior.theta_from_mastery` maps to the population midpoint rather than to zero
    ability — "no evidence" and "measured, and weak" are opposite claims, and a new learner must not
    be told every problem is beyond them.

    The World A Codeforces model is deliberately NOT consulted here. No platform problem has a
    Codeforces id, so resolving one would mean inventing it.
    """
    return difficulty_prior.solve_probability(mastery, difficulty)


@router.get("/calibration")
async def get_calibration_status():
    """Is the calibration map loaded, and is anyone actually being served a probability?

    A separate, unauthenticated read of `calibration.status()`. This project's dominant fault has been
    configuration that exists and is never read — `.env`, `ruff.toml`, eleven make targets — so the
    map gets an endpoint that answers whether it loaded, rather than a log line nobody greps.

    `available` and `probabilities_served` are deliberately two fields: the map can be loaded and
    correct while no request receives a number, which is exactly the state today.
    """
    return calibration.status()
