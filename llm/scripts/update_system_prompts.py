#!/usr/bin/env python3
"""
update_system_prompts.py — Phase 2a

Reads  voidcode_training_data_v52.jsonl  (1,700 examples)
Writes voidcode_training_data_v53.jsonl  (same 1,700, system prompt patched to v5.3)

The generate_debug_examples_v53.py script then APPENDS 150 new examples to v53.
Run order (from project root):
  1. python llm/scripts/update_system_prompts.py
  2. python llm/scripts/generate_debug_examples_v53.py
"""

import json
import os
import sys

SCRIPTS_DIR  = os.path.dirname(os.path.abspath(__file__))   # …/llm/scripts/
LLM_DIR      = os.path.dirname(SCRIPTS_DIR)                  # …/llm/
DATA_DIR     = os.path.join(LLM_DIR, "data")

INPUT_FILE   = os.path.join(DATA_DIR, "voidcode_training_data_v52.jsonl")
OUTPUT_FILE  = os.path.join(DATA_DIR, "voidcode_training_data_v53.jsonl")

# Allow direct import from the same scripts/ directory
sys.path.insert(0, SCRIPTS_DIR)
from prompts import FINETUNED_SYSTEM_PROMPT  # noqa: E402


def main() -> None:
    if not os.path.exists(INPUT_FILE):
        print(f"[ERROR] Input file not found: {INPUT_FILE}")
        sys.exit(1)

    updated = 0
    skipped = 0
    mode_counts: dict[str, int] = {}

    print(f"Reading  : {INPUT_FILE}")
    print(f"Writing  : {OUTPUT_FILE}")
    print()

    with open(INPUT_FILE, "r", encoding="utf-8") as fin, \
         open(OUTPUT_FILE, "w", encoding="utf-8") as fout:

        for line_num, raw_line in enumerate(fin, 1):
            raw_line = raw_line.strip()
            if not raw_line:
                continue

            try:
                example = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                print(f"  [WARN] Line {line_num}: JSON error — {exc}")
                skipped += 1
                continue

            # Replace the system message in-place
            messages = example.get("messages", [])
            patched = False
            for msg in messages:
                if msg.get("role") == "system":
                    msg["content"] = FINETUNED_SYSTEM_PROMPT
                    patched = True
                    break

            if not patched:
                ex_id = example.get("id", "?")
                print(f"  [WARN] {ex_id}: no system message found — skipping")
                skipped += 1
                continue

            fout.write(json.dumps(example, ensure_ascii=False) + "\n")
            updated += 1

            mode = example.get("mode", "unknown")
            mode_counts[mode] = mode_counts.get(mode, 0) + 1

            if updated % 200 == 0:
                print(f"  ... {updated} examples updated")

    print()
    print("Done.")
    print(f"  Updated : {updated}")
    print(f"  Skipped : {skipped}")
    print(f"  Mode distribution: { {k: mode_counts[k] for k in sorted(mode_counts)} }")
    print(f"  Output  : {OUTPUT_FILE}")
    print()
    print("Next step: python llm/scripts/generate_debug_examples_v53.py")


if __name__ == "__main__":
    main()
