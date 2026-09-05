"""Debug mode must not ship its reasoning to the client, and hiding it must not improve the score.

69% of debug responses carry the complete corrected solution in their reasoning, which the
ThinkingBlock published one click away behind a panel labelled "Thinking Process". That defeats the
premise: a learner who finds it uses it every time.

Two properties are pinned here, and the second matters as much as the first.

1. **Suppression is server-side.** Hiding the panel in the UI leaves the text in the payload, still
   reachable by copy, export or devtools. Not emitting the frame means the browser never sees it.
2. **The eval still scores the payload.** If the scorer measured only what is rendered, this change
   would move the number without changing the product — the exact self-deception this project keeps
   guarding against. The disclosure gate must stay RED until the two-stage split lands.
"""
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts", ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(p))

MAIN = (ROOT / "apps" / "api" / "src" / "main.py").read_text(encoding="utf-8")


def test_debug_withholds_its_reasoning_and_the_teaching_modes_do_not():
    pytest.importorskip("fastapi", reason="lives in the API package")
    from src.main import THINKING_WITHHELD_MODES, _thinking_frame

    assert "debug" in THINKING_WITHHELD_MODES
    assert _thinking_frame("debug", "the fix is to use <=", 10) is None

    for mode in ("teaching", "explain"):
        frame = _thinking_frame(mode, "here is how I reason about it", 10)
        assert frame is not None, f"{mode} should still model its reasoning"
        assert frame.startswith("data: ") and frame.endswith("\n\n")
        assert '"type": "thinking"' in frame


def test_no_thinking_frame_is_emitted_outside_the_gate():
    """A fourth emission site added later would silently reopen the leak — the three that existed
    were spread across two code paths and an end-of-stream salvage branch, which is exactly how one
    gets missed."""
    inline = re.findall(r"yield f?\"data: \{json\.dumps\(\{'type': 'thinking'", MAIN)
    assert not inline, (
        f"{len(inline)} thinking frame(s) are yielded directly instead of through _thinking_frame, "
        "which is the only place the withholding rule is applied")


def test_the_scorer_reads_the_payload_not_the_render():
    """The gate must not be improvable by hiding text.

    `_split_response` and the disclosure scorer operate on the response payload. If a future change
    made scoring depend on what the client renders, suppressing a panel would move the number while
    the model kept producing solutions — and the readiness table would lie.
    """
    import run_evals as R

    reasoning = "def f(x):\n    return x + 1\n"
    assert R.disclosure_level(reasoning)["level"] == 4, (
        "the scorer must still see a full solution in reasoning text, wherever it is displayed")

    _answer, thinking = R._split_response({"answer": "hint only", "thinking": reasoning})
    assert thinking == reasoning, "the harness must retain the reasoning payload for scoring"
    assert R.disclosure_level(thinking)["level"] == 4


def test_the_interim_is_documented_as_interim():
    """Suppression stops the leak reaching the learner; it does not stop the model producing a
    solution. If this comment goes, so does the reason the gate stays red."""
    assert "INTERIM" in MAIN
    assert "two-stage" in MAIN
