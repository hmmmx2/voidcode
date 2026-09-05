"""Promote the flat `hints` list to a validated `hint_ladder`.

The 119 authored items carry exactly three hints, and reading them they already escalate — the first
asks about behaviour, the second points at a region, the third names the defect. That is rungs 0, 1
and 2 of the ladder, written before the ladder existed. Nothing in the schema recorded it, so
nothing could check it.

WHAT THIS DOES NOT DO

It does not author rung 3. Rung 3 is the fix, and writing 119 of those is authoring rather than
migration — the reference solution is right there, but a rung that states the fix well is a
pedagogical judgement and this script has none. An absent rung is not a violation, so a three-rung
ladder loads.

It does not delete `hints`. That field is an ORM column the API serves; `hint_ladder` is stripped at
the seeder boundary. Two fields holding the same text is exactly how `mock-data.ts` drifted into
carrying Two Sum's hints under a softmax title, so the loader now REQUIRES them to agree — see
`_validate_hint_ladder`. Fix the ladder and the check makes you fix the list.

IT REFUSES RATHER THAN WARNS. An item whose rungs 0 or 1 disclose the fix is left exactly as it was
and reported. Writing it out with a `# TODO` would put a ladder in the catalogue that the loader
then rejects, which fails the whole tree — and every other item with it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from features.ladder import check_ladder  # noqa: E402

CONTENT = ROOT / "content" / "problems"


def main() -> int:
    migrated = refused = skipped = 0
    problems: list[tuple[str, str]] = []

    for path in sorted(CONTENT.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("hint_ladder"):
            continue
        hints = raw.get("hints") or []
        if len(hints) != 3:
            skipped += 1
            continue

        ladder = {"level_0": str(hints[0]), "level_1": str(hints[1]), "level_2": str(hints[2])}
        vocabulary = " ".join(str(raw.get(k, "")) for k in ("description", "prompt", "constraints"))
        found = check_ladder(ladder, vocabulary)
        if found:
            refused += 1
            problems.append((raw["slug"], "; ".join(str(v) for v in found[:2])))
            continue

        # Insert after `hints` so the two sit together and a reviewer sees them agree.
        out: dict = {}
        for key, value in raw.items():
            out[key] = value
            if key == "hints":
                out["hint_ladder"] = ladder
        if "hint_ladder" not in out:
            out["hint_ladder"] = ladder

        path.write_text(
            yaml.safe_dump(out, sort_keys=False, allow_unicode=True, width=100),
            encoding="utf-8")
        migrated += 1

    print(f"\n  migrated {migrated}   refused {refused}   not a 3-hint item {skipped}")
    if problems:
        print("\n  REFUSED — rungs 0 or 1 disclose the fix, and these need rewriting by hand:\n")
        for slug, why in problems:
            print(f"    {slug}\n      {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
