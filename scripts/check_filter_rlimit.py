"""Was the paid filter pass corrupted by the same RLIMIT_AS bug that zeroed the GRPO eval?

The filter ran on this pod with DEFAULT_MEMORY_MB=2048, which on Linux caps *virtual* address
space. That value made every catalogue grading child time out. The catalogue problems import numpy;
DeepCoder's are plain-Python competitive programming, so they may well fit -- but "may well" is not
a measurement, and the entire 1060-problem training corpus rests on the answer.

Grades the same real problems at 2048 and 8192 and compares. Identical results mean the filter's
numbers stand. Any difference means the corpus must be rebuilt.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from reward.limits import run_isolated_stdio_batch


def main() -> int:
    band = json.loads(Path("data/deepcoder-band.json").read_text())
    src = json.loads(Path("data/deepcoder-sample.json").read_text())
    problems = src["problems"] if isinstance(src, dict) else src
    by_id = {p["id"]: p for p in problems}

    # Problems the filter scored non-zero: if the sandbox had crippled them, these are exactly the
    # ones whose pass_rate would have been pushed down.
    hits = [r for r in band["results"] if r["pass_rate"] > 0][:4]
    print(f"comparing {len(hits)} problems at 2048 vs 8192 MB")

    mismatches = 0
    for r in hits:
        p = by_id.get(r["id"])
        if not p:
            continue
        tests = p["tests"][:20]
        # A trivially wrong program: what matters is whether the harness RUNS, not whether it
        # passes. outcome 'ran' means the sandbox worked; 'timeout' means it did not.
        row = {}
        for mb in (2048, 8192):
            t0 = time.time()
            out = run_isolated_stdio_batch(["print(1)"], tests, timeout_s=8, memory_mb=mb)
            row[mb] = (out[0].outcome, out[0].case_fraction, time.time() - t0)
        same = row[2048][0] == row[8192][0]
        if not same:
            mismatches += 1
        pid = r["id"][:28]
        print(f"  {pid:30s} 2048={row[2048][0]:10s} ({row[2048][2]:.2f}s)  "
              f"8192={row[8192][0]:10s} ({row[8192][2]:.2f}s)  same={same}")

    print()
    if mismatches:
        print(f"CORRUPTED: {mismatches} differ -- the filter corpus must be rebuilt")
        return 1
    print("FILTER_OK: identical outcomes at both limits; the paid filter results stand")
    return 0


if __name__ == "__main__":
    sys.exit(main())
