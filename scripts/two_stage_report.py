"""Two-stage debug: did it work, and how much of the set could it even reach?

STRATIFICATION IS THE POINT, NOT A REFINEMENT.
The two-stage path only runs when `decide_mode` says `debug`, and only 31 of 48 first-turn debug
scenarios route there. So an overall number understates the mechanism (17 scenarios never touched
it) while an on-path number overstates what a learner gets today (those 17 are real requests from
real learners). Both are reported, always, and neither is allowed to stand alone.

    python scripts/two_stage_report.py docs/evidence/eval_stream_v3_run*.json

`reached the path` is read from whether a stage A diagnosis came back for that scenario, not from
re-deriving the route -- the evidence file records what actually happened rather than what should
have.
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def load(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["results"]


def main(argv: list[str]) -> int:
    import run_evals as R

    paths = [Path(p) for p in argv[1:]]
    if not paths:
        print("  give me one or more evidence files")
        return 1
    runs = [load(p) for p in paths]

    reached_counts, level_on, level_off, loc_hint, loc_diag = [], [], [], [], []
    for rows in runs:
        debug = [r for r in rows if r["scenario"].get("mode") == "debug"
                 and not r["scenario"].get("messages")]
        on = [r for r in debug if r.get("diagnosis")]
        off = [r for r in debug if not r.get("diagnosis")]
        reached_counts.append((len(on), len(debug)))
        level_on.append(Counter(
            R.disclosure_level(r["response"], r["scenario"])["level"] for r in on))
        level_off.append(Counter(
            R.disclosure_level(r["response"], r["scenario"])["level"] for r in off))
        # localisation, on the hint the learner reads vs on the private diagnosis
        loc_hint.append(sum(
            1 for r in on if (r["score"].get("checks", {}).get("bug_localisation") or {}).get("passed")))
        loc_diag.append(sum(
            1 for r in on
            if ((r.get("score_diagnosis") or {}).get("bug_localisation") or {}).get("passed")))

    on_n = statistics.mean(a for a, _ in reached_counts)
    tot_n = reached_counts[0][1]
    print(f"\n  REACHED THE TWO-STAGE PATH: {on_n:.1f} of {tot_n} first-turn debug scenarios "
          f"({on_n / tot_n:.1%})")
    print("  The rest were routed elsewhere and fell back to single-stage. Routing caps this.")

    for label, dists, n in (("ON the two-stage path", level_on, on_n),
                            ("FELL BACK to single-stage", level_off, tot_n - on_n)):
        if n < 1:
            continue
        print(f"\n  DISCLOSURE LEVEL — {label}  (n={n:.0f})")
        for lv in range(5):
            vals = [d[lv] for d in dists]
            print(f"    level {lv}  {statistics.mean(vals):5.1f}  {statistics.mean(vals)/n:6.1%}"
                  f"   {R.DISCLOSURE_LEVELS[lv][:46]}")
        ok = [sum(d[lv] for lv in (0, 1)) for d in dists]
        print(f"    opening<=1: {statistics.mean(ok)/n:.3f}   per-run {sorted(set(ok))}")

    if on_n >= 1:
        print("\n  BUG LOCALISATION — which surface is it scored on?")
        print(f"    on the HINT the learner reads : {statistics.mean(loc_hint):5.1f}/{on_n:.0f}"
              f" = {statistics.mean(loc_hint)/on_n:.3f}   (the hint has no line numbers BY DESIGN)")
        print(f"    on the PRIVATE diagnosis      : {statistics.mean(loc_diag):5.1f}/{on_n:.0f}"
              f" = {statistics.mean(loc_diag)/on_n:.3f}   (did the tutor actually find the bug?)")
        print("    The gap between these two rows is the gate conflict, made visible.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
