"""Code attached + a stated failure symptom is a debug submission, decided by rule not by keywords.

The keyword classifier had **100% precision and 29/51 recall** on debug — too strict, not confused.
All 22 misroutes shared one profile (code present, not a problem paste, not anaphoric) and fell
through to the sink, which returns `explain` because attaching code makes `is_programming_related`
true. The single flag added to rescue debug was also what routed it away.

    rule alone (debug vs not)   61/75 = 0.813
    model alone (full routing)  53/75 = 0.707
    hybrid, rule first          70/75 = 0.933      false positives: 0

The tests here guard the two properties that make a rule safe in front of a classifier: it must fire
on the shapes it was built for, and it must not fire on anything else. A rule with false positives
would trade debug's recall for other modes' precision, which is not a win.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts", ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(p))

from prompts import looks_like_debug_submission  # noqa: E402

CODE = "\n\n[SOURCE CODE (python)]\n```python\ndef f(n):\n    return n\n```"

FIRES = [
    "My solution returns 0 for all-negative arrays but the answer should be -1",
    "My anagram checker crashes before it can run",
    "My linked list reversal goes into an infinite loop",
    "top_k returns the wrong records",
    "This works the first time I call it but the output keeps growing",
    "Always returns 0 no matter what coins I pass",
    "3Sum solution returns duplicate triplets sometimes",
    "My merge solution always misses the first element",
    "it fails the test for an empty list",
]

DOES_NOT_FIRE = [
    "Can you explain how binary search works?",
    "Walk me through dynamic programming",
    "What is the difference between a list and a tuple?",
    "Can you review this and tell me if it is idiomatic?",
    "I finished this, is there a neater way to write it?",
]


@pytest.mark.parametrize("text", FIRES, ids=[t[:28] for t in FIRES])
def test_it_fires_on_a_code_submission_with_a_symptom(text):
    assert looks_like_debug_submission(text + CODE) is True


@pytest.mark.parametrize("text", DOES_NOT_FIRE, ids=[t[:28] for t in DOES_NOT_FIRE])
def test_it_does_not_fire_without_a_failure_symptom(text):
    """Code attached is not enough. A learner asking for a review or an explanation has attached
    code too, and routing them to debug would trade one mode's recall for another's precision."""
    assert looks_like_debug_submission(text + CODE) is False


@pytest.mark.parametrize("text", FIRES[:4], ids=[t[:28] for t in FIRES[:4]])
def test_a_symptom_without_code_is_not_a_submission(text):
    """A symptom described with no code is a question about behaviour, not a debugging request --
    and the tutor cannot debug what it cannot see."""
    assert looks_like_debug_submission(text) is False


def test_it_reads_the_raw_message_not_the_extracted_intent():
    """`_extract_user_intent` strips the code blocks, so a rule reading the intent would never see
    the submission it exists to detect: same words, code removed, opposite verdict."""
    words = "it returns the wrong value"
    assert looks_like_debug_submission(words + CODE) is True
    assert looks_like_debug_submission(words) is False, "no code means nothing to debug"


def test_a_vague_complaint_with_code_is_left_to_the_classifier():
    """"Why is this wrong?" states no observable symptom, so the rule declines and the keyword
    classifier decides. That is the intended division of labour: the rule takes the cases with a
    clear structural signature and abstains on the rest rather than guessing.

    It is also why the rule does not reach 51/51 — some gold scenarios are genuinely vague.
    """
    assert looks_like_debug_submission("why is this wrong?" + CODE) is False


def test_a_fenced_block_counts_as_code_not_just_the_frontend_markers():
    """Two real production shapes: the workspace UI sends [SOURCE CODE], a learner pasting into the
    chat box sends a fence. Both are submissions."""
    assert looks_like_debug_submission(
        "it crashes\n```python\ndef f():\n    return 1\n```") is True


def test_distress_still_wins_over_the_rule():
    """A learner in distress with code attached gets empathy, not a bug list. The rule sets `debug`
    and `detect_frustration` overrides it afterwards -- the ordering in `decide_mode` is what makes
    that true, so it is asserted end to end rather than assumed."""
    pytest.importorskip("fastapi", reason="decide_mode lives in the API package")
    from src.main import decide_mode

    cry = "I give up, I'm terrible at this and my code just crashes" + CODE
    assert looks_like_debug_submission(cry) is True, "the rule alone would say debug"
    assert decide_mode(cry, 1)[0] == "empathy", "distress must still override the rule"


def test_the_measured_rates_are_reproducible():
    """The numbers in the docstrings are claims about this repo, so they are checked rather than
    quoted. A drift here means the rule's justification no longer holds."""
    sys.argv = ["x"]
    # The guard the sibling test above already has, and the only one of the twelve
    # `src.main` importers in this directory that was missing it -- with `test_eval_gold_sets`
    # and `test_grounding_wiring`'s two. All four failed the light CI job on `uvicorn`.
    pytest.importorskip("fastapi", reason="the router lives in the API package")
    import routing_eval as RE
    from src.main import decide_mode

    scen = RE.load_scenarios()
    hits = sum(1 for s in scen
               if decide_mode(RE.enriched(s)[0], len(s.get("messages") or []) or 1)[0] == s["mode"])
    assert hits >= 70, f"hybrid routing is {hits}/75, below the measured 70/75"

    dbg = [s for s in scen if s["mode"] == "debug"]
    rec = sum(1 for s in dbg
              if decide_mode(RE.enriched(s)[0], 1)[0] == "debug")
    assert rec >= 46, f"debug recall is {rec}/51, below the measured 46/51"

    # Zero false positives is the property that makes the rule safe; assert it directly.
    fp = [s["id"] for s in scen
          if s["mode"] != "debug" and looks_like_debug_submission(RE.enriched(s)[0])]
    assert not fp, f"the rule now fires on non-debug scenarios: {fp}"
