"""The harness must consume the STREAMING path, and keep reasoning out of the scored answer.

The first production measurement posted `stream: False`. That path ran a `strip_thinking_tags` which
required a tag pair the model never emits, so the reasoning was scored as answer text: localisation
read 39/51 where the visible answers support 30/51, and 22 of 25 leak failures were a corrected
function sitting in the unstripped scratchpad. The web client streams, so none of it described what
a learner receives.

These tests pin the two properties that failure needed: the request must stream, and the parser must
hand back reasoning and answer as separate strings.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    sys.path.insert(0, str(p))

import run_evals  # noqa: E402


def sse(*events) -> list[str]:
    """Serialise events into SSE frames, one chunk each."""
    return [f"data: {json.dumps(e)}\n\n" for e in events]


def delta(text):
    return {"id": "x", "object": "chat.completion.chunk",
            "choices": [{"delta": {"content": text}, "index": 0, "finish_reason": None}]}


def test_the_request_streams():
    """`stream: False` is a different system, not a different transport."""
    payload = run_evals.api_payload({"user_message": "why is this wrong?"})
    assert payload["stream"] is True


def test_reasoning_and_answer_come_back_separate():
    answer, thinking = run_evals.parse_sse([*sse(
        {"type": "thinking", "content": "the bug is the < on line 5"},
        delta("Which comparison "), delta("ends the loop?"),
        {"type": "usage", "usage": {"total_tokens": 10}, "mode": "debug"},
    ), "data: [DONE]\n\n"])
    assert answer == "Which comparison ends the loop?"
    assert thinking == "the bug is the < on line 5"


def test_frames_split_across_chunk_boundaries_are_reassembled():
    """Chunk boundaries fall mid-JSON in practice. A parser that reads per-chunk drops content and
    the loss looks like a short answer rather than a bug."""
    whole = "".join([*sse(delta("hello "), delta("world")), "data: [DONE]\n\n"])
    chunks = [whole[i:i + 7] for i in range(0, len(whole), 7)]   # deliberately ragged
    answer, _ = run_evals.parse_sse(chunks)
    assert answer == "hello world"


def test_usage_frames_are_not_answer_text():
    answer, thinking = run_evals.parse_sse(
        [*sse(delta("ok"), {"type": "usage", "usage": {"total_tokens": 3}, "mode": "debug"}),
         "data: [DONE]\n\n"])
    assert answer == "ok"
    assert thinking == ""


def test_a_stream_error_raises_rather_than_scoring_as_a_bad_answer():
    """An error frame that fell through as empty text would be scored as a failed scenario, which is
    indistinguishable from the model answering badly."""
    import pytest
    with pytest.raises(RuntimeError, match="boom"):
        run_evals.parse_sse(sse({"error": {"message": "boom", "type": "sglang_error"}}))


def test_an_unterminated_stream_still_returns_what_arrived():
    """No `[DONE]` -- connection dropped. Partial output beats losing the scenario silently."""
    answer, _ = run_evals.parse_sse(sse(delta("partial")))
    assert answer == "partial"


def test_offline_blobs_are_split_on_the_bare_closing_tag_too():
    """`--score` and `--direct-vllm` hand back one blob. It must go through the same splitter, or
    those paths reproduce the exact defect the streaming switch removes."""
    answer, thinking = run_evals._split_response("reasoning here</think>The visible answer.")
    assert answer == "The visible answer."
    assert thinking == "reasoning here"


def test_the_streamed_shape_is_passed_through_unchanged():
    answer, thinking = run_evals._split_response({"answer": "A", "thinking": "T"})
    assert (answer, thinking) == ("A", "T")


def test_an_unknown_frame_type_never_becomes_answer_text():
    """Stage A's diagnosis now travels as a HEADER, not a frame — the generator wrapper that
    prepended it was the only suspect for an API dying silently after 20-60 requests.

    But the parser must still not turn an unrecognised frame into answer text: that is how a private
    surface leaks into what the learner reads, and it would be scored as the tutor's own words.
    """
    answer, thinking = run_evals.parse_sse(
        [*sse({"type": "diagnosis", "issues": [{"line": 5, "symptom": "off by one"}]},
              delta("Your loop bound stops early. "), delta("What is the last index it reaches?")),
         "data: [DONE]\n\n"])
    assert answer == "Your loop bound stops early. What is the last index it reaches?"
    assert "line 5" not in answer.lower()
    assert "off by one" not in answer
    assert thinking == ""


def test_the_api_and_the_harness_agree_on_the_diagnosis_header_name():
    """Two string literals in two files that must match, or the harness silently reads nothing and
    `bug_localisation` on the diagnostic surface quietly reports zero."""
    api = (ROOT / "apps" / "api" / "src" / "main.py").read_text(encoding="utf-8")
    harness = (ROOT / "scripts" / "run_evals.py").read_text(encoding="utf-8")
    assert '"X-VoidCode-Diagnosis"' in api
    assert '"X-VoidCode-Diagnosis"' in harness


def test_the_harness_asks_for_the_diagnosis_but_a_learner_never_would():
    payload = run_evals.api_payload({"user_message": "why is this wrong?"})
    assert payload["include_diagnosis"] is True
