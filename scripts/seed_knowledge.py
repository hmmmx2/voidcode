"""V2: chunk, embed and load the retrieval corpus into the database.

Run:  python scripts/seed_knowledge.py [--write] [--force]

Dry run by default — it prints what it would insert. `--write` requires a reachable embedder and
database.

THE CORPUS IS NO LONGER IN THIS FILE
--------------------------------------
It was a `DOCS: list[dict]` of ten entries here, each body a triple-quoted string. It now lives in
`data/knowledge/*.md` and is loaded by `features/knowledge_corpus.py`, which validates it.

Same argument as the problem catalogue, and it got stronger as the corpus grew: content that only
exists in a database cannot be reviewed in a pull request, and retrieval exists precisely because
this material goes stale — so editing a claim is the common operation, not the rare one. The
database is the serving copy; the files are the source.

Moving it also bought validation the list never had. A typo'd `concept_id` used to seed cleanly and
then match nothing, which looks exactly like "no relevant document exists".

EVERY DOCUMENT CARRIES A SOURCE AND A DATE, WITHOUT EXCEPTION
---------------------------------------------------------------
Not metadata. The date is what lets a reader judge whether "the current best quantization scheme"
was current when it was written, and the URL is what makes a stale entry findable and replaceable.
`knowledge_corpus.REQUIRED` enforces both, so a document missing either cannot be seeded at all.

SUPERSEDE, NEVER DELETE
-------------------------
An earlier version of this script deleted a document's chunks and re-inserted them. That is wrong
for a corpus whose whole purpose is traceability: an answer given last month cited a chunk, and
that citation should still resolve to something explaining what replaced it rather than to nothing.

`features/knowledge_ingest.supersede()` was written and tested for exactly this and was never
called. It is now. Old rows are marked `is_current=False` and kept; `retrieve()` only ranks current
ones, so retired versions are inert but auditable.

Unchanged documents are skipped rather than re-embedded. That is not only a speed concern: bumping
the version on identical text would make the history record edits that never happened.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="embed and insert (default: dry run)")
    ap.add_argument("--max-chars", type=int, default=1800)
    ap.add_argument("--force", action="store_true",
                    help="re-embed and supersede even when the text is unchanged")
    args = ap.parse_args()

    from features.knowledge_corpus import load_documents
    from features.knowledge_ingest import chunk_text, ingest

    # Raises on the first malformed document rather than skipping it: a silently dropped document
    # is indistinguishable at query time from one that simply did not match.
    documents = load_documents()

    if not args.write:
        total = 0
        for d in documents:
            n = len(chunk_text(d.body, max_chars=args.max_chars))
            total += n
            print(f"  {d.slug:30s} {n} chunk(s)  concept={d.concept_id}")
        print(f"\n  {len(documents)} documents -> {total} chunks (dry run; pass --write)")
        return 0

    import asyncio
    import os

    import httpx
    from sqlalchemy import select, update
    from src.database import AsyncSessionLocal
    from src.models import KnowledgeDocument

    from features.knowledge_ingest import Chunk, supersede

    def embedder(text: str) -> list[float]:
        # Env-configured, matching apps/api/src/main.py::_get_embedder. These were hardcoded to
        # 127.0.0.1 while main.py read EMBEDDING_BASE_URL, so a deployed API and the script that
        # seeded its corpus could silently use DIFFERENT embedders. retrieve() raises on a dimension
        # mismatch, but two 768-dim models that disagree on direction produce meaningless neighbours
        # with no error at all -- the worst version of this failure.
        base = os.environ.get("EMBEDDING_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
        model = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")
        r = httpx.post(f"{base}/api/embeddings",
                       json={"model": model, "prompt": text}, timeout=60)
        r.raise_for_status()
        return r.json()["embedding"]

    async def run() -> int:
        inserted = superseded = unchanged = 0
        async with AsyncSessionLocal() as session:
            for d in documents:
                existing = (await session.execute(
                    select(KnowledgeDocument)
                    .where(KnowledgeDocument.slug.like(f"{d.slug}#%"),
                           KnowledgeDocument.is_current.is_(True))
                    .order_by(KnowledgeDocument.slug)
                )).scalars().all()

                # Compare against the chunk boundaries the ingest would produce, not the raw file:
                # a change that does not alter any chunk is not a change worth versioning.
                wanted = chunk_text(d.body, max_chars=args.max_chars)
                same = [r.body for r in existing] == wanted

                if existing and same and not args.force:
                    unchanged += 1
                    print(f"  {d.slug:30s} unchanged")
                    continue

                chunks = ingest(embedder=embedder, max_chars=args.max_chars,
                                **d.as_ingest_kwargs())

                if existing:
                    prior = [Chunk(slug=r.slug, title=r.title, body=r.body, ordinal=i,
                                   version=r.version) for i, r in enumerate(existing)]
                    plan = supersede(prior, chunks)
                    await session.execute(
                        update(KnowledgeDocument)
                        .where(KnowledgeDocument.slug.in_(plan.retire_slugs),
                               KnowledgeDocument.is_current.is_(True))
                        .values(is_current=False))
                    for row in plan.new_rows:
                        session.add(KnowledgeDocument(**row))
                    superseded += 1
                    version = plan.new_rows[0]["version"] if plan.new_rows else "?"
                    print(f"  {d.slug:30s} {len(chunks)} chunk(s)  superseded -> v{version}")
                else:
                    for c in chunks:
                        session.add(KnowledgeDocument(**c.as_row()))
                    inserted += 1
                    print(f"  {d.slug:30s} {len(chunks)} chunk(s)  new")

            await session.commit()

            live = len((await session.execute(
                select(KnowledgeDocument).where(KnowledgeDocument.is_current.is_(True))
            )).scalars().all())
            total = len((await session.execute(select(KnowledgeDocument))).scalars().all())

        print(f"\n  {inserted} new, {superseded} superseded, {unchanged} unchanged")
        print(f"  corpus: {live} current chunks ({total} rows including retired versions)")
        return 0

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
