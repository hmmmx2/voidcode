"""Tests for the V6 eval scorer.

The point of these is that the scorer DISCRIMINATES. A scorer that passes every response is worse
than no scorer, because it produces a number that looks like evidence — and the harness it replaces
had exactly that shape: six regex checks against an output format, which a prompt rewrite moves on
its own without the tutor changing.

So the assertions are all paired: a correct response passes AND an incorrect one fails.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from run_evals import (  # noqa: E402
    check_bug_localisation,
    check_mentions_required,
    check_no_answer_leakage,
    cited_lines,
    load_gold,
    score_one,
    summarise,
    wilson,
)

SCENARIO = {
    "id": "t1", "mode": "debug", "difficulty": "easy",
    "source_code": "\n".join(f"line{i}" for i in range(1, 9)),
    "ground_truth_bugs": [{"line": 5, "type": "logic", "description": "wrong comparison"}],
}


# ── the correctness check ────────────────────────────────────────────────────

def test_bug_localisation_separates_the_right_line_from_a_wrong_one():
    """The check the previous harness lacked. `source_code_citation` only asserted that SOME valid
    line was cited, so a tutor confidently pointing at the wrong line passed it."""
    assert check_bug_localisation("The bug is on **Line 5**.", SCENARIO)["passed"] is True
    assert check_bug_localisation("The bug is on **Line 2**.", SCENARIO)["passed"] is False


def test_shotgunning_every_line_is_caught_by_precision():
    """Recall alone is gameable: naming every line finds every bug. Precision is why both are
    reported, and this pins that it actually drops."""
    shotgun = " ".join(f"Line {i}" for i in range(1, 9))
    result = check_bug_localisation(shotgun, SCENARIO)
    assert result["recall"] == 1.0
    assert result["precision"] < 0.2


def test_line_numbers_beyond_the_source_are_ignored():
    """A model inventing 'Line 400' on an 8-line file is not citing anything real."""
    assert cited_lines("Line 5 and Line 400", max_line=8) == {5}


def test_localisation_is_not_applicable_without_ground_truth():
    """Teaching and explain scenarios carry no bug lines; the check must opt out rather than fail
    them, or every non-debug scenario scores zero for a reason unrelated to quality."""
    assert check_bug_localisation("anything", {"ground_truth_bugs": []})["applicable"] is False


# ── the format-independent property that matters ─────────────────────────────

def test_localisation_survives_a_format_rewrite():
    """The whole argument for this check. Three different output formats, same verdict — so editing
    PE_DEBUG_PROMPT cannot move this score the way it moves the format checks."""
    for phrasing in ("**Issue 1 — Line 5**", "line 5 looks wrong", "Line: 5"):
        assert check_bug_localisation(phrasing, SCENARIO)["passed"] is True


# ── leakage ──────────────────────────────────────────────────────────────────

def test_a_complete_solution_is_leakage_but_a_scaffold_is_not():
    leaked = "def twoSum(self, nums, target):\n    seen = {}\n    return [1, 2]\n"
    scaffold = "def twoSum(self, nums, target):\n    seen = ____\n    return ____\n"
    assert check_no_answer_leakage(leaked, SCENARIO)["passed"] is False
    assert check_no_answer_leakage(scaffold, SCENARIO)["passed"] is True


def test_prose_stating_the_fix_IS_leakage():
    """REVERSED, deliberately. This asserted the opposite and was the scorer's biggest blind spot.

    "Describing the fix in words is teaching" is the claim it encoded. It is not: a learner told to
    swap their two indices has nothing left to work out. `docs/LEAK_RUBRIC.md` row 3 makes prose a
    leak, and the rubric was written down BEFORE this change so the reversal is a recorded decision
    rather than a moved goalpost. The measured leak rate rises as a result, which is a correction.
    """
    hit = check_no_answer_leakage("Swap the two indices in your return statement.", SCENARIO)
    assert hit["passed"] is False
    assert hit["rows_hit"] == ["3"]


def test_guiding_prose_is_still_clean():
    """The verb carries the distinction, so the counter-case has to hold or the check is just
    'any imperative is a leak' -- which would fail every well-formed hint."""
    for guiding in ("Look at your loop bound and trace the last iteration.",
                    "Check what value `i` holds when the loop exits.",
                    "Consider which index the problem asks you to return."):
        assert check_no_answer_leakage(guiding, SCENARIO)["passed"] is True, guiding


def test_a_leaked_method_in_a_brace_language_is_caught():
    """PE_DEBUG_PROMPT ships Java and C# worked examples, so a Python-only check could not see a
    leak in the languages the prompt most often produces."""
    java = ("public int maxDepth(TreeNode root) {\n"
            "    if (root == null) { return 0; }\n"
            "    return 1 + Math.max(left, right);\n}")
    assert check_no_answer_leakage(java, SCENARIO)["passed"] is False


def test_an_annotated_signature_is_caught():
    """`def f(x) -> list:` did not match the old pattern at all."""
    leaked = "def two_sum(nums: list, target: int) -> list:\n    seen = {}\n    return [0, 1]\n"
    assert check_no_answer_leakage(leaked, SCENARIO)["passed"] is False


def test_the_scaffold_exemption_is_span_local():
    """One `____` anywhere used to whitelist a fully-leaked function elsewhere in the same reply."""
    mixed = ("Here is the shape:\n\ndef helper(x):\n    return ____\n\n"
             "And here is the answer:\n\ndef two_sum(nums, target):\n    seen = {}\n    return [0, 1]\n")
    result = check_no_answer_leakage(mixed, SCENARIO)
    assert result["passed"] is False, "a scaffold elsewhere must not excuse a complete solution"
    assert any("two_sum" in h["span"] for h in result["hits"])


def test_the_legacy_entry_point_gives_the_same_verdict():
    """`llm/scripts/evaluate_debug_quality.py` held a SECOND, non-equivalent copy of the leak regex.

    They had drifted both ways -- the legacy one matched annotated signatures this one missed, this
    one matched across prose/fence boundaries the legacy one required indented. Two definitions of
    the product's core promise means the leak rate depends on which script you ran. The legacy entry
    point now delegates; this pins that it still does.
    """
    import sys as _sys
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "llm" / "scripts"))
    from evaluate_debug_quality import check_no_answer_leakage as legacy

    for text in ("def f(a):\n    return a + 1\n",
                 "Look at your loop bound and trace the last iteration.",
                 "Swap the two indices in your return statement.",
                 "def g(x):\n    return ____\n"):
        assert legacy(text)["passed"] is check_no_answer_leakage(text, SCENARIO)["passed"], text


def test_failures_record_an_adjudicable_span():
    """A failure that says only `passed: false` cannot be argued about against a human label, and
    calibration is exactly an argument about specific text."""
    result = check_no_answer_leakage("def f(a):\n    return a + 1\n", SCENARIO)
    assert result["hits"] and result["hits"][0]["span"]
    assert result["rows_covered"] and result["rows_not_covered"], (
        "the scorer must declare which rubric rows it does NOT implement")


# ── coverage ─────────────────────────────────────────────────────────────────

def test_mentions_required_reports_what_was_missed():
    s = {"must_mention": ["variance", "softmax"]}
    hit = check_mentions_required("The variance grows, so the softmax saturates.", s)
    miss = check_mentions_required("It is done for numerical stability.", s)
    assert hit["passed"] is True and hit["covered"] == 2
    assert miss["passed"] is False and set(miss["missing"]) == {"variance", "softmax"}


# ── intervals ────────────────────────────────────────────────────────────────

def test_wilson_stays_inside_the_unit_interval_at_small_n():
    """The reason for Wilson over the normal approximation: at n=1 the normal interval leaves [0,1]
    entirely, which is how a single-scenario bucket gets quoted as a confident result."""
    low, high = wilson(1, 1)
    assert 0.0 <= low <= high <= 1.0
    assert low < 0.5, "a single success must not imply a confident rate"


def test_wilson_narrows_as_n_grows():
    narrow = wilson(50, 100)
    wide = wilson(5, 10)
    assert (narrow[1] - narrow[0]) < (wide[1] - wide[0])


def test_the_documented_33_scenario_interval_is_what_the_docstring_claims():
    """The module docstring cites roughly [0.19, 0.51] for 11/33. If that stops being true the
    docstring is wrong, and this is what says so."""
    low, high = wilson(11, 33)
    assert round(low, 2) == 0.20 and round(high, 2) == 0.50


# ── the summary ──────────────────────────────────────────────────────────────

def test_every_reported_rate_carries_its_denominator():
    """A rate without n is the thing this harness exists to stop being printed."""
    scored = [{"scenario": SCENARIO, "response": "Line 5?",
               "score": score_one("Line 5?", SCENARIO, "debug")}]
    summary = summarise(scored)
    for block in (summary["by_bucket"], summary["by_check"]):
        for row in block.values():
            assert "n" in row and "ci95" in row


def test_all_four_modes_have_a_gold_set():
    """Debug had 33 scenarios and the other three had none, so most of what prompts.py routes was
    unevaluated. This fails if a gold set is deleted or a mode is added without one."""
    scenarios = load_gold()
    modes = {s.get("mode") for s in scenarios}
    assert {"debug", "teaching", "explain", "followup"} <= modes
    assert len(scenarios) >= 45
