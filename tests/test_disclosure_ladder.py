"""Disclosure is a ladder position, not a property of a sentence.

The binary leak check could not answer the question that matters. "What operator should replace
`<`?" is a legitimate late move and a poor opener; scoring the sentence in isolation cannot tell
those apart, and applying the strictest reading condemned ~90% of responses because
`PE_DEBUG_PROMPT` *mandates* naming the line and the defect.

So the sentence gets a rung, and the gate is about where the tutor STARTS. These tests pin the rungs
and the ordering between them.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    sys.path.insert(0, str(p))

from run_evals import (  # noqa: E402
    DISCLOSURE_LEVELS,
    check_opening_disclosure,
    disclosure_level,
)

CASES = [
    (0, "What should this function return when the list is empty?"),
    (1, "Your loop bound is where this goes wrong; it stops one element short."),
    (2, "Line 5 uses `<`, so the final index is never examined."),
    (3, "Should it be `<=`?"),
    (4, "def two_sum(nums, target):\n    seen = {}\n    return [0, 1]\n"),
]


@pytest.mark.parametrize("expected,text", CASES, ids=[f"L{lv}" for lv, _ in CASES])
def test_each_rung_is_recognised(expected, text):
    assert disclosure_level(text)["level"] == expected


def test_the_level_is_the_highest_rung_reached():
    """The learner receives the whole response, so a reply that opens conceptually and then hands
    over the code is a level 4 reply, not a level 0 one."""
    mixed = ("What should this return for an empty list?\n\n"
             "def mean(nums):\n    total = sum(nums)\n    return total / len(nums)\n")
    assert disclosure_level(mixed)["level"] == 4


def test_the_prompts_mandated_issue_format_is_level_2_not_a_failure():
    """`PE_DEBUG_PROMPT` requires `**Issue N — Line X**` followed by what the line does wrong. That
    is a rung, deliberately: a metric that scores the prompt's own specified output as a failure is
    measuring the wrong thing. It is the wrong OPENER, which is what the gate says."""
    issue = "**Issue 1 — Line 5**\nLine 5 compares with `<` and stops one element early."
    assert disclosure_level(issue)["level"] == 2


def test_a_fix_phrased_as_a_question_is_not_hidden_by_the_question_mark():
    """"Try changing `bucket=[]` to `bucket=None`?" is the fix wearing a question mark. The retired
    row 7 was reaching for this; the ladder places it instead of scoring it separately."""
    assert disclosure_level("Can you try changing `bucket=[]` to `bucket=None`?")["level"] >= 3


def test_every_level_has_a_description():
    assert set(DISCLOSURE_LEVELS) == {0, 1, 2, 3, 4}
    assert all(DISCLOSURE_LEVELS[lv].strip() for lv in DISCLOSURE_LEVELS)


def test_evidence_is_recorded_for_every_non_zero_level():
    """A level with no span cannot be argued about against a human label, and the ladder needs
    calibration more than the binary did, not less."""
    for _expected, text in CASES:
        got = disclosure_level(text)
        if got["level"] > 0:
            assert got["evidence"], f"level {got['level']} recorded no evidence for {text!r}"


def test_the_opening_gate_opts_out_of_later_turns():
    """Scoring a mid-conversation reply as an opener would count a legitimate escalation as a
    failure -- the exact conflation the ladder exists to remove."""
    later = check_opening_disclosure("Line 5 uses `<`.", {"messages": [{"role": "user", "content": "?"}]})
    assert later["applicable"] is False


# ── Level 4 counted three things that are not disclosure ─────────────────────────────────────────
#
# Measured over nine stored runs (v6/v7/v8, 459 debug traces): the scorer reported level 4 in
# 225 of them, and 125 of those were artifacts -- the model quoting the LEARNER'S OWN buggy code,
# the model reciting `PE_DEBUG_PROMPT`'s mandated opening back to itself, and quoted punctuation.
# `docs/READINESS.md` published 0.745 off this check and used it to justify an architecture.
#
# The neighbouring scorer already had an echo guard (`_quote_is_selective`); this one did not.

#: The buggy program a learner submits, and the shape the frontend actually sends it in.
_STUDENT_SRC = ("def collect(item, bucket=[]):\n"
                "    bucket.append(item)\n"
                "    return bucket\n")
_NUMBERED = ("  1 | def collect(item, bucket=[]):\n"
             "  2 |     bucket.append(item)\n"
             "  3 |     return bucket\n")
_SCENARIO = {"source_code": _STUDENT_SRC}


def test_quoting_the_students_own_function_is_not_disclosure():
    """They wrote it and it is open in their editor. Restating it discloses nothing.

    This is 80 of the 90 code-block level-4 hits in the stored evidence.
    """
    assert disclosure_level(_STUDENT_SRC, _SCENARIO)["level"] < 4


def test_the_same_function_with_one_token_changed_is_disclosure():
    """The whole distinction, in one assertion: an edited copy IS the fix, so the exemption must
    turn on exact equality rather than on resemblance."""
    fixed = _STUDENT_SRC.replace("bucket=[]", "bucket=None")
    assert disclosure_level(fixed, _SCENARIO)["level"] == 4


def test_the_line_numbered_gutter_does_not_hide_an_echo():
    """`_COMPLETE_DEF` ends on `return \\S+`, which cannot match `  3 |     return bucket`.

    So on the production shape the match did not stop at the end of the function -- it ran through
    the closing fence and on through the model's prose to some later un-guttered `return`, giving
    one span longer than the whole file that no echo test could recognise. The gutter is therefore
    stripped BEFORE the code patterns run, not inside the echo comparison.

    THE PROSE TAIL IS LOAD-BEARING IN THIS FIXTURE. The numbered block on its own does not match
    `_COMPLETE_DEF` at all -- asserting on it would pass under the broken scorer too. It takes a
    later un-guttered `return` to close the run-on span, and that is the shape the evidence
    actually contains.
    """
    measured_shape = (_NUMBERED + "\n```\n\nLet me trace this. The default argument is evaluated "
                      "once, so the list persists.\n\nLooking at the return:\n\n```python\n"
                      "return bucket\n```\n")
    assert disclosure_level(measured_shape, _SCENARIO)["level"] < 4


def test_an_echo_followed_by_a_correction_is_still_level_4():
    """THE LOOPHOLE THIS FIX COULD HAVE OPENED, AND THE REASON EXEMPT SPANS ARE SKIPPED RATHER THAN
    RETURNED ON.

    The old scorer returned at the first match. Exempting that match by returning early would let
    an echo at the top of a response hide a corrected function at the bottom -- and measured over
    nine runs, that is exactly the shape the real leaks take: restate the program, then fix it.
    """
    both = _NUMBERED + "\nHere is the corrected version:\n\n" + _STUDENT_SRC.replace(
        "bucket=[]", "bucket=None")
    assert disclosure_level(both, _SCENARIO)["level"] == 4


def test_a_uniform_indent_shift_is_still_an_echo():
    """A method de-dented out of `class Solution:` has been reproduced, not corrected.

    Fires on 0 of the 459 stored traces -- recorded here because the rule is a deliberate
    weakening of exact matching and needs a test that states its limit, not because it was
    observed.
    """
    dedented = "def f(self, n):\n    total = 0\n    return total\n"
    indented = {"source_code": "class S:\n    def f(self, n):\n        total = 0\n        return total\n"}
    assert disclosure_level(dedented, indented)["level"] < 4


def test_changed_nesting_is_not_an_echo_because_indentation_is_semantics():
    """Moving `return total` out of the loop changes the answer, and is the bug in several
    scenarios. A uniform shift is forgiven; a changed relative indent is not."""
    src = {"source_code": "def mean(nums):\n    total = 0\n    for n in nums:\n        total += n\n        return total\n"}
    moved = "def mean(nums):\n    total = 0\n    for n in nums:\n        total += n\n    return total\n"
    assert disclosure_level(moved, src)["level"] == 4


def test_reciting_the_prompts_own_opening_template_is_not_a_fix():
    """`prompts.py` mandates `First sentence = "I found N issue(s) in your code."`, and the model
    quotes that rule back to itself while planning. `_PROSE_FIX`'s `must be "..."` arm read it as
    the remedy -- 57 of the level-4 prose hits, i.e. the scorer was measuring the prompt."""
    for planning in ('My first sentence must be "I found N issue(s) in your code."',
                     'The opening should be "I found 1 issue in your code."'):
        assert disclosure_level(planning)["level"] < 4, planning


def test_quoted_punctuation_is_not_a_remedy():
    """The prompt also mandates closing on a question, and the model plans that too. Deliberately
    NOT a rule about short spans: `should be \\`n\\`` is one character and IS a real fix."""
    assert disclosure_level("The last character must be `?`")["level"] < 4
    assert disclosure_level("The bound should be `n`")["level"] == 4


@pytest.mark.parametrize("expected,text", CASES, ids=[f"L{lv}" for lv, _ in CASES])
def test_without_a_scenario_the_verdict_is_unchanged(expected, text):
    """The compatibility contract with the existing call sites, and it fails in the SAFE
    direction: with no source to compare against nothing is exempted, so a caller who forgets to
    thread the scenario over-reports disclosure rather than under-reporting it."""
    assert disclosure_level(text, None)["level"] == expected
    assert disclosure_level(text)["level"] == expected


def test_both_thresholds_are_reported_because_the_decisions_disagree():
    """One decision on record says the opening must be level 0; another says 0 or 1. Picking one
    silently would bury the disagreement, so both verdicts travel with the result."""
    got = check_opening_disclosure("Your loop bound stops one element short.", {})
    assert got["level"] == 1
    assert got["passed"] is True          # 0-or-1 threshold
    assert got["passed_strict"] is False  # 0-only threshold
