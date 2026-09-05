"""A check must read the surface its evidence lives on.

Every check read whatever `score_one` was handed — the visible answer. That is right for all but
one: `bug_localisation` asks whether the tutor FOUND the bug, and the debug prompt deliberately
withholds line numbers from the opening reply, so the answer surface is engineered not to contain
the evidence. Measured on the same responses: 0.163 on the answer against 0.797 on the reasoning.

Because `all_passed` ANDs every applicable check, that one mis-routed check dragged the entire debug
mode to 0.078 and made the per-mode figure a statement about the disclosure policy rather than the
tutor. Rescoring with the surface declared gives 0.588, and **no other mode moves** — which is what
separates a targeted fix from a loosened scorer.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    sys.path.insert(0, str(p))

import run_evals as R  # noqa: E402

SCENARIO = {
    "user_message": "it returns the wrong value",
    "source_code": "def f(n):\n    total = 0\n    for x in n:\n        total = x\n    return total\n",
    "ground_truth_bugs": [{"line": 4, "type": "logic"}],
    "expected_bug_count": 1,
}
# What the tutor SAYS: a level-1 opener — region and symptom, no line number. Phase 1 working.
HINT = ("I found 1 issue in your code. Your accumulator inside the loop is not accumulating — it "
        "keeps only the last value it saw. What should happen to the running total on each pass?")
# What the tutor THOUGHT: the diagnosis, with the location.
REASONING = "Looking at the loop body, line 4 assigns instead of adding, so earlier values are lost."


def test_localisation_is_declared_diagnostic_and_everything_else_is_not():
    assert R.CHECK_SURFACE.get("bug_localisation") == "diagnostic"
    for other in ("asks_a_question", "no_invented_code", "no_answer_leakage", "bug_count_accuracy"):
        assert R.CHECK_SURFACE.get(other, "answer") == "answer", (
            f"{other} reads what the learner is shown; only localisation asks a different question")


def test_a_level_1_hint_with_a_located_reasoning_scores_as_found():
    """THE REGRESSION. This is the intended product behaviour — withhold the line, know the line —
    and before the fix it scored as a failure to find the bug."""
    scored = R.score_one(HINT, SCENARIO, "debug", thinking=REASONING)
    loc = scored["checks"]["bug_localisation"]
    assert loc["passed"] is True, "the tutor located the bug in its reasoning and must be credited"
    assert loc["surface"] == "diagnostic"


def test_the_same_hint_alone_does_not_count_as_locating():
    """Without reasoning the diagnostic surface falls back to the answer, and this answer genuinely
    contains no location. The fix must not credit a tutor that never found the bug."""
    scored = R.score_one(HINT, SCENARIO, "debug")
    assert scored["checks"]["bug_localisation"]["passed"] is False


def test_answer_surface_checks_ignore_the_reasoning():
    """`no_answer_leakage` and friends judge what the LEARNER receives. A solution in the reasoning
    must not fail them — it is withheld server-side — and must not pass them either by being absent
    from the answer for the wrong reason.
    """
    leaky_reasoning = "def f(n):\n    total = 0\n    for x in n:\n        total += x\n    return total\n"
    scored = R.score_one(HINT, SCENARIO, "debug", thinking=leaky_reasoning)
    assert scored["checks"]["no_answer_leakage"]["passed"] is True, (
        "a fix in the reasoning must not fail a check about the answer")
    assert scored["checks"]["no_answer_leakage"]["surface"] == "answer"


def test_every_check_records_which_surface_it_read():
    """Un-recorded surface is how the original defect stayed invisible: the figure looked like a
    property of the tutor rather than of the plumbing."""
    scored = R.score_one(HINT, SCENARIO, "debug", thinking=REASONING)
    for name, result in scored["checks"].items():
        if result.get("applicable"):
            assert result.get("surface") in ("answer", "diagnostic"), f"{name} records no surface"


def test_offline_callers_still_work_without_reasoning():
    """`--score` and older evidence files carry no reasoning. They must keep scoring rather than
    raise, with the diagnostic surface falling back to the answer."""
    scored = R.score_one("some response with line 4 named", SCENARIO, "debug")
    assert scored["n_applicable"] > 0
