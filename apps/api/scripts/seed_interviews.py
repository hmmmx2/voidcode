"""
Seed the Elite Interview question bank.

    python -m scripts.seed_interviews          # validate + upsert
    python -m scripts.seed_interviews --check  # validate only, touch nothing

VALIDATION RUNS BEFORE ANY WRITE, AND IT IS NOT OPTIONAL.

Every field here is free text authored by hand, and the failure mode of a bad
value is silent: a domain of "math" instead of "maths" does not raise, it
produces a question that no filter in the UI can ever select. The row exists,
the count is right, and it is invisible. So the vocabularies are closed and
checked, and a violation aborts the whole run rather than skipping one row —
a partial seed is worse than none, because it looks like it worked.

Upsert by slug rather than delete-and-recreate: `interview_attempts` references
questions by id with ON DELETE CASCADE, so recreating rows would silently
destroy every user's self-ratings and notes on every reseed.
"""

import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from src.database import AsyncSessionLocal
from src.models.catalogue import InterviewQuestion
from src.models.problem import CodeTemplate, Problem, TestCase
from src.models.problem_concept import ProblemConcept

# Content comes from the one-file-per-item loader. COMPANIES / DOMAINS / KINDS below are
# validation VOCABULARIES, not content, and now live in data/vocabularies.py --
# which is why that module cannot simply be deleted with the rest.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from features.content import concepts_by_slug, for_seeder

# Keyed by the UN-PREFIXED slug, matching the interview question it pairs with:
# the executable form is `iq-implement-auc`, its question is `implement-auc`.
# Keying by the full slug made every pairing fail with "has an executable form but no
# interview question" — the same mismatch that cost 38 reference solutions during the
# migration, fixed in verify_interview_problems and missed here.
INTERVIEW_PROBLEMS = {r["slug"].removeprefix("iq-"): r
                      for r in for_seeder("interview_problem")}
# Closed vocabularies now live in data/vocabularies.py, which is what let the five content
# scripts be deleted: these are validation vocabularies, not content, and they outlive any
# particular set of questions.
from data.vocabularies import COMPANIES, DOMAINS, KINDS  # noqa: E402

INTERVIEW_QUESTIONS = for_seeder("interview_question")

# Must match `CATEGORY_ORDER` in routers/dashboard.py. Duplicated deliberately
# rather than imported: the router is about problems, this is about interview
# questions, and coupling the two would mean a change to one silently changes
# what the other accepts. The check below is what keeps them honest.
VALID_CATEGORIES = {"ML", "DL", "LLM", "VLM", "CUDA", "PyTorch", "TensorFlow"}
VALID_DIFFICULTIES = {"easy", "medium", "hard"}

REQUIRED_TEXT = ("slug", "title", "prompt", "approach", "model_answer")
REQUIRED_LISTS = ("companies", "categories", "follow_ups", "red_flags")

# ── Gate 1: no behavioural questions ────────────────────────────────────────
#
# The bank is technical by rule, not by habit. A behavioural question would not
# fail any type check above — it would seed cleanly, sit in the catalogue, and
# only be noticed by whoever opened it.
#
# Phrase-matching cannot judge rigour, and does not pretend to. It catches the
# recognisable openings, which is what actually drifts in when someone adds a
# question in a hurry.
BEHAVIOURAL_PHRASES = (
    "tell me about a time",
    "tell me about yourself",
    "a time when you",
    "walk me through your experience",
    "describe a situation",
    "how do you prioritise",
    "how do you prioritize",
    "stakeholder",
    "team dynamic",
    "conflict with a colleague",
    "your greatest weakness",
    "where do you see yourself",
    "why do you want to work",
)

# ── Gate 2: distinct from the problem catalogue ─────────────────────────────
#
# THE BANK MUST NOT RE-ASK WHAT THE CURRICULUM ALREADY GRADES.
#
# Four questions violated this before the gate existed, and one of them was
# worse than a duplicate: `iou-nms`'s own hint in `problem_content.py` spelled
# out the interview answer verbatim, so a candidate arriving from the Problem
# Page had already been handed it.
#
# Keyed by curriculum slug, each entry lists terms that mean "this question is
# about that problem". A hit fails the seed unless the question carries an
# explicit `overlap_ack` explaining why the overlap is acceptable — which is
# how the three legitimate partial overlaps pass. The point is to force a
# decision, not to forbid the topic outright.
CURRICULUM_TOPICS: dict[str, tuple[str, ...]] = {
    # "the max from" rather than "subtract the max": the first version missed
    # `logsumexp-stability`, whose prompt says "subtracting". Match the stem.
    "stable-softmax": (
        "the max from",
        "shift-invarian",
        "softmax overflow",
        "leaves softmax unchanged",
    ),
    "cross-entropy-loss": ("implement cross-entropy", "write cross-entropy"),
    "layer-norm": ("implement layer norm", "write layernorm", "write layer norm"),
    "sgd-momentum-step": ("momentum buffer", "sgd step", "write the sgd"),
    "scaled-dot-product-attention": (
        "causal mask",
        "mask before the softmax",
        "implement attention",
        "write attention",
    ),
    "top-p-sampling": ("top-p", "nucleus sampl"),
    "bpe-merge": ("byte-pair", "bpe merge"),
    "iou-nms": ("iou", "intersection over union", "non-max suppress"),
    "parallel-reduction": ("parallel reduction", "halving stride"),
    "thread-index-mapping": ("blockidx", "thread index mapping"),
    "broadcast-shapes": ("broadcast shape", "broadcasting rule"),
    "batchnorm-inference": ("running_mean", "batchnorm at inference"),
}


