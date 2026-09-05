"""Per-check run-to-run spread across N identical eval runs.

WHY THIS EXISTS
---------------
`temperature` is 0.3-0.75 depending on mode, so the eval is non-deterministic and a single-run
difference means nothing on its own. The project already learned this once: two runs at identical
settings gave 15/51 and 18/51, and a ±3/51 floor was recorded. **That floor was measured on
Qwen2.5-7B served by vLLM and does not transfer** -- a different model, server, prompt path and
sampling config produce a different floor, so carrying the old number across would be exactly the
unpaired comparison the ledger forbids.

So: run the same harness against the same server N times, changing nothing, and report the spread.
Any later change must clear it before it can be called an effect.

    python scripts/noise_floor.py docs/evidence/eval_stream_run*.json

Reports, per check: n, the pass count in each run, mean, sample standard deviation, and the full
range. The range is the honest headline -- with 5 runs a standard deviation is itself a small-sample
estimate, and "no run fell outside X..Y" is the claim the data actually supports.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def load(path: Path) -> dict[str, tuple[int, int]]:
    """{check: (passed, applicable)} for one run, scored on the VISIBLE answer."""
    rows = json.loads(path.read_text(encoding="utf-8"))["results"]
    out: dict[str, list[int]] = {}
    for r in rows:
        for name, c in (r.get("score") or {}).get("checks", {}).items():
            if not c.get("applicable"):
                continue
            got = out.setdefault(name, [0, 0])
            got[1] += 1
            got[0] += bool(c.get("passed"))
    return {k: (v[0], v[1]) for k, v in out.items()}


def main(argv: list[str]) -> int:
    paths = [Path(p) for p in argv[1:]]
    missing = [p for p in paths if not p.is_file()]
    if missing:
        print(f"  missing: {', '.join(str(m) for m in missing)}")
        return 1
    if len(paths) < 2:
        print("  need at least 2 runs to measure a spread")
        return 1

    runs = [load(p) for p in paths]
    names = sorted({k for r in runs for k in r})

    print(f"\n  NOISE FLOOR over {len(paths)} identical runs")
    for p in paths:
        print(f"    {p.name}")
    print(f"\n  {'check':26} {'n':>4} {'per-run passes':>26} {'mean':>7} {'sd':>6} {'range':>9}")
    print(f"  {'-' * 26} {'-' * 4} {'-' * 26} {'-' * 7} {'-' * 6} {'-' * 9}")

    widest = 0
    widest_name = ""
    for name in names:
        counts, ns = [], []
        for r in runs:
            if name in r:
                counts.append(r[name][0])
                ns.append(r[name][1])
        if len(counts) < 2:
            continue
        n = ns[0] if len(set(ns)) == 1 else max(ns)
        if len(set(ns)) != 1:
            print(f"  {name:26} !! applicable count varies across runs {ns} -- not comparable")
            continue
        spread = max(counts) - min(counts)
        if spread > widest:
            widest, widest_name = spread, name
        print(f"  {name:26} {n:>4} {counts!s:>26} {statistics.mean(counts):>7.1f} "
              f"{statistics.stdev(counts):>6.2f} {f'{min(counts)}-{max(counts)}':>9}")

    print(f"\n  WIDEST SPREAD: {widest_name} moved by {widest} scenarios across identical runs.")
    print("  A later change must beat its own check's range before it can be called an effect;")
    print("  a difference inside the range is indistinguishable from re-running the same code.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
