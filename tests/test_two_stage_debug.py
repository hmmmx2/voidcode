"""Stage B cannot leak the fix because it is never told the fix.

This is a structural claim, not a behavioural hope, and that distinction is the whole point of the
split. The single-stage prompt was rewritten to say "Level 4 — corrected code. NEVER" and measured:
the visible opening moved from level 2 to level 1 (0.204 -> 0.750, far outside the noise floor) and
the reasoning did not move at all — level 4 in the scratchpad was 76.0% before and 77.3% after.

Finding a bug and working out its fix are the same act, so instructing a model not to think about
the fix does not work. These tests pin the only thing that can work: the remedy is absent from the
context stage B receives.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(p))

from prompts import (  # noqa: E402
    DEBUG_LOCALISE_SCHEMA,
    PE_DEBUG_HINT_PROMPT,
    PE_DEBUG_LOCALISE_PROMPT,
)


def test_the_schema_has_no_field_that_could_carry_a_remedy():
    """THE MECHANISM, IN ONE ASSERTION.

    Stage A can only return a line and a symptom. There is no `fix`, no `correction`, no
    `suggested_code` field — so however stage A phrases itself, the remedy has no channel to reach
    stage B. Adding one would silently undo the split while every other test still passed.
    """
    fields = set(DEBUG_LOCALISE_SCHEMA["properties"]["issues"]["items"]["properties"])
    assert fields == {"line", "symptom"}, f"unexpected field on the stage A contract: {fields}"


def test_stage_a_is_told_the_symptom_is_not_the_remedy():
    """A `symptom` field is only a barrier if stage A knows what belongs in it."""
    flat = " ".join(PE_DEBUG_LOCALISE_PROMPT.split())
    assert "not the remedy" in flat
    assert "that is the fix" in flat, "the prompt must show what a remedy looks like, not just ban it"


def test_stage_b_is_told_it_does_not_know_the_fix():
    flat = " ".join(PE_DEBUG_HINT_PROMPT.split())
    assert "You do not know the fix" in flat
    assert "must not invent one" in flat


def test_stage_b_is_forbidden_the_things_that_scored_as_disclosure():
    """Each forbidden phrasing here is one the measurement actually caught: line numbers were the
    level 2 opener at 65.8%, and "should be" / "change X to Y" were the level 4 prose hits."""
    flat = " ".join(PE_DEBUG_HINT_PROMPT.split())
    for forbidden in ("No line numbers", "No quoted source lines", "No corrected code",
                      "should be", "change X to Y", "instead of"):
        assert forbidden in flat, f"stage B does not forbid: {forbidden}"


def test_the_hint_prompt_carries_location_and_symptom_and_nothing_more():
    pytest.importorskip("fastapi", reason="the builder lives in the API package")
    from src.main import _hint_system_prompt

    built = _hint_system_prompt([{"line": 5, "symptom": "the last element is never examined"}])
    assert "line 5" in built
    assert "the last element is never examined" in built
    assert "never repeat the line numbers" in built


def test_an_unexpected_stage_a_field_does_not_reach_stage_b():
    """Defence in depth: if a future stage A returns more than the contract allows, the builder must
    not pass it through. The schema is the barrier; this is the second one."""
    pytest.importorskip("fastapi", reason="the builder lives in the API package")
    from src.main import _hint_system_prompt

    built = _hint_system_prompt([
        {"line": 5, "symptom": "off by one", "fix": "use <= instead of <"},
    ])
    assert "use <=" not in built, "a remedy field leaked into stage B's context"


def test_two_stage_is_off_by_default():
    """It must be A/B-able against single-stage on one server, and rollback must be an env var
    rather than a revert."""
    pytest.importorskip("fastapi", reason="the flag lives in the API package")
    from src.main import USE_TWO_STAGE_DEBUG

    assert USE_TWO_STAGE_DEBUG is False