def _mentions(haystack: str, term: str) -> bool:
    """
    True if `term` appears as whole words rather than as a substring.

    `re.escape` because several terms contain a hyphen (`top-p`, `byte-pair`),
    which is a regex metacharacter inside a character class and would otherwise
    change the pattern's meaning.
    """
    return re.search(rf"(?<!\w){re.escape(term)}(?!\w)", haystack) is not None


def validate() -> list[str]:
    """Return a list of problems. Empty means the bank is clean."""
    errors: list[str] = []
    seen: set[str] = set()

    for index, q in enumerate(INTERVIEW_QUESTIONS):
        slug = q.get("slug", f"<index {index}>")

        for field in REQUIRED_TEXT:
            value = q.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{slug}: '{field}' is missing or empty")

        for field in REQUIRED_LISTS:
            value = q.get(field)
            if not isinstance(value, list) or not value:
                errors.append(f"{slug}: '{field}' is missing or empty")

        if slug in seen:
            errors.append(f"{slug}: duplicate slug")
        seen.add(slug)

        if q.get("domain") not in DOMAINS:
            errors.append(f"{slug}: domain {q.get('domain')!r} not in {DOMAINS}")
        if q.get("kind") not in KINDS:
            errors.append(f"{slug}: kind {q.get('kind')!r} not in {KINDS}")
        if q.get("difficulty") not in VALID_DIFFICULTIES:
            errors.append(f"{slug}: difficulty {q.get('difficulty')!r} is not valid")

        for company in q.get("companies", []):
            if company not in COMPANIES:
                errors.append(f"{slug}: unknown company {company!r}")
        for category in q.get("categories", []):
            if category not in VALID_CATEGORIES:
                errors.append(f"{slug}: unknown category {category!r}")

        # A question whose answer is shorter than its prompt is a stub. This has
        # caught more real omissions than any of the type checks above.
        if len(q.get("model_answer", "")) < len(q.get("prompt", "")):
            errors.append(f"{slug}: model_answer is shorter than the prompt")

        # Gate 1 — behavioural. Checked against prompt and title only: the
        # model answer may legitimately discuss teams or trade-offs when
        # explaining why an engineering decision is made.
        haystack = f"{q.get('title', '')}\n{q.get('prompt', '')}".lower()
        for phrase in BEHAVIOURAL_PHRASES:
            if phrase in haystack:
                errors.append(
                    f"{slug}: prompt contains behavioural phrase {phrase!r}. "
                    "This bank is technical questions only."
                )

        # Gate 2 — curriculum overlap.
        #
        # Word-boundary matching, not `in`. A bare substring test on a short
        # term is wrong in a way that is easy to miss: "iou" matched inside
        # "obvious" and failed a question that has nothing to do with bounding
        # boxes. "previous", "various" and "serious" would have done the same.
        ack = q.get("overlap_ack")
        for problem_slug, terms in CURRICULUM_TOPICS.items():
            hits = [t for t in terms if _mentions(haystack, t)]
            if not hits:
                continue
            if not ack:
                errors.append(
                    f"{slug}: overlaps curriculum problem {problem_slug!r} "
                    f"(matched {hits!r}). Either rewrite it, or add "
                    f"overlap_ack='<why this is still distinct>'."
                )
            elif not isinstance(ack, str) or len(ack.strip()) < 20:
                errors.append(
                    f"{slug}: overlap_ack must be a real explanation, not {ack!r}"
                )

    return errors


