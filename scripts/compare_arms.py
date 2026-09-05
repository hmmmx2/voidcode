"""Compare two experiment arms, judged against the baseline arm's own measured spread.

WHY THIS IS SEPARATE FROM `noise_floor.py`
------------------------------------------
`noise_floor.py` answers "how much does this metric move when nothing changes". This answers
"did the change move it further than that". They are different questions and conflating them is how
a re-run gets reported as an improvement.

    python scripts/compare_arms.py --baseline docs/evidence/eval_stream_run*.json \
                                   --arm      docs/evidence/eval_stream_v2_run*.json

The verdict is deliberately blunt. A metric whose arm mean falls inside the baseline's observed
range is reported as INSIDE NOISE, with no direction claimed -- not "a small improvement", not
"a slight regression". At these sample sizes a difference inside the range is indistinguishable
from re-running the same code, and the project has already been burned once by a single run's
`no_invented_code 51/51` that turned out to range 47-51.

Disclosure levels are reported as a distribution shift rather than a pass rate, because the whole
point of the ladder is that "how far up did it go" is not a binary.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def check_counts(path: Path) -> dict[str, tuple[int, int]]:
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


def level_dist(path: Path, surface: str) -> Counter:
    import run_evals as R

    rows = json.loads(path.read_text(encoding="utf-8"))["results"]
    c: Counter = Counter()
    for r in rows:
        s = r["scenario"]
        if s.get("mode") != "debug" or s.get("messages"):
            continue
        text = r["response"] if surface == "visible" else r.get("thinking", "")
        if surface == "reasoning" and not text:
            continue
        c[R.disclosure_level(text, s)["level"]] += 1
    return c


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", nargs="+", required=True)
    ap.add_argument("--arm", nargs="+", required=True)
    ap.add_argument("--label", default="arm")
    args = ap.parse_args(argv[1:])

    base = [check_counts(Path(p)) for p in args.baseline]
    arm = [check_counts(Path(p)) for p in args.arm]
    print(f"\n  BASELINE {len(base)} runs   vs   {args.label.upper()} {len(arm)} runs")
    print(f"\n  {'check':26} {'n':>4} {'baseline':>18} {'arm':>18}  verdict")
    print(f"  {'-'*26} {'-'*4} {'-'*18} {'-'*18}  {'-'*28}")

    for name in sorted({k for r in base for k in r}):
        b = [r[name][0] for r in base if name in r]
        a = [r[name][0] for r in arm if name in r]
        if not b or not a:
            continue
        ns = {r[name][1] for r in base if name in r} | {r[name][1] for r in arm if name in r}
        if len(ns) != 1:
            print(f"  {name:26} !! applicable count differs across arms {sorted(ns)} — not comparable")
            continue
        n = ns.pop()
        lo, hi = min(b), max(b)
        am = statistics.mean(a)
        if lo <= am <= hi:
            verdict = "INSIDE NOISE — no claim"
        elif am > hi:
            verdict = f"ABOVE baseline range (+{am - hi:.1f} beyond)"
        else:
            verdict = f"BELOW baseline range (-{lo - am:.1f} beyond)"
        print(f"  {name:26} {n:>4} {f'{statistics.mean(b):.1f} [{lo}-{hi}]':>18} "
              f"{f'{am:.1f} {sorted(set(a))}':>18}  {verdict}")

    for surface in ("visible", "reasoning"):
        bd = [level_dist(Path(p), surface) for p in args.baseline]
        ad = [level_dist(Path(p), surface) for p in args.arm]
        bn = sum(bd[0].values()) or 1
        an = sum(ad[0].values()) or 1
        print(f"\n  DISCLOSURE LEVELS — {surface}   (baseline n={bn}, arm n={an})")
        print(f"    {'level':6} {'baseline':>22} {'arm':>22}")
        for lv in range(5):
            b = [d[lv] for d in bd]
            a = [d[lv] for d in ad]
            print(f"    {lv:<6} {f'{statistics.mean(b):5.1f}  {statistics.mean(b)/bn:5.1%}':>22} "
                  f"{f'{statistics.mean(a):5.1f}  {statistics.mean(a)/an:5.1%}':>22}")
        bok = [sum(d[lv] for lv in (0, 1)) for d in bd]
        aok = [sum(d[lv] for lv in (0, 1)) for d in ad]
        print(f"    opening<=1  baseline {statistics.mean(bok)/bn:.3f} [{min(bok)}-{max(bok)}]"
              f"   arm {statistics.mean(aok)/an:.3f} {sorted(set(aok))}")
        b4 = [d[4] for d in bd]
        a4 = [d[4] for d in ad]
        print(f"    level 4     baseline {statistics.mean(b4)/bn:.3f} [{min(b4)}-{max(b4)}]"
              f"   arm {statistics.mean(a4)/an:.3f} {sorted(set(a4))}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
