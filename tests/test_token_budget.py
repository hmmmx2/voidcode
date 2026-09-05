"""A misroute must cost the prompt, and only the prompt.

It used to cost three things at once. The routed mode decided the system prompt, whether the request
was grounded, AND how many tokens the answer could use — so a debug submission landing in `followup`
got the wrong prompt, lost retrieval, and was truncated at 1024 tokens. Two of those three are
invisible in the output: the learner sees a short, sourceless answer and cannot tell why.

Grounding is decoupled in `test_grounding_wiring.py`. This covers the budget: it is floored by the
REQUEST SHAPE, which is a fact about what the learner sent rather than a guess about what they meant.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(p))

pytest.importorskip("fastapi", reason="the budget lives in the API package")

from src.main import _SUBMISSION_TOKEN_FLOOR, token_budget  # noqa: E402

SUBMISSION = "it returns the wrong value\n\n[SOURCE CODE (python)]\n```python\ndef f():\n    return 1\n```"
CHAT = "why does that matter?"


def test_a_misrouted_submission_is_not_truncated():
    """THE DEFECT THIS EXISTS FOR. `followup` allows 1024 and `empathy` 512; a code submission
    landing in either was cut off mid-answer on top of getting the wrong prompt."""
    for wrong_mode in ("followup", "empathy", "general"):
        assert token_budget(wrong_mode, SUBMISSION, None) >= _SUBMISSION_TOKEN_FLOOR, (
            f"a submission misrouted to {wrong_mode} is still being truncated")


def test_a_short_conversational_turn_keeps_its_small_allowance():
    """The floor is a fact about the REQUEST, not a blanket increase. If it applied everywhere, every
    'why does that matter?' would be handed 4096 tokens and the per-mode budgets would be dead."""
    assert token_budget("followup", CHAT, None) == 1024
    assert token_budget("empathy", CHAT, None) == 512


def test_the_modes_own_budget_still_wins_when_it_is_larger():
    """`teaching` asks for 8192 and must keep it — the floor may only ever raise a budget."""
    assert token_budget("teaching", SUBMISSION, None) == 8192
    assert token_budget("teaching", CHAT, None) == 8192


def test_an_explicit_request_can_lower_but_not_raise():
    """A client may ask for less. It may not ask for more than the mode allows, or the per-mode caps
    become advisory."""
    assert token_budget("debug", SUBMISSION, 500) == 500
    assert token_budget("empathy", CHAT, 99999) == 512


def test_no_sglang_path_clamps_on_the_route_alone():
    """Both SGLang paths must go through `token_budget`. A site left on the old
    `min(request.max_tokens or cfg, cfg)` would silently reintroduce the truncation for half the
    traffic, and streaming versus non-streaming is exactly the split that has diverged before.
    """
    main_src = (ROOT / "apps" / "api" / "src" / "main.py").read_text(encoding="utf-8")
    assert main_src.count("token_budget(") >= 3, "both SGLang paths must use the shape-aware budget"
    assert 'min(\n                request.max_tokens or gen_cfg["max_new_tokens"]' not in main_src
