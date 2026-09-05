#!/usr/bin/env python3
"""
evaluate_debug_quality.py  —  Phase 3 Evaluation Suite

Runs the gold regression set against the live VoidCode AI API and reports
automated quality metrics for DEBUG mode responses across 6 dimensions.

Automated checks (Section 6.1):
  1. Bug count accuracy   — model states the correct number of bugs
  2. No duplicate bugs    — each unique line number appears in at most 1 Issue block
  3. Source code citation — response cites at least 1 line number from the source
  4. No answer leakage    — response does not contain the complete fixed code
  5. Guiding question     — response contains at least one question mark
  6. Positive framing     — response contains at least one encouraging word/phrase

Heuristic rubric (Section 6.2, --rubric-score):
  Scores each response 1–5 across 5 dimensions without requiring an LLM:
  Completeness, Analysis depth, Pedagogical quality, Tone, Conciseness.

Usage:
  # Run baseline evaluation against the current deployed model:
  python llm/scripts/evaluate_debug_quality.py

  # Custom API URL or gold dataset:
  python llm/scripts/evaluate_debug_quality.py \\
      --api-url http://localhost:8000 \\
      --data llm/data/eval_debug_gold.jsonl \\
      --output llm/data/eval_results_baseline.json

  # Run and label as post-retrain (for comparison):
  python llm/scripts/evaluate_debug_quality.py --mode post-retrain \\
      --output llm/data/eval_results_v53.json

  # Compare two saved result files to measure improvement:
  python llm/scripts/evaluate_debug_quality.py --compare \\
      llm/data/eval_results_baseline.json \\
      llm/data/eval_results_v53.json

  # Run a single scenario for debugging:
  python llm/scripts/evaluate_debug_quality.py \\
      --scenario eval_two_sum_multibug_001 --verbose

  # Add heuristic rubric scores (no LLM needed):
  python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose

  # Offline eval from a pre-generated responses JSON file (no API needed):
  python llm/scripts/evaluate_debug_quality.py \\
      --responses-file my_responses.json --rubric-score

  # Responses file format: {"scenario_id": "response text", ...}
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
LLM_DIR = SCRIPT_DIR.parent
DATA_DIR = LLM_DIR / "data"
DEFAULT_GOLD_PATH = DATA_DIR / "eval_debug_gold.jsonl"
DEFAULT_API_URL = "http://localhost:8000"

# ─────────────────────────────────────────────────────────────────────────────
# Positive words list (Check 6)
# ─────────────────────────────────────────────────────────────────────────────

POSITIVE_WORDS = [
    "good", "solid", "great", "nice", "correct", "right", "almost",
    "close", "well done", "on the right track", "approach is right",
    "logic is right", "makes sense", "nice use", "good use",
    "your overall", "mostly", "just one", "just a", "small fix", "minor",
    "nearly", "almost there", "exactly", "spot on", "that's right",
    "you're close", "you are close", "nearly there", "good attempt",
    "well structured", "well-structured", "nicely", "good loop",
    "correct approach", "right direction",
]

# ─────────────────────────────────────────────────────────────────────────────
# HTTP helper
# ─────────────────────────────────────────────────────────────────────────────

def call_api(api_url: str, user_message: str, timeout: int = 120,
             messages: Optional[list] = None) -> str:
    """
    Call the VoidCode AI's OpenAI-compatible /v1/chat/completions endpoint.
    Uses stream=True (required when USE_VLLM=true on the server).
    Collects all SSE delta chunks and returns the full assembled response.
    Falls back to urllib if httpx is not installed.

    For multi-turn scenarios, pass the full conversation history via `messages`.
    When `messages` is provided it is used as-is; `user_message` is ignored.
    """
    msg_payload = messages if messages is not None else [
        {"role": "user", "content": user_message}
    ]
    payload = {
        "model": "voidcode-ai-v5.2",
        "messages": msg_payload,
        "max_tokens": 1024,
        "stream": True,   # vLLM path requires streaming
    }
    headers = {"Content-Type": "application/json"}
    url = f"{api_url}/v1/chat/completions"

    full_content = []

    try:
        import httpx
        hx_timeout = httpx.Timeout(connect=10.0, read=float(timeout), write=10.0, pool=5.0)
        with httpx.Client(timeout=hx_timeout) as client:
            with client.stream("POST", url, json=payload, headers=headers) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    line = line.strip()
                    if not line or line == "data: [DONE]":
                        continue
                    if line.startswith("data: "):
                        try:
                            chunk = json.loads(line[6:])
                            delta = chunk["choices"][0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full_content.append(content)
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue
    except ImportError:
        import urllib.request
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw_line in r:
                line = raw_line.decode("utf-8").strip()
                if not line or line == "data: [DONE]":
                    continue
                if line.startswith("data: "):
                    try:
                        chunk = json.loads(line[6:])
                        delta = chunk["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_content.append(content)
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue

    return "".join(full_content)


def check_api_health(api_url: str) -> bool:
    """Verify the API is reachable before running evaluation."""
    try:
        import httpx
        with httpx.Client(timeout=10) as client:
            resp = client.get(f"{api_url}/health")
            return resp.status_code == 200
    except Exception:
        try:
            import urllib.request
            with urllib.request.urlopen(f"{api_url}/health", timeout=10) as r:
                return r.status == 200
        except Exception:
            return False


# ─────────────────────────────────────────────────────────────────────────────
# Check 1 — Bug count accuracy
# ─────────────────────────────────────────────────────────────────────────────

_WORD_TO_NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "1": 1, "2": 2, "3": 3, "4": 4, "5": 5,
    "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
}

_BUG_COUNT_PATTERNS = [
    r"[Ii]\s+found\s+\*?\*?(\w+)\*?\*?\s+issue",
    r"[Ii]\s+found\s+\*?\*?(\w+)\*?\*?\s+bug",
    r"[Ii]\s+found\s+\*?\*?(\w+)\*?\*?\s+problem",
    r"[Ff]ound\s+\*?\*?(\w+)\*?\*?\s+issue",
    r"[Tt]here\s+(?:are|is)\s+\*?\*?(\w+)\*?\*?\s+(?:issue|bug|problem)",
    r"(\d+)\s+issue[s]?\s+in\s+your",
    r"(\d+)\s+bug[s]?\s+in\s+your",
    r"(\d+)\s+problem[s]?\s+in\s+your",
    r"(\d+)\s+thing[s]?\s+(?:to fix|I\s+(?:found|noticed|spotted))",
]


def check_bug_count_accuracy(response: str, expected: int) -> dict:
    """Check 1: Does the response state the correct number of bugs found?

    When expected == -1 the check is skipped (N/A for multi-turn follow-ups
    where the model is not producing a fresh bug analysis).
    """
    if expected == -1:
        return {
            "passed": True,
            "found_count": None,
            "expected_count": -1,
            "matched_pattern": None,
            "note": "N/A (multi-turn — bug count not checked)",
        }

    found_n = None
    matched_pattern = None

    for pat in _BUG_COUNT_PATTERNS:
        m = re.search(pat, response)
        if m:
            word = m.group(1).lower().strip("*")
            found_n = _WORD_TO_NUM.get(word)
            if found_n is None:
                try:
                    found_n = int(word)
                except ValueError:
                    pass
            if found_n is not None:
                matched_pattern = pat
                break

    passed = found_n == expected
    return {
        "passed": passed,
        "found_count": found_n,
        "expected_count": expected,
        "matched_pattern": matched_pattern,
        "note": (
            f"Stated {found_n}, expected {expected}"
            if not passed
            else f"✓ stated {found_n}"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Check 2 — No duplicate bugs
# ─────────────────────────────────────────────────────────────────────────────

def check_no_duplicate_bugs(response: str) -> dict:
    """
    Check 2: Each unique line number appears in ≤1 Issue block.
    Accepts both new format (**Issue N — Line X**) and old (**Line N**).
    """
    new_pat = re.compile(
        r'\*?\*?Issue\s+\d+\s*[—\-–]+\s*Line\s+(\d+)\*?\*?', re.IGNORECASE
    )
    old_pat = re.compile(r'\*\*Line\s+(\d+)\*\*', re.IGNORECASE)

    new_lines = new_pat.findall(response)
    old_lines = old_pat.findall(response)
    all_cited = new_lines + old_lines

    seen: set = set()
    duplicates: list = []
    for ln in all_cited:
        if ln in seen:
            duplicates.append(f"Line {ln}")
        seen.add(ln)

    passed = len(duplicates) == 0
    return {
        "passed": passed,
        "line_citations": all_cited,
        "duplicates": duplicates,
        "note": (
            f"Duplicate bug citations: {duplicates}"
            if not passed
            else f"✓ {len(seen)} unique line(s) cited"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Check 3 — Source code citation
# ─────────────────────────────────────────────────────────────────────────────

def check_source_code_citation(response: str, source_code: str) -> dict:
    """
    Check 3: Response cites ≥1 line number that falls within the source code's
    actual line range, confirming the model read the source rather than only
    echoing stderr.
    """
    source_line_count = len(source_code.strip().split("\n"))
    cited = re.findall(r'[Ll]ine\s+(\d+)', response)
    valid = [int(ln) for ln in cited if 1 <= int(ln) <= source_line_count]
    passed = len(valid) > 0
    return {
        "passed": passed,
        "source_line_count": source_line_count,
        "all_cited": [int(ln) for ln in cited],
        "valid_citations": valid,
        "note": (
            f"✓ cited line(s) {valid[:3]} (source has {source_line_count} lines)"
            if passed
            else f"No valid citations (source: {source_line_count} lines, cited: {[int(x) for x in cited[:5]]})"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Check 4 — No answer leakage
# ─────────────────────────────────────────────────────────────────────────────

def check_no_answer_leakage(response: str) -> dict:
    """Check 4 — delegates to the canonical scorer in `scripts/run_evals.py`.

    THIS HELD A SECOND, NON-EQUIVALENT COPY OF THE LEAK REGEX.
    The two had drifted in both directions: this one matched annotated signatures that
    `run_evals` missed, while `run_evals` matched across prose/fence boundaries that this one
    required to be indented. Two definitions of the product's core promise means the number
    depends on which script you ran.

    The canonical version implements `docs/LEAK_RUBRIC.md` — multi-language, span-local scaffold
    exemption, prose directives, and a recorded span per hit. This wrapper keeps the old return
    shape so callers and the rubric scorer at `--rubric-score` are unaffected.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
    from run_evals import check_no_answer_leakage as _canonical

    result = _canonical(response, {})
    return {
        "passed": result["passed"],
        "complete_def_found": result["complete_definition"],
        "has_blanks": result["has_blanks"],
        "hits": result["hits"],
        "rows_hit": result["rows_hit"],
        "note": (
            "✓ no leak detected"
            if result["passed"]
            else f"⚠️ leak, rubric row(s) {', '.join(result['rows_hit'])}"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Check 5 — Guiding question present
# ─────────────────────────────────────────────────────────────────────────────

def check_guiding_question(response: str) -> dict:
    """Check 5: Response must end with or contain at least one '?' (Socratic question)."""
    question_count = response.count("?")
    passed = question_count > 0
    return {
        "passed": passed,
        "question_count": question_count,
        "note": (
            f"✓ {question_count} question(s) found"
            if passed
            else "No guiding question (no '?' in response)"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Check 6 — Positive framing
# ─────────────────────────────────────────────────────────────────────────────

def check_positive_framing(response: str, strictly_required: bool = False) -> dict:
    """
    Check 6: Response should contain at least one positive/encouraging word or phrase.
    For 'mostly_correct' scenarios this is strictly required; for all others it is
    tracked but not scored as a failure (to avoid penalising legitimate bug reports).
    """
    resp_lower = response.lower()
    found_words = [w for w in POSITIVE_WORDS if w in resp_lower]
    has_positive = len(found_words) > 0

    # Only hard-fail if the scenario explicitly requires positive framing
    passed = has_positive if strictly_required else True

    return {
        "passed": passed,
        "strictly_required": strictly_required,
        "has_positive": has_positive,
        "found_words": found_words[:3],
        "note": (
            f"✓ found: {found_words[:3]}"
            if has_positive
            else ("❌ no positive framing (required)" if strictly_required
                  else "⚠️ no positive framing (not required here)")
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Run all checks
# ─────────────────────────────────────────────────────────────────────────────

def run_checks(response: str, scenario: dict) -> dict:
    """Run all 6 automated checks for a single scenario's response.

    Multi-turn scenarios may declare a ``skip_checks`` list in the JSONL.
    Any check name in that list is auto-passed and annotated as skipped,
    rather than being scored.  This prevents multi-turn follow-up responses
    (empathy, clarification) from being penalised for checks that don't
    apply to that turn type.
    """
    skip = set(scenario.get("skip_checks", []))

    def maybe_skip(name: str, result: dict) -> dict:
        if name in skip:
            return {"passed": True, "note": f"N/A (skipped for {scenario.get('scenario_type', 'this scenario type')})"}
        return result

    checks = {
        "bug_count_accuracy": maybe_skip(
            "bug_count_accuracy",
            check_bug_count_accuracy(response, scenario["expected_bug_count"]),
        ),
        "no_duplicate_bugs": maybe_skip(
            "no_duplicate_bugs",
            check_no_duplicate_bugs(response),
        ),
        "source_code_citation": maybe_skip(
            "source_code_citation",
            check_source_code_citation(response, scenario["source_code"]),
        ),
        "no_answer_leakage": maybe_skip(
            "no_answer_leakage",
            check_no_answer_leakage(response),
        ),
        "guiding_question": maybe_skip(
            "guiding_question",
            check_guiding_question(response),
        ),
        "positive_framing": maybe_skip(
            "positive_framing",
            check_positive_framing(
                response,
                strictly_required=scenario.get("positive_framing_expected", False),
            ),
        ),
    }
    all_passed = all(c["passed"] for c in checks.values())
    return {"all_passed": all_passed, "checks": checks}


# ─────────────────────────────────────────────────────────────────────────────
# Heuristic rubric scorer (Priority 6 — no LLM required)
# Implements the Section 6.2 quality rubric using rule-based signals.
# Each dimension is scored 1–5; scores are aggregated per run.
# ─────────────────────────────────────────────────────────────────────────────

_DEPTH_5_SIGNALS = [
    "think about", "here's how", "on your own", "how to spot",
    "whenever you see", "debugging methodology", "you can spot",
    "how to debug", "debugging strategy",
]
_DEPTH_3_SIGNALS = [
    "because", "this means", "what this does", "in other words",
    "the reason", "this causes", "python expects", "python sees",
    "that's why", "which is why", "means that", "results in",
]
_TARGETED_Q_PATTERNS = [
    re.compile(r'[Ww]hich\s+(?:variable|parameter|one|value|line|input)'),
    re.compile(r'[Ww]hat\s+(?:do|does|should|would|is|are|two|one|value|variable)'),
    re.compile(r'[Ww]hy\s+(?:do|does|would|is)'),
    re.compile(r'[Hh]ow\s+(?:would|do|does|can|should)'),
    re.compile(r'[Cc]an\s+you\s+(?:see|tell|identify|spot|find)'),
]
_WARM_BONUS_PHRASES = ["let's", " we ", "we can", "we have", "together"]


def score_rubric(response: str, scenario: dict) -> dict:
    """
    Heuristic rubric scorer — Section 6.2, no LLM required.

    Scores 1–5 on 5 dimensions (multi-turn awareness is N/A for single-turn
    gold entries and is excluded from the average).

    Returns:
        {
            "completeness":        int (1-5),
            "analysis_depth":      int (1-5),
            "pedagogical_quality": int (1-5),
            "tone":                int (1-5),
            "conciseness":         int (1-5),
            "multi_turn_aware":    None,   # N/A for single-turn
            "average":             float,  # mean of the 5 scored dims
        }
    """
    resp_lower = response.lower()
    n_words = len(response.split())

    # ── 1. Completeness ────────────────────────────────────────────────────────
    # Fraction of expected bug line numbers that appear in the response.
    expected_lines = {str(b["line"]) for b in scenario["ground_truth_bugs"]}
    cited = set(re.findall(r'[Ll]ine\s+(\d+)', response))
    matches = len(expected_lines & cited)
    fraction = matches / len(expected_lines) if expected_lines else 1.0
    completeness = 5 if fraction >= 1.0 else (3 if fraction >= 0.5 else 1)

    # ── 2. Analysis depth ──────────────────────────────────────────────────────
    # Signals: methodology phrases > explanation words > length > bare error echo.
    if n_words < 30:
        analysis_depth = 1
    elif any(s in resp_lower for s in _DEPTH_5_SIGNALS):
        analysis_depth = 5
    elif any(s in resp_lower for s in _DEPTH_3_SIGNALS) and n_words >= 60:
        analysis_depth = 4
    elif n_words >= 60:
        analysis_depth = 3
    else:
        analysis_depth = 2

    # ── 3. Pedagogical quality ─────────────────────────────────────────────────
    # Penalise answer leakage; reward targeted Socratic questions.
    has_answer_leak = not check_no_answer_leakage(response)["passed"]
    has_question    = "?" in response
    has_targeted_q  = has_question and any(p.search(response) for p in _TARGETED_Q_PATTERNS)

    if has_answer_leak:
        pedagogical_quality = 1
    elif not has_question:
        pedagogical_quality = 2
    elif has_targeted_q and not has_answer_leak:
        pedagogical_quality = 5
    else:
        pedagogical_quality = 3

    # ── 4. Tone ────────────────────────────────────────────────────────────────
    # Penalise robotic 🔴/🟢 markers; reward warmth and "we/let's" language.
    has_robotic  = "🔴" in response or "🟢" in response
    warm_count   = sum(1 for w in POSITIVE_WORDS if w in resp_lower)
    uses_we      = any(ph in resp_lower for ph in _WARM_BONUS_PHRASES)

    if has_robotic:
        tone = 1
    elif warm_count == 0 and not uses_we:
        tone = 2
    else:
        bonus = warm_count + (1 if uses_we else 0)
        tone = min(5, 3 + bonus)

    # ── 5. Multi-turn awareness ────────────────────────────────────────────────
    # Gold entries are single-turn; score N/A (excluded from average).
    multi_turn_aware = None

    # ── 6. Conciseness ─────────────────────────────────────────────────────────
    # Target: 60–(200 + bugs×75) words.  Outside band → lower score.
    expected_bugs = scenario["expected_bug_count"]
    ideal_max = 200 + expected_bugs * 75
    if n_words < 30:
        conciseness = 1
    elif n_words < 60:
        conciseness = 2
    elif n_words <= ideal_max:
        conciseness = 5 if n_words >= 75 else 4
    elif n_words <= int(ideal_max * 1.5):
        conciseness = 3
    else:
        conciseness = 2

    scored = [completeness, analysis_depth, pedagogical_quality, tone, conciseness]
    average = round(sum(scored) / len(scored), 1)

    return {
        "completeness":        completeness,
        "analysis_depth":      analysis_depth,
        "pedagogical_quality": pedagogical_quality,
        "tone":                tone,
        "conciseness":         conciseness,
        "multi_turn_aware":    multi_turn_aware,
        "average":             average,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Reporting helpers
# ─────────────────────────────────────────────────────────────────────────────

CHECK_ABBREVS = {
    "bug_count_accuracy": "BugCnt",
    "no_duplicate_bugs":  "NoDupe",
    "source_code_citation": "SrcCit",
    "no_answer_leakage":  "NoLeak",
    "guiding_question":   "GuidQ?",
    "positive_framing":   "PosFrm",
}

SCENARIO_TYPE_EMOJI = {
    "single_syntax":             "🔴 syntax",
    "single_logic":              "🟡 logic",
    "multi_bug_syntax_logic":    "🔴🟡 multi",
    "masked_bug":                "🫥 masked",
    "mostly_correct":            "🟢 mostly✓",
    "wrong_variable_name":       "🔤 varname",
    "wrong_return":              "↩️ return",
    "off_by_one":                "±1 off-by-1",
    "edge_case_empty":           "📭 edge",
    "partial_correctness":       "⚗️ partial",
    "multi_bug_logic":           "🟡🟡 multi-l",
    "infinite_loop":             "♾️ inf-loop",
    "multi_turn_confusion":      "💬 mt-confuse",
    "multi_turn_frustration":    "😤 mt-frustr",
    "multi_turn_partial_answer": "🔀 mt-partial",
}


def print_verbose_result(scenario: dict, response: str, checks: dict,
                         rubric: Optional[dict] = None):
    """Print detailed result for --verbose mode."""
    status = "✅" if checks["all_passed"] else "❌"
    stype = SCENARIO_TYPE_EMOJI.get(scenario["scenario_type"], scenario["scenario_type"])
    print(f"\n{'─' * 68}")
    print(f"{status} {scenario['id']}")
    print(f"   Type: {stype} | Problem: {scenario['problem']} ({scenario['difficulty']})")
    bugs = scenario["ground_truth_bugs"]
    print(f"   Bugs: {len(bugs)} expected", end="")
    for b in bugs:
        print(f" | line {b['line']} [{b['type']}]", end="")
    print()
    print(f"\n   Response preview:")
    preview = response[:300].replace("\n", " ↵ ")
    print(f"   \"{preview}{'...' if len(response) > 300 else ''}\"")
    print(f"\n   Automated checks:")
    for name, result in checks["checks"].items():
        icon = "✅" if result["passed"] else "❌"
        abbrev = CHECK_ABBREVS.get(name, name)
        print(f"     {icon} {abbrev:<8}  {result['note']}")
    if rubric:
        print(f"\n   Heuristic rubric (1–5):")
        dim_labels = [
            ("completeness",        "Complete"),
            ("analysis_depth",      "Depth"),
            ("pedagogical_quality", "Pedagogy"),
            ("tone",                "Tone"),
            ("conciseness",         "Concise"),
        ]
        for key, label in dim_labels:
            score = rubric[key]
            bar = "★" * score + "☆" * (5 - score)
            print(f"     {label:<10} {bar}  {score}/5")
        print(f"     {'Average':<10} {'':5}  {rubric['average']}/5")


def print_summary(results: list, label: str = ""):
    """Print the evaluation summary table."""
    total = len(results)
    if total == 0:
        print("No results to summarize.")
        return

    check_names = list(results[0]["checks"]["checks"].keys())
    check_totals = {name: 0 for name in check_names}
    all_pass_count = 0

    for r in results:
        if r["response"] is None:
            continue
        if r["checks"]["all_passed"]:
            all_pass_count += 1
        for name in check_names:
            if r["checks"]["checks"][name]["passed"]:
                check_totals[name] += 1

    print("\n" + "=" * 72)
    print(f"EVALUATION SUMMARY{' — ' + label if label else ''}")
    print("=" * 72)

    # Header
    abbrevs = [CHECK_ABBREVS.get(n, n[:6]) for n in check_names]
    header = f"  {'Scenario':<42} {'Bugs':>4}  {'All':>4}"
    for ab in abbrevs:
        header += f"  {ab:>6}"
    print(header)
    print("  " + "─" * 70)

    # Rows
    for r in results:
        s = r["scenario"]
        response_ok = r["response"] is not None
        if response_ok:
            all_ok = r["checks"]["all_passed"]
            status = "✅" if all_ok else "❌"
        else:
            status = "💀"  # API error

        sid = s["id"].replace("eval_", "")[:40]
        row = f"{status} {sid:<42} {s['expected_bug_count']:>4}  "

        if response_ok:
            all_icon = "✓" if r["checks"]["all_passed"] else "✗"
            row += f"{all_icon:>4}"
            for name in check_names:
                icon = "✓" if r["checks"]["checks"][name]["passed"] else "✗"
                row += f"  {icon:>6}"
        else:
            row += f"{'ERR':>4}" + f"  {'ERR':>6}" * len(check_names)

        print(f"  {row}")

    print("  " + "─" * 70)

    # Totals row
    tot_row = f"  {'TOTALS':<42} {'':>4}  {all_pass_count:>3}/{total}"
    for name in check_names:
        tot_row += f"  {check_totals[name]:>4}/{total}"
    print(tot_row)

    print("\n  Per-check pass rates:")
    for name in check_names:
        count = check_totals[name]
        pct = 100 * count / total if total else 0.0
        bar_full = int(pct / 5)
        bar = "█" * bar_full + "░" * (20 - bar_full)
        abbrev = CHECK_ABBREVS.get(name, name)
        print(f"    {abbrev:<8} [{bar}] {count:>2}/{total} ({pct:>5.1f}%)")

    print(f"\n  Overall: {all_pass_count}/{total} scenarios passed ALL checks "
          f"({100 * all_pass_count / total:.1f}%)")
    print("=" * 72)


def print_rubric_summary(results: list):
    """
    Print aggregate heuristic rubric scores across all scenarios (Section 6.2).
    Only includes results that have rubric data.
    """
    rubric_results = [r for r in results if r.get("rubric") and r["response"] is not None]
    if not rubric_results:
        return

    dims = ["completeness", "analysis_depth", "pedagogical_quality", "tone", "conciseness"]
    dim_labels = {
        "completeness":        "Completeness  ",
        "analysis_depth":      "Analysis depth",
        "pedagogical_quality": "Pedagogy      ",
        "tone":                "Tone          ",
        "conciseness":         "Conciseness   ",
    }

    print("\n" + "=" * 72)
    print("HEURISTIC RUBRIC SCORES — Section 6.2 (no LLM required)")
    print("=" * 72)
    print(f"  {'Dimension':<16} {'Avg':>5}   {'Distribution (1=poor … 5=excellent)'}")
    print("  " + "─" * 68)

    for dim in dims:
        scores = [r["rubric"][dim] for r in rubric_results]
        avg = sum(scores) / len(scores)
        # Distribution bar: each ★ = 1 scenario at that score
        dist = {i: scores.count(i) for i in range(1, 6)}
        bar_parts = []
        for s in range(1, 6):
            bar_parts.append(f"{s}:{'█' * dist[s] or '·'}")
        dist_str = "  ".join(bar_parts)
        label = dim_labels[dim]
        print(f"  {label}  {avg:>4.1f}   {dist_str}")

    # Overall average across all dimensions
    all_avgs = [r["rubric"]["average"] for r in rubric_results]
    overall = sum(all_avgs) / len(all_avgs)
    print("  " + "─" * 68)
    print(f"  {'Overall average':<16}  {overall:>4.1f}")

    # Grade interpretation
    grade = "Excellent" if overall >= 4.5 else ("Good" if overall >= 3.5 else
            ("Acceptable" if overall >= 2.5 else "Needs work"))
    print(f"\n  Grade: {grade} ({overall:.1f}/5.0)")
    print(f"  N = {len(rubric_results)} scenario(s) scored")
    print("=" * 72)


def print_quality_rubric_reminder():
    """Print the Section 6.2 rubric legend for reference."""
    print("\n" + "─" * 68)
    print("QUALITY RUBRIC LEGEND (Section 6.2)")
    print("─" * 68)
    dimensions = [
        ("Completeness",        "Misses bugs",       "Finds most bugs",    "Finds ALL bugs with severity"),
        ("Analysis depth",      "Echoes stderr",     "Explains what's wrong","Teaches debugging methodology"),
        ("Pedagogical quality", "Gives the answer",  "Asks a question",    "Targeted, right-difficulty question"),
        ("Tone",                "Robotic 🔴/🟢",     "Neutral",            "Warm, encouraging, conversational"),
        ("Multi-turn aware",    "Repeats response",  "Acknowledges follow-up","Adapts to student confusion level"),
        ("Conciseness",         "Too brief/long",    "Appropriate length", "Focused, no redundant content"),
    ]
    print(f"  {'Dimension':<22} {'1 (Poor)':<22} {'3 (OK)':<22} {'5 (Excellent)'}")
    print("  " + "─" * 64)
    for dim, poor, ok, excel in dimensions:
        print(f"  {dim:<22} {poor:<22} {ok:<22} {excel}")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# Compare mode
# ─────────────────────────────────────────────────────────────────────────────

def compare_results(path_a: str, path_b: str):
    """
    Compare two saved evaluation result JSON files and print improvement delta.
    """
    with open(path_a) as f:
        results_a = json.load(f)
    with open(path_b) as f:
        results_b = json.load(f)

    label_a = Path(path_a).stem
    label_b = Path(path_b).stem
    n_a = len(results_a)
    n_b = len(results_b)

    print("\n" + "=" * 68)
    print(f"COMPARISON")
    print(f"  BEFORE: {label_a} ({n_a} scenarios)")
    print(f"  AFTER:  {label_b} ({n_b} scenarios)")
    print("=" * 68)

    check_names = list(results_a[0]["checks"]["checks"].keys()) if results_a else []

    def count_pass(results, name):
        return sum(
            1 for r in results
            if r.get("response") and r["checks"]["checks"][name]["passed"]
        )

    print(f"\n  {'Check':<30} {'Before':>8} {'After':>8} {'Delta':>8}")
    print("  " + "─" * 56)

    for name in check_names:
        cnt_a = count_pass(results_a, name)
        cnt_b = count_pass(results_b, name)
        delta = cnt_b - cnt_a
        pct_a = 100 * cnt_a / n_a if n_a else 0.0
        pct_b = 100 * cnt_b / n_b if n_b else 0.0
        arrow = f"▲ +{delta}" if delta > 0 else (f"▼ {delta}" if delta < 0 else "── ±0")
        abbrev = CHECK_ABBREVS.get(name, name)
        print(f"  {abbrev:<30} {pct_a:>6.1f}%  {pct_b:>6.1f}%  {arrow:>8}")

    total_a = sum(1 for r in results_a if r.get("response") and r["checks"]["all_passed"])
    total_b = sum(1 for r in results_b if r.get("response") and r["checks"]["all_passed"])
    delta_total = total_b - total_a
    print("  " + "─" * 56)
    print(
        f"  {'Overall (all checks)':30} "
        f"{100 * total_a / n_a:>6.1f}%  "
        f"{100 * total_b / n_b:>6.1f}%  "
        f"{'▲ +' + str(delta_total) if delta_total > 0 else '▼ ' + str(delta_total) if delta_total < 0 else '── ±0':>8}"
    )
    print()

    # Scenario-level deltas for failed → fixed
    fixed = []
    broken = []
    # Build dicts by scenario id
    a_by_id = {r["scenario"]["id"]: r for r in results_a}
    b_by_id = {r["scenario"]["id"]: r for r in results_b}
    for sid in a_by_id:
        if sid not in b_by_id:
            continue
        was_pass = a_by_id[sid]["checks"]["all_passed"]
        now_pass = b_by_id[sid]["checks"]["all_passed"]
        if not was_pass and now_pass:
            fixed.append(sid)
        elif was_pass and not now_pass:
            broken.append(sid)

    if fixed:
        print(f"  Newly fixed ({len(fixed)}):")
        for sid in fixed:
            print(f"    ✅ {sid}")
    if broken:
        print(f"  Newly broken ({len(broken)}):")
        for sid in broken:
            print(f"    ❌ {sid}")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# Gold data loader
# ─────────────────────────────────────────────────────────────────────────────

def load_gold(data_path: str) -> list:
    """Load gold evaluation scenarios from a JSONL file."""
    scenarios = []
    with open(data_path) as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                scenarios.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"⚠️  Skipping line {line_num} (JSON error): {e}", file=sys.stderr)
    return scenarios


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    # Ensure UTF-8 output on Windows (needed for box-drawing and arrow chars)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Evaluate VoidCode AI DEBUG mode quality against a gold regression set",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--api-url", default=DEFAULT_API_URL,
        help=f"Base URL of the VoidCode AI API (default: {DEFAULT_API_URL})",
    )
    parser.add_argument(
        "--data", default=str(DEFAULT_GOLD_PATH),
        help=f"Path to gold JSONL file (default: {DEFAULT_GOLD_PATH})",
    )
    parser.add_argument(
        "--output", default=None,
        help="Save results to JSON file (auto-named by timestamp if not set)",
    )
    parser.add_argument(
        "--mode", choices=["baseline", "post-retrain"], default="baseline",
        help="Label for this evaluation run — used in output filename and summary",
    )
    parser.add_argument(
        "--compare", nargs=2, metavar=("BEFORE", "AFTER"),
        help="Compare two saved result JSON files instead of running eval",
    )
    parser.add_argument(
        "--scenario", default=None,
        help="Run only a specific scenario by ID (for debugging)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print full response preview and all check notes for each scenario",
    )
    parser.add_argument(
        "--timeout", type=int, default=120,
        help="HTTP timeout in seconds per API call (default: 120)",
    )
    parser.add_argument(
        "--rubric", action="store_true",
        help="Print the quality rubric legend at the end (reference only)",
    )
    parser.add_argument(
        "--rubric-score", action="store_true",
        help="Compute heuristic rubric scores (Section 6.2) for each response",
    )
    parser.add_argument(
        "--responses-file", default=None, metavar="PATH",
        help=(
            "JSON file mapping {scenario_id: response_text} for offline eval "
            "without a live API. Skips API calls entirely."
        ),
    )
    args = parser.parse_args()

    # ── Compare mode: no API calls ────────────────────────────────────────────
    if args.compare:
        compare_results(args.compare[0], args.compare[1])
        return

    # ── Load gold dataset ─────────────────────────────────────────────────────
    if not os.path.exists(args.data):
        print(f"❌ Gold dataset not found: {args.data}", file=sys.stderr)
        sys.exit(1)

    scenarios = load_gold(args.data)
    if args.scenario:
        scenarios = [s for s in scenarios if s["id"] == args.scenario]
        if not scenarios:
            print(f"❌ Scenario '{args.scenario}' not found in {args.data}", file=sys.stderr)
            sys.exit(1)

    if not scenarios:
        print("❌ No scenarios loaded.", file=sys.stderr)
        sys.exit(1)

    # ── Load offline responses (--responses-file mode) ────────────────────────
    offline_responses: dict = {}
    if args.responses_file:
        if not os.path.exists(args.responses_file):
            print(f"❌ Responses file not found: {args.responses_file}", file=sys.stderr)
            sys.exit(1)
        with open(args.responses_file, encoding="utf-8") as f:
            offline_responses = json.load(f)
        print(f"\n📂 Offline mode — loaded {len(offline_responses)} pre-generated responses")
        print(f"   from: {args.responses_file}")

    # ── Pre-flight: check API health (skip if offline) ────────────────────────
    print(f"\n{'=' * 68}")
    print("VOIDCODE AI — DEBUG MODE EVALUATION (Phase 3)")
    print(f"{'=' * 68}")
    if offline_responses:
        print(f"Mode    : OFFLINE (--responses-file)")
    else:
        print(f"API     : {args.api_url}")
    print(f"Dataset : {args.data} ({len(scenarios)} scenario(s))")
    print(f"Mode    : {args.mode}")
    if not offline_responses:
        print(f"Timeout : {args.timeout}s per request")
    if args.rubric_score:
        print(f"Rubric  : heuristic scoring enabled (Section 6.2)")
    print()

    if not offline_responses:
        print("Checking API health...", end=" ", flush=True)
        if check_api_health(args.api_url):
            print("✅ Online")
        else:
            print("⚠️  API health check failed — will attempt evaluation anyway")
        print()

    # ── Run evaluation ────────────────────────────────────────────────────────
    results = []

    for i, scenario in enumerate(scenarios, 1):
        sid = scenario["id"]
        stype = SCENARIO_TYPE_EMOJI.get(scenario["scenario_type"], scenario["scenario_type"])
        print(
            f"[{i:>2}/{len(scenarios)}] {sid:<48} {stype}",
            end="  ",
            flush=True,
        )

        # Fetch response — either from offline dict or live API
        if offline_responses:
            if sid not in offline_responses:
                print(f"⚠️  SKIPPED (no response in --responses-file)")
                continue
            response = offline_responses[sid]
            elapsed = 0.0
        else:
            t0 = time.time()
            try:
                # Multi-turn scenarios carry a full `messages` array; single-turn
                # scenarios use the flat `user_message` string.
                scenario_messages = scenario.get("messages")
                response = call_api(
                    args.api_url,
                    scenario["user_message"],
                    timeout=args.timeout,
                    messages=scenario_messages,
                )
                elapsed = time.time() - t0
            except Exception as exc:
                elapsed = time.time() - t0
                print(f"💀 ERROR ({elapsed:.1f}s): {exc}")
                results.append({
                    "scenario": scenario,
                    "response": None,
                    "error": str(exc),
                    "elapsed_seconds": round(elapsed, 2),
                    "checks": {
                        "all_passed": False,
                        "checks": {
                            name: {"passed": False, "note": "API error"}
                            for name in [
                                "bug_count_accuracy", "no_duplicate_bugs",
                                "source_code_citation", "no_answer_leakage",
                                "guiding_question", "positive_framing",
                            ]
                        },
                    },
                })
                continue

        checks = run_checks(response, scenario)
        result = {
            "scenario": scenario,
            "response": response,
            "error": None,
            "elapsed_seconds": round(elapsed, 2),
            "checks": checks,
        }

        # Heuristic rubric scoring (--rubric-score)
        rubric = None
        if args.rubric_score:
            rubric = score_rubric(response, scenario)
            result["rubric"] = rubric

        results.append(result)

        # One-line status
        elapsed_str = f"  ({elapsed:.1f}s)" if elapsed else ""
        if checks["all_passed"]:
            print(f"✅ All passed{elapsed_str}")
        else:
            failed = [
                CHECK_ABBREVS.get(k, k)
                for k, v in checks["checks"].items()
                if not v["passed"]
            ]
            print(f"❌ Failed: {', '.join(failed)}{elapsed_str}")

        if args.verbose:
            print_verbose_result(scenario, response, checks, rubric=rubric)

    # ── Summary table ─────────────────────────────────────────────────────────
    print_summary(results, label=args.mode)

    if args.rubric_score:
        rubric_results = [r for r in results if "rubric" in r]
        if rubric_results:
            print_rubric_summary(rubric_results)

    if args.rubric:
        print_quality_rubric_reminder()

    # ── Save results ──────────────────────────────────────────────────────────
    output_path = args.output
    if output_path is None:
        ts = time.strftime("%Y%m%d_%H%M%S")
        output_path = str(DATA_DIR / f"eval_results_{args.mode}_{ts}.json")

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False, default=str)

    print(f"\n💾 Results saved → {output_path}")
    print()
    print("Next steps:")
    print("  • Run again after Phase 2 retrain and compare:")
    print(f"    python llm/scripts/evaluate_debug_quality.py --mode post-retrain")
    print(f"    python llm/scripts/evaluate_debug_quality.py --compare \\")
    print(f"        {output_path} \\")
    print(f"        llm/data/eval_results_post-retrain_<timestamp>.json")
    print()


if __name__ == "__main__":
    main()
