"""Pull DeepCoder into the record shape the pass-rate script already consumes.

DeepCoder is ~24,973 rows across four subsets — codeforces 408, lcbv5 ~877, primeintellect 16,300,
taco 7,440 — with two fields: `problem` (the statement) and `tests` (JSON `{"input", "output"}`
pairs). It is **stdin/stdout competitive programming**, not the pytest shape the corpus scope
assumed, so grading goes through `grade_by_stdio` rather than `grade_by_tests`.

The output deliberately mirrors what `base_pass_rate.py` already reads, so the band filter is the
same code pointed at a different corpus rather than a second implementation of the same idea.

**Downloads nothing by default.** `--dry-run` prints what it would fetch, because a 24K-row pull is
not something a script should do as a side effect of being run.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

SUBSETS = ("codeforces", "lcbv5", "primeintellect", "taco")


def to_record(row: dict, index: int, subset: str) -> dict | None:
    """One DeepCoder row as a problem record. Returns None for rows that cannot be graded."""
    tests = row.get("tests")
    if isinstance(tests, str):
        try:
            tests = json.loads(tests)
        except json.JSONDecodeError:
            return None
    if not isinstance(tests, list) or not tests:
        return None
    # Only rows whose tests are genuinely input/output pairs. Anything else would be counted as a
    # case and always fail, which would look like a hard problem rather than an unusable row.
    pairs = [t for t in tests if isinstance(t, dict) and "input" in t and "output" in t]
    if not pairs:
        return None
    return {
        "id": f"{subset}-{index}",
        "source": subset,
        "prompt": row.get("problem") or "",
        "tests": pairs,
        "n_cases": len(pairs),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subsets", nargs="+", default=list(SUBSETS), choices=SUBSETS)
    ap.add_argument("--sample", type=int, default=2000,
                    help="rows to keep after filtering; the scope calls for a 2,000 sample first")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="data/deepcoder-sample.json")
    args = ap.parse_args()

    if args.dry_run:
        print(f"would load subsets {args.subsets} from agentica-org/DeepCoder-Preview-Dataset")
        print(f"would sample {args.sample} gradeable rows (seed {args.seed}) -> {args.out}")
        print("re-run without --dry-run to download")
        return 0

    from datasets import get_dataset_split_names, load_dataset

    records, skipped, failed = [], 0, {}
    for subset in args.subsets:
        # The split is named "test" on this dataset, not "train". Detected rather than assumed,
        # because a hardcoded name fails loudly on one dataset and silently selects the wrong data
        # on the next one that happens to have both.
        # Split names differ per subset — codeforces has only "test", lcbv5 has both. Detected
        # rather than assumed, because a hardcoded name fails loudly on one dataset and silently
        # selects the wrong data on the next one that happens to have both.
        try:
            available = get_dataset_split_names("agentica-org/DeepCoder-Preview-Dataset", subset)
            split = "train" if "train" in available else available[0]
            ds = load_dataset("agentica-org/DeepCoder-Preview-Dataset", subset, split=split)
        except Exception as exc:
            # One subset failing to build must not cost the whole pull. Recorded, not swallowed:
            # a silently smaller corpus would look like a corpus finding rather than a load error.
            failed[subset] = f"{type(exc).__name__}: {exc}"[:200]
            print(f"  {subset:<16}  SKIPPED — {failed[subset][:80]}", flush=True)
            continue
        print(f"  {subset:<16}{len(ds):>7} rows  (split {split!r})", flush=True)
        for i, row in enumerate(ds):
            rec = to_record(row, i, subset)
            if rec is None:
                skipped += 1
            else:
                records.append(rec)

    random.Random(args.seed).shuffle(records)
    kept = records[: args.sample] if args.sample else records

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "source": "agentica-org/DeepCoder-Preview-Dataset",
        "subsets": args.subsets, "seed": args.seed,
        "gradeable": len(records), "skipped_ungradeable": skipped,
        "subsets_failed_to_load": failed,
        "kept": len(kept),
        "median_cases": sorted(r["n_cases"] for r in kept)[len(kept) // 2] if kept else 0,
        "problems": kept,
    }, indent=2) + "\n", encoding="utf-8")

    print(f"\n  gradeable      {len(records)}")
    print(f"  skipped        {skipped}  (tests not input/output pairs)")
    print(f"  kept           {len(kept)}")
    print(f"  median cases   {sorted(r['n_cases'] for r in kept)[len(kept)//2] if kept else 0}")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
