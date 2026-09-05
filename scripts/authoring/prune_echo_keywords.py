"""Remove `must_mention` keywords the learner already used in their own question.

A required keyword present in the question is satisfied by repeating it, so it measures echo rather
than understanding. It is not merely useless — it FLATTERS. In both followup scenarios that had one,
the model's reported "covered 1 of 2" was entirely the echo keyword and the substantive one was
missed, so a total miss on the substance was recorded as partial credit.

Found in 6 scenarios across two modes:

    followup  batchnorm    ['running', 'batch']     -> ['running']
    followup  dropout      ['inference', 'scal']    -> ['scal']
    teaching  softmax      ['variance', 'softmax']  -> ['variance']
    teaching  kv_cache     ['cache', 'token']       -> ['token']
    teaching  lora_rank    ['rank', 'parameter']    -> ['parameter']
    teaching  grad_accum   ['batch', 'step']        -> ['step']

The check becomes HARDER, not easier: the free pass that padded `covered` is gone and only the
substance remains. No scenario is left with an empty list, which the script refuses to do — a
scenario with no required keywords would pass `mentions_required` vacuously and quietly stop
testing anything, which is the same failure in a new shape.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))


def main() -> int:
    import run_evals as R

    total = 0
    for mode, val in R.GOLD_FILES.items():
        for path in ([val] if isinstance(val, Path) else val):
            if not path.exists():
                continue
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
                    if line.strip()]
            changed = False
            for row in rows:
                required = row.get("must_mention")
                if not required:
                    continue
                question = row["user_message"].lower()
                kept = [kw for kw in required if kw.lower() not in question]
                if kept == required:
                    continue
                if not kept:
                    print(f"  !! {row['id']}: pruning would empty must_mention — REFUSING. "
                          "A vacuous check is worse than an echoable one.")
                    return 1
                dropped = [kw for kw in required if kw not in kept]
                print(f"  {mode:9} {row['id'][:34]:34} dropped {dropped}, kept {kept}")
                row["must_mention"] = kept
                changed = True
                total += 1
            if changed:
                path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                                encoding="utf-8")
    print(f"\n  pruned {total} scenario(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
