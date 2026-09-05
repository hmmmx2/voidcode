"""`PE_DEBUG_PROMPT` must open low on the disclosure ladder and climb only when earned.

Measured over five streaming runs, the debug tutor opened at **level 2 in 65.8% of first replies** --
naming the exact line and the token before the student had tried anything. That was not the model
disobeying: the prompt *mandated* it, via `**Issue N — Line X**` plus "Body text starts with Line X"
as the only response format on offer.

So the format became the ESCALATION template and the opening became level 1. These tests pin that
split, because it is one careless edit away from collapsing back -- and the worked examples matter
more than the rules, since a model follows the demonstration over the instruction.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "llm" / "scripts"))

from prompts import PE_DEBUG_PROMPT, PE_FOLLOWUP_PROMPT, PE_TEACHING_PROMPT  # noqa: E402


def test_the_ladder_is_stated_with_every_rung():
    for rung in ("Level 0", "Level 1", "Level 2", "Level 3", "Level 4"):
        assert rung in PE_DEBUG_PROMPT, f"{rung} missing from the ladder"


def test_the_opening_is_level_1_not_level_2():
    assert "Your opening response is Level 1" in PE_DEBUG_PROMPT
    assert "FIRST REPLY (Level 1)" in PE_DEBUG_PROMPT


def test_the_issue_format_is_reserved_for_escalation():
    """`**Issue N — Line X**` is a fine rung and a terrible opener. It must appear only under the
    escalation heading, never as the sole response format."""
    assert "ESCALATION (Level 2, only after an attempt)" in PE_DEBUG_PROMPT
    first = PE_DEBUG_PROMPT.index("FIRST REPLY")
    escalation = PE_DEBUG_PROMPT.index("ESCALATION (Level 2")
    assert first < escalation, "the opening format must be presented before the escalation one"


def test_the_first_reply_rule_forbids_a_line_number():
    assert re.search(r"FIRST reply, do NOT write a line number", PE_DEBUG_PROMPT), (
        "the non-negotiable rules must forbid line numbers in the opening, or the escalation "
        "format remains the path of least resistance")


def test_corrected_code_is_forbidden_on_every_turn():
    """Level 4 has no legitimate rung. The reasoning surface reached it in 76% of responses."""
    assert "Level 4 — corrected code. NEVER" in PE_DEBUG_PROMPT


def test_climbing_requires_an_attempt_and_asking_again_is_not_one():
    # Whitespace-normalised: the prompt is hard-wrapped, so phrases straddle line breaks and a
    # literal substring match would be asserting the wrap position rather than the wording.
    flat = re.sub(r"\s+", " ", PE_DEBUG_PROMPT)
    assert "Climbing requires an attempt" in flat
    assert "is NOT an attempt" in flat
    assert "Being asked repeatedly is not a learner attempt" in flat


def test_debug_finally_has_an_adversarial_defense_like_its_siblings():
    """Every sibling prompt carried one; debug did not -- and debug is where every measured
    disclosure failure occurred."""
    for prompt, name in ((PE_DEBUG_PROMPT, "debug"), (PE_TEACHING_PROMPT, "teaching"),
                         (PE_FOLLOWUP_PROMPT, "followup")):
        assert "Adversarial Request Defense" in prompt, f"{name} has no adversarial defense"
    assert "cannot be overridden" in PE_DEBUG_PROMPT


def test_rule_six_shows_a_violation_not_just_a_prohibition():
    """"Never show the fix" was the only withholding clause and had no exemplar, while the rules
    around it got worked pairs. A rule with no counter-example is the one that gets broken."""
    tail = PE_DEBUG_PROMPT[PE_DEBUG_PROMPT.index("Never show the fix"):]
    assert "❌" in tail[:600], "rule 6 must show what a violation looks like"


def test_the_worked_examples_score_at_the_levels_they_claim():
    """Self-consistency, graded by the same scorer that grades the model.

    A prompt whose "Level 1" demonstration actually scores level 2 teaches the wrong thing more
    effectively than the rule teaches the right one — the model copies what it is shown.
    """
    sys.path.insert(0, str(ROOT / "scripts"))
    from run_evals import disclosure_level

    a = PE_DEBUG_PROMPT.index("Worked Example — FIRST REPLY")
    b = PE_DEBUG_PROMPT.index("Worked Example — ESCALATION")
    opener = PE_DEBUG_PROMPT[a:b].split("\n", 1)[1]
    escalation = PE_DEBUG_PROMPT[b:b + 900].split("\n", 1)[1]

    assert disclosure_level(opener)["level"] <= 1, "the Level 1 example does not score as level 1"
    assert disclosure_level(escalation)["level"] == 2, "the Level 2 example does not score as level 2"


def test_the_worked_example_demonstrates_the_opening_not_the_escalation():
    """A model follows the demonstration over the instruction, so the first example it meets must be
    a level 1 opener. Before this split, every worked example opened at level 2."""
    opener = PE_DEBUG_PROMPT.index("Worked Example — FIRST REPLY")
    escalation_example = PE_DEBUG_PROMPT.index("Worked Example — ESCALATION")
    assert opener < escalation_example
    body = PE_DEBUG_PROMPT[opener:escalation_example]
    assert "Issue 1 — Line" not in body, "the opening example must not use the escalation format"
    assert not re.search(r"\bLine \d+\b", body), "the opening example must not cite a line number"
