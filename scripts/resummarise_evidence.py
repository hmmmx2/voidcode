"""Rebuild a stored eval file's `summary` block from the records in that same file.

Why this exists: the v6 rescore (`CHECK_SURFACE` routing, commit 0ad8bcd) recomputed every
per-record score and left the `summary` block alone. So `summary.by_check.bug_localisation` read
9/51 while the records in the same file read 43/51 -- and a reader who trusted the summary
concluded the headline 0.813 was unreproducible. It reproduces exactly off the records.

The repair reuses `run_evals.summarise`, the function a live run uses, rather than recomputing the
arithmetic here. A second implementation of the summariser is a second thing to get wrong.

Nothing is re-run and no generation is touched: `results` is read, never written. The block being
replaced is kept in `summary.superseded_summary` so the correction is auditable rather than silent.

    python scripts/resummarise_evidence.py docs/evidence/eval_stream_v6_run*.json          # dry run
    python scripts/resummarise_evidence.py docs/evidence/eval_stream_v6_run*.json --write
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from run_evals import summarise  # noqa: E402

# Carried forward verbatim. These describe how the run was produced, which regenerating a summary
# does not change -- and `served_model` in particular is the only provenance some files have.
PRESERVED = ("provenance", "rescored_note", "superseded_summary")

NOTE = ("`summary` regenerated from the `results` in this file by "
        "scripts/resummarise_evidence.py. No generation was re-run and no record was modified; "
        "the block this replaced is kept in `superseded_summary`.")


def is_eval_run(doc: object) -> bool:
    """True for the {summary, results} shape a scored run has.

    `docs/evidence/` also holds A/B probes, hardware probes and bare lists. Skipping them by shape
    rather than by filename means a new probe cannot silently become an eval nobody summarises.
    """
    return (isinstance(doc, dict) and isinstance(doc.get("summary"), dict)
            and isinstance(doc.get("results"), list))


def rebuild(path: Path) -> tuple[dict, list[str]]:
    """Return the new document and a human-readable list of what moved."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    old = doc["summary"]
    fresh = summarise(doc["results"])

    # Both blocks, not just by_check. `by_bucket` is built from `all_passed`, which contains every
    # check -- so a single check moving moves the per-mode rates too. Reporting only by_check said
    # "1 check moves" while 5 bucket rows moved with it, which is the same under-reporting that let
    # the stale summary sit unnoticed in the first place.
    changes = []
    for block in ("by_check", "by_bucket"):
        was_block = old.get(block) or {}
        for name, row in sorted(fresh[block].items()):
            was = was_block.get(name)
            if was is None:
                changes.append(f"{block}/{name}: absent -> {row['passed']}/{row['n']}")
            elif (was.get("passed"), was.get("n")) != (row["passed"], row["n"]):
                changes.append(f"{block}/{name}: {was.get('passed')}/{was.get('n')}"
                               f" -> {row['passed']}/{row['n']}")
        for name in sorted(set(was_block) - set(fresh[block])):
            changes.append(f"{block}/{name}: present -> absent")

    if not changes:
        return doc, changes

    for key in PRESERVED:
        if key in old:
            fresh[key] = old[key]
    # The superseded block keeps only the tallies. Storing the whole old summary nested inside the
    # new one would double the file on every pass.
    fresh["superseded_summary"] = {
        "note": NOTE,
        "by_check": old.get("by_check"),
        "by_bucket": old.get("by_bucket"),
    }
    doc["summary"] = fresh
    return doc, changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--write", action="store_true",
                        help="write the files; without it nothing is modified")
    args = parser.parse_args()

    touched = 0
    for path in args.paths:
        if not is_eval_run(json.loads(path.read_text(encoding="utf-8"))):
            print(f"{path.name}: not a scored run, skipped")
            continue
        doc, changes = rebuild(path)
        if not changes:
            print(f"{path.name}: already consistent")
            continue
        touched += 1
        print(f"{path.name}: {len(changes)} check(s) move")
        for line in changes:
            print(f"    {line}")
        if args.write:
            # indent=1 matches what run_evals writes, so a rewrite is not a whitespace diff.
            path.write_text(json.dumps(doc, indent=1), encoding="utf-8")
            print("    written")

    if not args.write and touched:
        print(f"\ndry run: {touched} file(s) would change. Re-run with --write.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
