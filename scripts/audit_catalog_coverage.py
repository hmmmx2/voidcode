"""Which concepts have content, and which do not.

Run:  python scripts/audit_catalog_coverage.py

WHAT THIS USED TO DO, AND WHY IT HAD TO CHANGE
-------------------------------------------------
The first version regexed `slug` literals out of the content *scripts* and matched concept-name
tokens against them, because there was no `concepts:` field to join on. Its own footer said so.

Then content migrated to YAML, the scripts it read stopped existing, and it went on running. It
reported `catalog items: 0` and **all 64 ML concepts bare** — the exact inverse of the truth, at a
moment when every one of them had content. Anyone using it to decide what to author would have
authored the entire catalog a second time.

It joins on `concepts:` now, via `features.content.coverage()`. That field is authoritative and the
loader rejects an id the taxonomy does not define, so a typo cannot silently create a bare concept.

A COVERED CONCEPT IS NOT A TAUGHT CONCEPT
--------------------------------------------
Coverage counts items, and one item is the least evidence a concept is taught. The single-item
concepts are listed separately for that reason: they are where the catalog is one deletion, or one
wrong tag, away from a gap.

That is not hypothetical. `contrastive_pretraining` read as covered until a keyword-collision tag
was removed from `implement-grad-clip` — "clip" had matched CLIP. One spurious tag was holding up
the coverage claim for a whole concept.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Categories belonging to the ML-interview curriculum, which is what this product teaches. The
#: taxonomy also carries the classic-DSA half; those concepts are reported separately rather than
#: mixed in, because a bare DSA concept is a positioning decision and a bare ML concept is a gap.
ML_CATEGORIES = {
    "ml_foundations", "deep_learning", "transformers", "vision_language",
    "training_systems", "gpu_kernels", "ml_engineering",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true",
                        help="include the classic-DSA half of the taxonomy")
    args = parser.parse_args()

    from features.content import coverage, load_items
    from features.taxonomy import get_taxonomy

    items = load_items()
    cov = coverage(items)
    taxonomy = get_taxonomy()

    selected = {
        cid: c for cid, c in taxonomy.concepts.items()
        if args.all or c.category in ML_CATEGORIES
    }
    scope = "all concepts" if args.all else "ML-interview concepts"

    bare = sorted(cid for cid in selected if cid not in cov)
    thin = sorted(cid for cid in selected if len(cov.get(cid, ())) == 1)

    print(f"catalog items      : {len(items)}")
    print(f"{scope:19}: {len(selected)}")
    print(f"  covered          : {len(selected) - len(bare)}")
    print(f"  BARE             : {len(bare)}")
    print(f"  single item only : {len(thin)}   (covered, but one tag away from bare)")

    if bare:
        by_category: dict[str, list[str]] = defaultdict(list)
        for cid in bare:
            by_category[selected[cid].category].append(cid)
        print("\nNo content at all:")
        for category, cids in sorted(by_category.items()):
            print(f"  {category} ({len(cids)})")
            for cid in sorted(cids):
                print(f"    - {cid}")

    if thin:
        print("\nOne item only — the concept a single deletion or wrong tag would empty:")
        for cid in thin:
            print(f"  {cid:32} {cov[cid][0]}")

    if not args.all:
        dsa = sum(1 for c in taxonomy.concepts.values() if c.category not in ML_CATEGORIES)
        print(f"\n{dsa} classic-DSA concepts are not counted above. Pass --all to include them;")
        print("they are bare by positioning, not by oversight.")

    # Bare ML concepts are a real gap and worth a non-zero exit in CI. Thin ones are a judgement
    # call about depth, so they are reported and not enforced.
    return 1 if bare else 0


if __name__ == "__main__":
    raise SystemExit(main())
