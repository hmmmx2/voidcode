"""Regenerate `docs/TAG_REVIEW.md` from the content files.

Run:  python scripts/tag_review.py --write

WHY THIS IS GENERATED RATHER THAN MAINTAINED
-----------------------------------------------
The first version was hand-written. It said "94 items pending" and went stale the moment two more
items were added, which is the same failure as `CURRICULUM` in the web app and the hardcoded
strip-list in the seeder: a list describing data, kept by hand, beside the data it describes.

The review state lives in the YAML, not here. Setting `review_needed: false` on an item is what
marks it reviewed, and this file is a view of that. Ticking a checkbox in a markdown file would put
the state in the artefact rather than the source, and the next regeneration would erase it.

WHY TWINS ARE COLLAPSED
--------------------------
Every `iq-<slug>` item is the interview-table copy of `<slug>` and carries **identical** concepts —
38 such pairs, verified rather than assumed, and the check below refuses to collapse a pair whose
tags have diverged. Listing both asks the reviewer to make the same decision twice and inflates the
work by 40%: 96 items are 58 decisions.

If a pair ever disagrees it is listed separately and called out, because that is a real defect —
the same content tagged two ways attributes one learner's submission to two different concepts.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DOC = ROOT / "docs" / "TAG_REVIEW.md"
#: The interview-table copies carry this prefix. Kept in one place so a naming change is one edit.
TWIN_PREFIX = "iq-"

HEADER = """# Concept tag review

**GENERATED — do not edit by hand.** Run `python scripts/tag_review.py --write`.
The review state lives in the YAML: set `review_needed: false` on an item to mark it done.
A previous hand-written version of this file went stale the day two items were added.

**{decisions} decisions pending**, covering {items} items. They are not all the same kind of work.

- **{inferred} keyword-inferred.** Tagged by matching the slug and title during migration, never
  confirmed by anyone. The bulk of the list.
- **{authored} authored-then-flagged.** Tagged deliberately, then marked for review. Their tags
  are probably fine; what wants checking is the *content*.

{twin_note}

## Why this matters more than it looks

These tags write into `problem_concepts` and feed mastery attribution. Credit for a submission is
divided across an item's concepts, so a wrong tag does not add noise — it moves weight from one
concept to another. The ranker then recommends against a weakness the learner does not have, and
the failure is invisible, because the numbers look healthy and are simply about the wrong thing.

## How to review efficiently

**Grouped by concept, because that is the view where a mis-grouping is obvious.** Scan each block
and ask one question: *would a learner weak at this concept be well served by these problems?*
If yes, the block is fine. If one item looks out of place, it is.

Start with the blocks holding a single item — one item is the least evidence that a tag is right,
and a lone mis-tag is the easiest to miss.

## How to fix one

Edit `content/problems/<slug>.yaml`, correct `concepts:`, set `review_needed: false`.
Concept ids must exist in `data/concepts.yaml`; the loader rejects a typo, so a mistake fails
loudly rather than silently dropping the item out of ranking.

Editing an item with a twin? Change both — `scripts/tag_review.py` reports a pair whose tags have
diverged as a defect, since the same content tagged two ways splits one learner's evidence across
two concepts.

Verify: `python -m pytest tests -q`

---
"""


def build() -> tuple[str, dict]:
    from features.content import load_raw

    raw = load_raw()
    pending = {slug: item for slug, item in raw.items() if item.get("review_needed")}

    # Pair each `iq-` copy with its original. A pair whose concepts disagree is NOT collapsed:
    # that is a real defect and hiding it behind one checkbox is how it survives review.
    twins: dict[str, str] = {}
    diverged: list[tuple[str, str]] = []
    for slug in pending:
        if not slug.startswith(TWIN_PREFIX):
            continue
        base = slug[len(TWIN_PREFIX):]
        if base not in raw:
            continue
        if raw[slug].get("concepts") == raw[base].get("concepts"):
            twins[slug] = base
        else:
            diverged.append((slug, base))

    # One entry per decision: the twin folds into its original.
    decisions: dict[str, dict] = {s: i for s, i in pending.items() if s not in twins}
    folded: dict[str, str] = defaultdict(str)
    for twin, base in twins.items():
        folded[base] = twin

    by_concept: dict[str, list[str]] = defaultdict(list)
    for slug, item in decisions.items():
        for concept in item.get("concepts") or []:
            by_concept[concept].append(slug)

    inferred = sum(1 for i in decisions.values() if i.get("inferred_concepts"))
    twin_note = (
        f"**{len(twins)} interview-table copies are folded into their originals.** Every "
        f"`{TWIN_PREFIX}<slug>` carries concepts identical to `<slug>`, so listing both would ask "
        f"for the same decision twice."
    ) if twins else ""
    if diverged:
        twin_note += (
            f"\n\n**{len(diverged)} pair(s) have DIVERGED and are listed separately — this is a "
            "defect.** The same content tagged two ways splits one learner's evidence across two "
            "concepts:\n" + "\n".join(f"  - `{a}` vs `{b}`" for a, b in sorted(diverged))
        )

    out = [HEADER.format(decisions=len(decisions), items=len(pending), inferred=inferred,
                         authored=len(decisions) - inferred, twin_note=twin_note)]

    for concept in sorted(by_concept):
        slugs = sorted(by_concept[concept])
        out.append(f"\n## `{concept}`  ({len(slugs)})\n")
        for slug in slugs:
            item = decisions[slug]
            others = [c for c in (item.get("concepts") or []) if c != concept]
            also = f"  _also: {', '.join(others)}_" if others else ""
            twin = f"  _+ {folded[slug]}_" if folded.get(slug) else ""
            out.append(f"- [ ] **{slug}** — {item.get('title')}{also}{twin}")

    stats = {"decisions": len(decisions), "items": len(pending), "twins": len(twins),
             "diverged": len(diverged), "concepts": len(by_concept)}
    return "\n".join(out) + "\n", stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the file (default: check only)")
    args = parser.parse_args()

    text, stats = build()
    print(f"  {stats['decisions']} decisions over {stats['items']} items "
          f"({stats['twins']} twins folded) across {stats['concepts']} concepts")
    if stats["diverged"]:
        print(f"  WARNING: {stats['diverged']} twin pair(s) disagree on concepts")

    if args.write:
        DOC.write_text(text, encoding="utf-8")
        print(f"  wrote {DOC.relative_to(ROOT)}")
        return 0

    current = DOC.read_text(encoding="utf-8") if DOC.exists() else ""
    if current != text:
        print(f"  {DOC.relative_to(ROOT)} is STALE — rerun with --write")
        return 1
    print("  up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
