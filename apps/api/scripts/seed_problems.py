"""
Seed the database with the problem set.

Usage:
    cd apps/api
    python -m scripts.seed_problems           # skip existing
    python -m scripts.seed_problems --force    # delete + re-seed

--force DESTROYS LEARNER DATA. `submissions.problem_id` and `code_drafts.problem_id` are both
`ondelete="CASCADE"`, and the loop below deletes each problem before re-inserting it — so a routine
re-seed after a content change takes every submission and draft attached to any seeded problem with
it. There is no warning and no confirmation prompt.

If you only changed tags or metadata, DO NOT re-seed. Update the affected rows directly:
`problem_concepts` has no dependents, so replacing one problem's concept rows touches nothing else.
If you must re-seed, dump `submissions` and `code_drafts` first.

The CONTENT lives in `content/problems/*.yaml`, one file per item, loaded and
validated by `features/content.py`; this file is only the mechanism. The
separation means the curriculum can be read and reviewed as prose without
scrolling past database plumbing, and reviewed by someone who does not write
Python — which matters, because authoring is the one part of this project that
is not engineering.

It was `scripts/problem_content.py` until the migration. That module and its
four siblings held 91 items as Python dict literals, and nobody could say how
many problems existed without a regex sweep across all five.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Add parent directory to path so we can import src modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.database import AsyncSessionLocal
from src.models import CodeTemplate, Problem, ProblemConcept, TestCase

# Content now lives one-file-per-item under content/problems/, loaded and validated in one
# place. for_seeder() strips the loader's own metadata (concepts, source_kind, review
# flags) because this module does Problem(**problem_data) and would raise on them, and it
# copies the nested lists because the loop below pops test_cases and code_templates off.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from features.content import concepts_by_slug, for_seeder


async def dependent_row_counts(session) -> tuple[int, int]:
    """(submissions, drafts) that a `--force` re-seed would cascade-delete.

    Counted BEFORE anything is deleted, because after the fact there is nothing left to count and no
    way to tell an empty table from one that was emptied.
    """
    from sqlalchemy import func, select
    from src.models import CodeDraft, Submission

    submissions = (await session.execute(select(func.count()).select_from(Submission))).scalar() or 0
    drafts = (await session.execute(select(func.count()).select_from(CodeDraft))).scalar() or 0
    return submissions, drafts


async def seed(force: bool = False, delete_learner_data: bool = False):
    """Seed the database with initial problem data.

    REFUSES to run a destructive `--force` while learner data exists, rather than warning about it.
    A comment in a docstring did not stop me recommending `--force` to push a two-row tag change; a
    guard would have. The escape hatch is a second flag whose name says what it does.
    """
    # Derived from the model, not listed: a hardcoded strip-list went stale the first
    # time a migration added a field to the YAML.
    _PROBLEM_KEYS = ({c.name for c in Problem.__table__.columns}
                     | {'test_cases', 'code_templates'})
    CONCEPTS = concepts_by_slug()

    async with AsyncSessionLocal() as session:
        if force and not delete_learner_data:
            submissions, drafts = await dependent_row_counts(session)
            if submissions or drafts:
                print("REFUSING TO RE-SEED.")
                print()
                print(f"  {submissions} submission(s) and {drafts} draft(s) are attached to seeded")
                print("  problems. Both tables are ondelete=CASCADE on problems.id, and --force")
                print("  deletes each problem before re-inserting it, so all of them would go.")
                print()
                print("  If you only changed tags or metadata, DO NOT re-seed. Update the rows")
                print("  directly - problem_concepts has no dependents, so replacing one problem's")
                print("  concept rows touches nothing else.")
                print()
                print("  To proceed anyway, dump those tables first, then pass")
                print("  --delete-learner-data alongside --force.")
                return 1

        for problem_data in for_seeder("problem", allowed=_PROBLEM_KEYS):
            # Extract nested data. Defaults, not direct indexing: rubric-graded items carry
            # neither, by design — V5 descoped the GPU sandbox so CUDA and systems-design items
            # are graded by a human rather than executed. Popping unconditionally raised KeyError
            # on the first one and rolled back the ENTIRE transaction, so 37 successfully-created
            # problems and every concept-join row vanished while the log showed 37 "Created" lines.
            test_cases_data = problem_data.pop("test_cases", []) or []
            code_templates_data = problem_data.pop("code_templates", []) or []

            # Check if problem already exists
            from sqlalchemy import delete as sa_delete
            from sqlalchemy import select

            existing = await session.execute(
                select(Problem).where(Problem.slug == problem_data["slug"])
            )
            existing_problem = existing.scalar_one_or_none()

            if existing_problem:
                if force:
                    # Delete existing problem (cascades to test_cases + code_templates)
                    await session.execute(
                        sa_delete(Problem).where(
                            Problem.slug == problem_data["slug"]
                        )
                    )
                    await session.flush()
                    print(f"  Deleted existing '{problem_data['slug']}' for re-seed")
                else:
                    print(f"  Skipping '{problem_data['slug']}' — already exists (use --force to re-seed)")
                    # Restore popped data for potential re-run
                    problem_data["test_cases"] = test_cases_data
                    problem_data["code_templates"] = code_templates_data
                    continue

            # Create problem
            problem = Problem(**problem_data)
            session.add(problem)
            await session.flush()  # Get the problem.id

            # The taxonomy join. Written here rather than left to a later backfill because a
            # tag that is not persisted at seed time is a tag ranking cannot see, and the table
            # would sit empty while looking installed.
            for concept_id in CONCEPTS.get(problem.slug, []):
                session.add(ProblemConcept(problem_id=problem.id, concept_id=concept_id))

            # Create test cases
            for tc_data in test_cases_data:
                tc = TestCase(problem_id=problem.id, **tc_data)
                session.add(tc)

            # Create code templates
            for ct_data in code_templates_data:
                ct = CodeTemplate(problem_id=problem.id, **ct_data)
                session.add(ct)

            print(
                f"  Created '{problem.title}' with "
                f"{len(test_cases_data)} test cases and "
                f"{len(code_templates_data)} code templates"
            )

            # Restore popped data
            problem_data["test_cases"] = test_cases_data
            problem_data["code_templates"] = code_templates_data

        await session.commit()
        print(f"\nSeeded {len(for_seeder('problem'))} problem(s) successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed the database with problems")
    parser.add_argument(
        "--delete-learner-data",
        action="store_true",
        help="allow --force to cascade-delete submissions and drafts (dump them first)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete existing problems and re-seed",
    )
    args = parser.parse_args()

    print("Seeding database...")
    raise SystemExit(asyncio.run(seed(force=args.force,
                                  delete_learner_data=args.delete_learner_data)) or 0)
