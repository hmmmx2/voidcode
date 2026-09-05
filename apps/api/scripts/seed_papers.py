"""
Seed the paper library.

    python -m scripts.seed_papers          # validate + upsert
    python -m scripts.seed_papers --check  # validate only

Upsert by slug, never delete-and-recreate: `paper_progress` references papers
with ON DELETE CASCADE, so recreating rows would wipe every user's reading
progress on each reseed.

The validation exists for the same reason as the interview bank's: a paper with
a missing section does not raise, it renders an empty tab that looks like a
loading bug. Cheaper to fail the seed.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from src.database import AsyncSessionLocal
from src.models.catalogue import Paper
from src.models.problem import Problem

# One-file-per-item content under content/problems/. for_seeder() strips loader metadata
# and copies nested containers; see features/content.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from features.content import for_seeder

PAPERS = for_seeder("paper")

# Fixed, because the UI renders exactly four tabs.
REQUIRED_SECTIONS = ("architecture", "implementation", "systems", "mathematics")
VALID_CATEGORIES = {"ML", "DL", "LLM", "VLM", "CUDA", "PyTorch", "TensorFlow"}
VALID_DIFFICULTIES = {"easy", "medium", "hard"}

# A section shorter than this is a stub, not a breakdown. The whole premise is
# that the explanation is worth more than the PDF link.
MIN_SECTION_CHARS = 600


async def validate(session) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()

    known_problems = set((await session.execute(select(Problem.slug))).scalars())

    for paper in PAPERS:
        slug = paper.get("slug", "<no slug>")

        if slug in seen:
            errors.append(f"{slug}: duplicate slug")
        seen.add(slug)

        for field in ("title", "authors", "pdf_url", "abstract"):
            if not str(paper.get(field, "")).strip():
                errors.append(f"{slug}: '{field}' is missing")

        if paper.get("difficulty") not in VALID_DIFFICULTIES:
            errors.append(f"{slug}: bad difficulty {paper.get('difficulty')!r}")
        for category in paper.get("categories", []):
            if category not in VALID_CATEGORIES:
                errors.append(f"{slug}: unknown category {category!r}")

        sections = paper.get("sections") or {}
        for key in REQUIRED_SECTIONS:
            body = sections.get(key, "")
            if not body.strip():
                errors.append(f"{slug}: section '{key}' is missing")
            elif len(body) < MIN_SECTION_CHARS:
                errors.append(
                    f"{slug}: section '{key}' is {len(body)} chars, "
                    f"under the {MIN_SECTION_CHARS} minimum — it is a stub"
                )
        for key in sections:
            if key not in REQUIRED_SECTIONS:
                errors.append(f"{slug}: unknown section {key!r}, UI renders four tabs")

        # A cross-link to a problem that does not exist renders as nothing, so
        # it fails silently in the UI. Catch it here instead.
        for problem_slug in paper.get("related_problem_slugs", []):
            if problem_slug not in known_problems:
                errors.append(
                    f"{slug}: related_problem_slugs names {problem_slug!r}, "
                    "which is not a seeded problem"
                )

        if not paper.get("pdf_url", "").startswith("https://"):
            errors.append(f"{slug}: pdf_url must be https")

    return errors


async def run(check_only: bool) -> None:
    async with AsyncSessionLocal() as session:
        errors = await validate(session)
        if errors:
            print(f"validation FAILED with {len(errors)} problem(s):")
            for error in errors:
                print(f"  - {error}")
            sys.exit(1)

        print(f"validated {len(PAPERS)} paper(s)")
        if check_only:
            return

        existing = {
            row.slug: row
            for row in (await session.execute(select(Paper))).scalars()
        }

        created = updated = 0
        for order_index, paper in enumerate(PAPERS, start=1):
            fields = {k: v for k, v in paper.items() if k != "slug"}
            fields["order_index"] = order_index
            fields["is_published"] = True

            row = existing.get(paper["slug"])
            if row is None:
                session.add(Paper(slug=paper["slug"], **fields))
                created += 1
            else:
                for key, value in fields.items():
                    setattr(row, key, value)
                updated += 1

        orphans = sorted(set(existing) - {p["slug"] for p in PAPERS})
        await session.commit()

    print(f"created {created}, updated {updated}")
    if orphans:
        print(f"WARNING: {len(orphans)} row(s) not in this file: {', '.join(orphans)}")


if __name__ == "__main__":
    asyncio.run(run("--check" in sys.argv))
