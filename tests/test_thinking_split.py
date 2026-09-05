"""`strip_thinking_tags` must split on the tag shape the model ACTUALLY emits.

This function had no tests at all, and the one assumption it encoded -- that a thinking span is
delimited by a matched `<think>`/`</think>` pair -- was false for the served model. Qwen3.5-9B emits
only the closing tag. The result was not a crash but a silently wrong number: the grader scored the
model's private reasoning as though the learner had read it, and `bug_localisation` came out 39/51
when the visible answer supports 30/51.

So these tests are written against the three shapes that can arrive, and
`test_the_closing_only_shape_is_what_production_actually_emits` is pinned to the real evidence file
rather than to a handwritten string -- a fixture I invent cannot show that the shape is real.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts", ROOT / "llm" / "scripts"):
    sys.path.insert(0, str(p))

from prompts import strip_thinking_tags  # noqa: E402

EVIDENCE = ROOT / "docs" / "evidence" / "eval_production_sglang_75.json"


def test_paired_tags_still_strip():
    """The shape the original implementation handled must keep working."""
    answer, thinking = strip_thinking_tags("<think>weighing it up</think>Line 5 is off by one.")
    assert answer == "Line 5 is off by one."
    assert thinking == "weighing it up"


def test_closing_tag_alone_separates_reasoning_from_answer():
    """THE CASE THAT WAS BROKEN. No opener, so the old pattern matched nothing and returned the
    reasoning as the answer."""
    raw = "Thinking Process:\n1. the bug is the `<` on line 5\n</think>Which comparison ends the loop?"
    answer, thinking = strip_thinking_tags(raw)
    assert answer == "Which comparison ends the loop?"
    assert "Thinking Process" in thinking
    assert "</think>" not in answer and "</think>" not in thinking


def test_the_first_closing_tag_is_the_boundary():
    """Streaming splits on the first bare `</think>`; this must agree, or the two paths disagree
    about where the answer starts for the same response."""
    answer, _ = strip_thinking_tags("a</think>b</think>c")
    assert answer == "b</think>c"


def test_an_unterminated_opening_tag_yields_no_answer():
    """Generation cut off inside the thinking phase -- a max_tokens hit. Returning the reasoning as
    the answer here would be the original bug wearing a different tag."""
    answer, thinking = strip_thinking_tags("<think>still working through it")
    assert answer == ""
    assert thinking == "still working through it"


def test_a_response_with_no_tags_is_all_answer():
    answer, thinking = strip_thinking_tags("Line 5 is off by one.")
    assert answer == "Line 5 is off by one."
    assert thinking == ""


def test_the_modes_that_disable_thinking_actually_get_it_disabled():
    """`empathy` and `followup` set `enable_thinking: False` because, unbounded, the model spends
    2000+ tokens reasoning before `</think>` -- against ceilings of 512 and 1024.

    The non-streaming path used to hardcode `{"enable_thinking": True}` and send no budget, so those
    two modes had thinking forced back on and uncapped on exactly the path with least room for it.
    Both paths now build the payload through one function; this asserts the result, not the call.
    """
    pytest.importorskip("fastapi", reason="the payload builder lives in the API package")
    sys.path.insert(0, str(ROOT / "apps" / "api"))
    from prompts import get_generation_config
    from src.main import _sglang_extra_body

    def body(mode):
        c = get_generation_config(mode)
        return _sglang_extra_body(
            top_k=c.get("top_k", 20), min_p=c.get("min_p", 0.0),
            enable_thinking=c.get("enable_thinking", True),
            thinking_budget_tokens=c.get("thinking_budget_tokens", 512),
        )["chat_template_kwargs"]

    for mode in ("empathy", "followup"):
        kw = body(mode)
        assert kw["enable_thinking"] is False, f"{mode} must not think"
        assert "thinking_budget_tokens" not in kw, (
            f"{mode} disables thinking; sending a budget alongside is contradictory")

    # And the modes that DO think must carry their own cap, not a shared default.
    assert body("teaching")["thinking_budget_tokens"] == 1024
    assert body("debug")["thinking_budget_tokens"] == 512
    assert body("general")["thinking_budget_tokens"] == 300


@pytest.mark.skipif(not EVIDENCE.is_file(), reason="production evidence file not present")
def test_the_closing_only_shape_is_what_production_actually_emits():
    """Pinned to measurement, not to a fixture I wrote.

    If a future model or a `--reasoning-parser` change starts emitting paired tags, this fails and
    the split logic should be revisited rather than silently carrying a branch nothing exercises.
    """
    rows = json.loads(EVIDENCE.read_text(encoding="utf-8"))["results"]
    closing = sum(1 for r in rows if "</think>" in r["response"])
    opening = sum(1 for r in rows if "<think>" in r["response"])
    assert closing > 0, "no response carries a thinking span; the split has nothing to do"
    assert opening == 0, (
        f"{opening} responses now carry an OPENING tag -- production changed shape, "
        "re-check strip_thinking_tags against it"
    )


@pytest.mark.skipif(not EVIDENCE.is_file(), reason="production evidence file not present")
def test_splitting_the_evidence_recovers_the_visible_answer_rates():
    """The whole correction in one assertion.

    Scoring the split answer must reproduce the visible-answer column, not the inflated one. If this
    drifts, either the splitter or the grader changed and the ledger's numbers no longer describe
    what a learner reads.
    """
    import run_evals

    rows = json.loads(EVIDENCE.read_text(encoding="utf-8"))["results"]
    debug = [r for r in rows if r["scenario"].get("mode") == "debug"]
    located = sum(
        1 for r in debug
        if run_evals.check_bug_localisation(
            strip_thinking_tags(r["response"])[0], r["scenario"]).get("passed")
    )
    # 30/51 measured. Bounded rather than pinned exactly: the grader is allowed to improve, but a
    # jump back toward 39 would mean thinking is leaking into the scored text again.
    assert 26 <= located <= 34, f"visible-answer localisation is {located}/51, expected ~30/51"
