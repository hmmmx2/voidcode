#!/usr/bin/env python3
"""
validate_prompt_match.py  —  Training-pipeline safety script (v5.3)

WHY THIS EXISTS
---------------
The fine-tuned adapter was trained on a specific system prompt (FINETUNED_SYSTEM_PROMPT
in prompts.py).  At inference time the same prompt is injected again.  If the two ever
differ even by a single character the model sees an out-of-distribution prefix and
produces garbled output (observed: 43-token garbage on v5.2 -> v5.3 transition).

This script reads every training JSONL file, extracts the system message from every
record whose mode is in {teaching, debug, followup}, and asserts that it matches
FINETUNED_SYSTEM_PROMPT verbatim.  Explain-mode records are skipped because EXPLAIN
uses the base model with the adapter disabled, so its system prompt is irrelevant.

USAGE
-----
    # Check default files (run from repo root or llm/ directory)
    python scripts/validate_prompt_match.py

    # Check a specific file set
    python scripts/validate_prompt_match.py --data data/mode_debug.jsonl data/voidcode_training_data_v53.jsonl


    # Quiet mode (exit code only, useful in CI)
    python scripts/validate_prompt_match.py --quiet

EXIT CODES
----------
    0  All checked records match FINETUNED_SYSTEM_PROMPT.
    1  One or more records have a mismatched system prompt.
    2  Script error (bad arguments, file not found, JSON parse error, etc.).
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Path setup — allow running from repo root, llm/, or llm/scripts/
# ---------------------------------------------------------------------------

_THIS_DIR = Path(__file__).resolve().parent          # llm/scripts/
_LLM_DIR  = _THIS_DIR.parent                         # llm/
_REPO_DIR = _LLM_DIR.parent                          # repo root

# Ensure we can import prompts.py regardless of cwd
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

try:
    from prompts import FINETUNED_SYSTEM_PROMPT
except ImportError as exc:
    print(f"[ERROR] Cannot import FINETUNED_SYSTEM_PROMPT from prompts.py: {exc}", file=sys.stderr)
    print(f"        Looked in: {_THIS_DIR}", file=sys.stderr)
    sys.exit(2)

# ---------------------------------------------------------------------------
# Default file list
# ---------------------------------------------------------------------------

_DEFAULT_FILES = [
    _LLM_DIR / "data" / "mode_teaching.jsonl",
    _LLM_DIR / "data" / "mode_debug.jsonl",
    _LLM_DIR / "data" / "mode_followup.jsonl",
    _LLM_DIR / "data" / "voidcode_training_data_v53.jsonl",
]

# Modes that must use FINETUNED_SYSTEM_PROMPT — explain uses base model (adapter off)
_FINETUNED_MODES = {"teaching", "debug", "followup"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _first_diff(a: str, b: str) -> Optional[int]:
    """Return the index of the first character where strings differ, or None."""
    for i, (ca, cb) in enumerate(zip(a, b)):
        if ca != cb:
            return i
    if len(a) != len(b):
        return min(len(a), len(b))
    return None


def _context_snippet(text: str, pos: int, window: int = 40) -> str:
    """Return a human-readable snippet around position `pos`."""
    start = max(0, pos - window)
    end   = min(len(text), pos + window)
    snippet = repr(text[start:end])
    marker  = " " * (pos - start + 1) + "^"
    return f"  ...{snippet}...\n  {marker} (char {pos})"


def _extract_system(messages: list, record_id: str) -> Optional[str]:
    """Extract the content of the first system message.  Returns None on failure."""
    if not messages or not isinstance(messages, list):
        return None
    first = messages[0]
    if not isinstance(first, dict):
        return None
    if first.get("role") != "system":
        # Some records might not start with system — warn but don't fail
        return None
    return first.get("content")


# ---------------------------------------------------------------------------
# Core checker
# ---------------------------------------------------------------------------

def check_file(
    path: Path,
    quiet: bool = False,
    seen_ids: Optional[set] = None,
) -> tuple[int, int, int]:
    """
    Check one JSONL file.

    Returns (checked, mismatched, skipped) counts.
    `seen_ids` is used to skip duplicate records across combined files.
    """
    if seen_ids is None:
        seen_ids = set()

    if not path.exists():
        if not quiet:
            print(f"[WARN] File not found, skipping: {path}")
        return 0, 0, 0

    checked   = 0
    mismatched = 0
    skipped   = 0

    with open(path, encoding="utf-8") as fh:
        for line_no, raw_line in enumerate(fh, start=1):
            raw_line = raw_line.strip()
            if not raw_line:
                continue

            # Parse JSON
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                if not quiet:
                    print(f"[ERROR] {path.name}:{line_no}: JSON parse error — {exc}")
                return checked, mismatched + 1, skipped  # treat as mismatch to fail fast

            mode       = record.get("mode", "")
            record_id  = record.get("id", f"line-{line_no}")
            messages   = record.get("messages", [])

            # Skip modes that don't use the fine-tuned prompt
            if mode not in _FINETUNED_MODES:
                skipped += 1
                continue

            # Skip duplicates (records appear in both mode_*.jsonl and combined file)
            if record_id in seen_ids:
                skipped += 1
                continue
            seen_ids.add(record_id)

            # Extract system message
            system_content = _extract_system(messages, record_id)
            if system_content is None:
                if not quiet:
                    print(
                        f"[WARN] {path.name}:{line_no} [{record_id}]: "
                        f"no system message found — skipping"
                    )
                skipped += 1
                continue

            checked += 1

            # Compare verbatim
            diff_pos = _first_diff(system_content, FINETUNED_SYSTEM_PROMPT)
            if diff_pos is not None:
                mismatched += 1
                if not quiet:
                    print(
                        f"[FAIL] {path.name}:{line_no} [{record_id}] "
                        f"mode={mode} — system prompt mismatch"
                    )
                    print(f"       First difference at char {diff_pos}:")
                    print(f"       IN FILE:")
                    print(_context_snippet(system_content, diff_pos))
                    print(f"       IN FINETUNED_SYSTEM_PROMPT:")
                    print(_context_snippet(FINETUNED_SYSTEM_PROMPT, diff_pos))
                    print()

    return checked, mismatched, skipped


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify that training JSONL files use verbatim FINETUNED_SYSTEM_PROMPT.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--data",
        nargs="+",
        metavar="FILE",
        help="JSONL file(s) to check (default: mode_teaching/debug/followup + v53 combined).",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress per-record output; only print summary and exit code.",
    )
    args = parser.parse_args()

    # Resolve file list
    if args.data:
        files = [Path(f) for f in args.data]
    else:
        files = _DEFAULT_FILES

    if not args.quiet:
        print("=" * 70)
        print("validate_prompt_match.py — Training prompt consistency check")
        print("=" * 70)
        print(f"Reference prompt : prompts.FINETUNED_SYSTEM_PROMPT ({len(FINETUNED_SYSTEM_PROMPT)} chars)")
        print(f"Files to check   : {len(files)}")
        print(f"Checked modes    : {sorted(_FINETUNED_MODES)}")
        print()

    total_checked    = 0
    total_mismatched = 0
    total_skipped    = 0
    seen_ids: set[str] = set()

    for path in files:
        if not args.quiet:
            print(f"Checking: {path.name}")
        c, m, s = check_file(path, quiet=args.quiet, seen_ids=seen_ids)
        total_checked    += c
        total_mismatched += m
        total_skipped    += s
        if not args.quiet and m == 0:
            print(f"  OK  — {c} checked, {s} skipped\n")

    # Summary
    if not args.quiet:
        print("=" * 70)
        print(f"TOTAL checked    : {total_checked}")
        print(f"TOTAL skipped    : {total_skipped}")
        print(f"TOTAL mismatched : {total_mismatched}")
        print("=" * 70)

    if total_mismatched > 0:
        if not args.quiet:
            print()
            print("RESULT: FAIL")
            print()
            print("FIX: Run  python scripts/update_system_prompts.py")
            print("     to patch all training files with the current prompt,")
            print("     then re-run this script to confirm.")
        sys.exit(1)
    else:
        if not args.quiet:
            print()
            print("RESULT: PASS — all records match FINETUNED_SYSTEM_PROMPT")
        sys.exit(0)


if __name__ == "__main__":
    main()