async def _seed_problems(session) -> int:
    """
    Create or update the `problems` row backing each executable question.

    Upsert by problem slug, never delete-and-recreate: `submissions` and
    `code_drafts` hold `problems.id` under a NOT NULL foreign key, so recreating
    a row would destroy every attempt anyone has made at that question.

    Test cases and code templates ARE replaced wholesale on each run. They are
    authored content with no user data attached, and diffing them by label would
    quietly leave a renamed case behind — which is how a question ends up graded
    against an expectation nobody can find in the source.
    """
    questions = {
        row.slug: row
        for row in (await session.execute(select(InterviewQuestion))).scalars()
    }
    existing = {
        row.slug: row
        for row in (
            await session.execute(
                select(Problem)
                .where(Problem.origin == "interview")
                .options(
                    selectinload(Problem.test_cases),
                    selectinload(Problem.code_templates),
                    # Problem.concepts was added with the taxonomy join and cascades
                    # delete-orphan, so SQLAlchemy must load it during flush. Without eager
                    # loading that is a lazy load inside an async session, which raises
                    # MissingGreenlet — an error naming greenlets and pointing nowhere near the
                    # relationship that caused it.
                    selectinload(Problem.concepts),
                )
            )
        ).scalars()
    }

    # Keyed by the full slug (iq-...), because spec['slug'] is the problem's own slug
    # even though INTERVIEW_PROBLEMS is keyed by the un-prefixed question slug.
    _CONCEPTS = concepts_by_slug()
    linked = 0
    for question_slug, spec in INTERVIEW_PROBLEMS.items():
        question = questions.get(question_slug)
        if question is None:
            raise SystemExit(
                f"{question_slug}: has an executable form but no interview question"
            )

        # Restricted to the model's own columns, derived rather than listed. These rows come
        # from the content loader and carry concepts, source_kind, reference_solution and review
        # flags, none of which are Problem columns — the same TypeError that broke seed_problems.
        _allowed = {c.name for c in Problem.__table__.columns}
        columns = {k: v for k, v in spec.items()
                   if k in _allowed and k not in ("test_cases", "code_templates")}

        problem = existing.get(spec["slug"])
        if problem is None:
            problem = Problem(origin="interview", **columns)
            session.add(problem)
        else:
            for key, value in columns.items():
                setattr(problem, key, value)
            problem.test_cases.clear()
            problem.code_templates.clear()
            # Flush the deletes BEFORE appending replacements.
            #
            # Without this, SQLAlchemy emits the INSERTs and the DELETEs in one
            # flush with the INSERTs first, and the new Python template collides
            # with the old one on `ix_code_templates_problem_lang`
            # (problem_id, language). Re-seeding an existing question then fails
            # with a UniqueViolationError while a first-time seed works — which
            # is the worst shape of bug, because it only appears on the second
            # run.
            await session.flush()

        for case in spec["test_cases"]:
            problem.test_cases.append(TestCase(**case))
        for template in spec["code_templates"]:
            problem.code_templates.append(CodeTemplate(**template))

        # The taxonomy join, same as seed_problems writes for curriculum items. Without this the
        # 38 interview problems carry concepts in YAML and zero rows in the database — the join
        # looks populated because curriculum items filled it, while half the catalog is invisible
        # to candidate generation and contributes nothing to mastery attribution.
        #
        # Replaced rather than appended, so re-seeding does not accumulate duplicates against
        # uq_problem_concept. `problem.concepts` is eagerly loaded above for exactly this.
        problem.concepts.clear()
        for concept_id in _CONCEPTS.get(spec["slug"], []):
            problem.concepts.append(ProblemConcept(concept_id=concept_id))

        await session.flush()
        question.problem_id = problem.id
        linked += 1

    return linked


async def seed() -> None:
    async with AsyncSessionLocal() as session:
        existing = {
            row.slug: row
            for row in (await session.execute(select(InterviewQuestion))).scalars()
        }

        created = updated = 0
        for order_index, q in enumerate(INTERVIEW_QUESTIONS, start=1):
            fields = {
                "title": q["title"],
                "prompt": q["prompt"],
                "domain": q["domain"],
                "kind": q["kind"],
                "difficulty": q["difficulty"],
                "companies": q["companies"],
                "categories": q["categories"],
                "order_index": order_index,
                "approach": q["approach"],
                "model_answer": q["model_answer"],
                "follow_ups": q["follow_ups"],
                "red_flags": q["red_flags"],
                "is_published": True,
            }

            row = existing.get(q["slug"])
            if row is None:
                session.add(InterviewQuestion(slug=q["slug"], **fields))
                created += 1
            else:
                for key, value in fields.items():
                    setattr(row, key, value)
                updated += 1

        # Anything in the table but not in this file. Reported, never deleted —
        # dropping it would cascade to user attempts, and a slug that vanished
        # is far more likely to be a typo in this file than a real retirement.
        orphans = sorted(set(existing) - {q["slug"] for q in INTERVIEW_QUESTIONS})

        # Flush so questions created above have ids before they are linked.
        await session.flush()
        linked = await _seed_problems(session)

        await session.commit()

    print(f"created {created}, updated {updated}, linked {linked} executable")
    if orphans:
        print(f"WARNING: {len(orphans)} row(s) in the table are not in this file:")
        for slug in orphans:
            print(f"  - {slug}")


def main() -> None:
    errors = validate()
    if errors:
        print(f"validation FAILED with {len(errors)} problem(s):")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)

    print(f"validated {len(INTERVIEW_QUESTIONS)} questions")
    if "--check" in sys.argv:
        return
    asyncio.run(seed())


if __name__ == "__main__":
    main()
