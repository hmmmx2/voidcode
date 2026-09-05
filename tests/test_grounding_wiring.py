"""V2: grounding is wired into the tutor path, for the right modes, and cannot break a chat.

The wiring is the part that turns a corpus and a reader into a product. Without it V2 is another
well-built artefact joining to nothing — the exact criticism the audit levels at the Spark
pipeline, and a pattern this project has already had to undo twice.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))

MAIN = (ROOT / "apps" / "api" / "src" / "main.py").read_text(encoding="utf-8")


def test_grounding_is_called_from_the_prompt_assembly() -> None:
    assert "_should_ground(mode)" in MAIN and "_ground(system_prompt, user_intent)" in MAIN


def test_grounding_is_decided_by_harm_not_by_routing() -> None:
    """INVERTED, deliberately. This asserted that only `explain` and `teaching` ground.

    Grounding was gated on the ROUTED mode, so a misroute cost retrieval as well as the prompt — an
    `explain` question landing in `debug` lost its sources with nothing in the output to say so.
    Grounding is the only intervention replicated as a win across independent runs, which made that
    the most expensive part of a misroute.

    The question is now asked the other way round: ground everything except where it would harm.
    `empathy` must never cite sources at a learner saying "I give up", and neither it nor `general`
    has budget for retrieved context.
    """
    from src.main import _should_ground

    for grounded in ("explain", "teaching", "debug", "followup"):
        assert _should_ground(grounded), f"{grounded} should ground now that routing cannot remove it"
    for excluded in ("empathy", "general"):
        assert not _should_ground(excluded), f"{excluded} must not be grounded"


def test_a_misroute_no_longer_costs_retrieval() -> None:
    """The property the change exists for, stated directly: the two modes debug most often leaks to
    both ground, so landing in either keeps the sources."""
    from src.main import _should_ground

    assert _should_ground("explain") and _should_ground("teaching")
    assert _should_ground("debug"), "and the reverse direction too"


def test_grounding_fails_open_rather_than_breaking_the_chat() -> None:
    """A degraded answer beats a 500. If the corpus is unreachable the tutor must still respond —
    and the ungrounded instruction still makes it hedge on time-sensitive claims."""
    assert "answering ungrounded" in MAIN
    assert "must never break a conversation" in MAIN


def test_the_failure_is_logged_not_swallowed() -> None:
    """Silently serving ungrounded answers from a broken corpus is precisely how V2 stops working
    without anyone noticing."""
    assert "logger.warning" in MAIN and "retrieval grounding unavailable" in MAIN


def test_no_embedder_is_chosen_in_code() -> None:
    """Picking one here would bake a dimension into the corpus, and embedding_dim is recorded per
    row precisely because that choice is reversible."""
    assert "_get_embedder" in MAIN
    import re

    body = re.search(r"def _get_embedder\(\):(.*?)\ndef ", MAIN, re.S).group(1)
    assert "return None" in body


def test_the_ungrounded_path_still_instructs_the_model() -> None:
    """Not wrapped in `if hits`: an empty result must still change the prompt, or the model answers
    from weights with no signal to hedge — the state V2 exists to fix."""
    from features.retrieval import ground_prompt

    out = " ".join(ground_prompt("BASE", []).split())
    assert "No reference material was found" in out
