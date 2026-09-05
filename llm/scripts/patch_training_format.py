#!/usr/bin/env python3
"""
patch_training_format.py — Post-process debug training examples

Ensures every debug assistant response passes the three failing eval checks:

  BugCnt  — starts with "I found N issue(s) in your code."
  SrcCit  — cites at least one "Line N" (only for non-confirmation responses)
  GuidQ   — contains at least one "?" (guiding question)

Run from project root:
  python llm/scripts/patch_training_format.py

Operates in-place on llm/data/voidcode_training_data_v53.jsonl.
A backup is written to llm/data/voidcode_training_data_v53.jsonl.bak before any changes.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
DATA_DIR    = SCRIPTS_DIR.parent / "data"
JSONL_PATH  = DATA_DIR / "voidcode_training_data_v53.jsonl"
BACKUP_PATH = DATA_DIR / "voidcode_training_data_v53.jsonl.bak"

# ── BugCnt detection (same patterns as evaluate_debug_quality.py) ────────────

_BUGCNT_PATTERNS = [
    re.compile(r'[Ii]\s+found\s+\*?\*?\w+\*?\*?\s+issue'),
    re.compile(r'[Ii]\s+found\s+\*?\*?\w+\*?\*?\s+bug'),
    re.compile(r'[Ii]\s+found\s+\*?\*?\w+\*?\*?\s+problem'),
    re.compile(r'[Ff]ound\s+\*?\*?\w+\*?\*?\s+issue'),
    re.compile(r'[Tt]here\s+(?:are|is)\s+\*?\*?\w+\*?\*?\s+(?:issue|bug|problem)'),
    re.compile(r'\d+\s+issue[s]?\s+in\s+your'),
    re.compile(r'\d+\s+bug[s]?\s+in\s+your'),
    re.compile(r'\d+\s+problem[s]?\s+in\s+your'),
    re.compile(r'\d+\s+thing[s]?\s+(?:to fix|I\s+(?:found|noticed|spotted))'),
]

_ISSUE_BLOCK_PAT = re.compile(
    r'\*?\*?Issue\s+(\d+)\s*[—\-–]', re.IGNORECASE
)
# Old v5.2 format: **Line N** headers + 🔴 emoji markers
_OLD_LINE_HDR_PAT = re.compile(r'\*\*Line\s+\d+\*\*')
_OLD_RED_DOT = '\U0001f534'   # 🔴


def has_bugcnt_statement(text: str) -> bool:
    return any(p.search(text) for p in _BUGCNT_PATTERNS)


def count_issue_blocks(text: str) -> int:
    """Return the number of distinct bugs indicated in the response.

    Supports both formats:
      New (v5.3): **Issue N — Line X**  → take max N
      Old (v5.2): 🔴 **Line N** or standalone **Line N** headers → count occurrences
    """
    # New format
    new_matches = _ISSUE_BLOCK_PAT.findall(text)
    if new_matches:
        return max(int(m) for m in new_matches)

    # Old format — count 🔴 red-dot markers (one per bug)
    red_count = text.count(_OLD_RED_DOT)
    if red_count > 0:
        return red_count

    # Old format — count **Line N** header occurrences (distinct lines = bugs)
    old_headers = _OLD_LINE_HDR_PAT.findall(text)
    if old_headers:
        return len(old_headers)

    return 0


# ── Confirmation-turn heuristic ───────────────────────────────────────────────
# Short responses (< 80 words) that start with an affirmation and have no Issue
# blocks are likely student-confirmation turns — don't force a bug-count opener.
_AFFIRMATION_RE = re.compile(
    r'^(Exactly|Yes|Correct|Right|Great|Good|Spot on|That\'s right|Perfect|Nice|Well done)',
    re.IGNORECASE,
)

def is_confirmation_turn(text: str, issue_count: int) -> bool:
    word_count = len(text.split())
    return issue_count == 0 and word_count < 120 and bool(_AFFIRMATION_RE.match(text.strip()))


# ── Fixes ─────────────────────────────────────────────────────────────────────

def fix_bugcnt(text: str, n: int) -> str:
    """Prepend 'I found N issue(s) in your code.' if not already present."""
    issue_word = "issue" if n == 1 else "issues"
    opener = f"I found {n} {issue_word} in your code.\n\n"
    return opener + text


def fix_guidq(text: str) -> str:
    """Append a contextual guiding question if none exists."""
    # Try to detect what the last Issue talks about and ask about it.
    # Fall back to a generic close-ended check if we can't infer.
    last_issue = re.search(
        r'\*?\*?Issue\s+\d+[^*]*?\*?\*?\n(.*?)(?=\n\n---|\Z)',
        text, re.DOTALL | re.IGNORECASE,
    )
    if last_issue:
        return text + "\n\nWhat change would you make to fix this?"
    # Confirmation turn — softer question
    return text + "\n\nDoes that make sense?"


# ── Main ──────────────────────────────────────────────────────────────────────

def patch_examples(examples: list) -> tuple[list, dict]:
    stats = {
        "total_debug": 0,
        "bugcnt_fixed": 0,
        "guidq_fixed": 0,
        "skipped_confirmation": 0,
    }

    patched = []
    for ex in examples:
        if ex.get("mode") != "debug":
            patched.append(ex)
            continue

        stats["total_debug"] += 1
        messages = ex["messages"]

        # Find the last assistant turn (the one being scored)
        asst_indices = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
        if not asst_indices:
            patched.append(ex)
            continue

        # Process ALL assistant turns in the example
        changed = False
        for idx in asst_indices:
            text = messages[idx]["content"]
            n_issues = count_issue_blocks(text)

            # Skip confirmation turns — they don't need a bug-count opener
            if is_confirmation_turn(text, n_issues):
                stats["skipped_confirmation"] += 1
                continue

            # ── Fix BugCnt ────────────────────────────────────────────────
            if n_issues > 0 and not has_bugcnt_statement(text):
                messages[idx]["content"] = fix_bugcnt(text, n_issues)
                text = messages[idx]["content"]
                stats["bugcnt_fixed"] += 1
                changed = True

            # ── Fix GuidQ ─────────────────────────────────────────────────
            if "?" not in text and n_issues > 0:
                messages[idx]["content"] = fix_guidq(text)
                stats["guidq_fixed"] += 1
                changed = True

        if changed:
            ex = dict(ex)
            ex["messages"] = messages
        patched.append(ex)

    return patched, stats


def main():
    if not JSONL_PATH.exists():
        print(f"❌ Not found: {JSONL_PATH}", file=sys.stderr)
        sys.exit(1)

    # Load
    examples = []
    with open(JSONL_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))

    print(f"Loaded {len(examples)} examples from {JSONL_PATH.name}")

    # Backup
    shutil.copy2(JSONL_PATH, BACKUP_PATH)
    print(f"Backup -> {BACKUP_PATH.name}")

    # Patch
    patched, stats = patch_examples(examples)

    # Write
    with open(JSONL_PATH, "w", encoding="utf-8") as f:
        for ex in patched:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"\nPatch complete:")
    print(f"  Debug examples processed : {stats['total_debug']}")
    print(f"  BugCnt fixes applied     : {stats['bugcnt_fixed']}")
    print(f"  GuidQ fixes applied      : {stats['guidq_fixed']}")
    print(f"  Confirmation turns skipped: {stats['skipped_confirmation']}")
    print(f"\nFile written -> {JSONL_PATH.name}")


if __name__ == "__main__":
    main()
