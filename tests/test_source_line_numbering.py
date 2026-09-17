"""The eval must send the source the way the frontend sends it: line-numbered.

`VoidCodeAIPanel.tsx` has numbered the source all along — `addLineNumbers` pads to three columns and
separates with ` | ` — and the harness sent it bare. So every localisation figure was measured on a
harder task than a learner poses: the model had to count lines itself, which language models are
poor at, and the gold set counts within `source_code` while an unnumbered message forces counting
from the fence. The near-miss histogram on cited lines showed an offset of -2 four times, exactly
that gap.

This is a fidelity fix. It may raise localisation, and if it does, that is the measurement catching
up with the product rather than the product improving.
"""
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    sys.path.insert(0, str(p))

import run_evals as R  # noqa: E402

#: Every client that sends the tutor a message. The desktop app carries its own copy of the panel,
#: and it is the one learners will use once the web app is gone — a check that reads only the web
#: copy would keep passing while the product it describes drifted away from it.
PANELS = {
    "desktop": ROOT / "desktop" / "renderer" / "src" / "components" / "VoidCodeAI" / "VoidCodeAIPanel.tsx",
    "web": ROOT / "apps" / "web" / "src" / "components" / "VoidCodeAI" / "VoidCodeAIPanel.tsx",
}
SCENARIO = {"user_message": "it returns the wrong value",
            "source_code": "def f(n):\n    total = 0\n    return total\n"}


def sent(scenario):
    msgs = R.build_messages(scenario, "")[1:]
    return [m for m in msgs if m["role"] == "user"][-1]["content"]


def test_the_source_is_line_numbered():
    body = sent(SCENARIO)
    assert "  1 | def f(n):" in body
    assert "  3 |     return total" in body


@pytest.mark.parametrize("client", sorted(PANELS))
def test_the_format_matches_the_frontend_exactly(client):
    """Two independent implementations of the same wire format. If they drift, the eval measures a
    message shape production does not send — which is how the unnumbered version survived.

    A missing copy fails rather than skips: remove it from PANELS in the change that deletes it.
    """
    panel = PANELS[client]
    assert panel.is_file(), f"{panel} is gone; drop '{client}' from PANELS in the same change"
    src = panel.read_text(encoding="utf-8")
    assert 'String(i + 1).padStart(3, " ")' in src and '} | ${line}' in src, (
        "the frontend's addLineNumbers changed; update build_messages to match")
    assert "lines total]" in src


def test_the_line_range_warning_travels_with_it():
    """The frontend states the valid range explicitly. A model that invents line 40 of a 12-line
    file is a failure mode the warning exists to prevent, so the eval must carry it too."""
    body = sent(SCENARIO)
    assert "exactly 3 lines (1–3)" in body  # noqa: RUF001 — the dash the frontend actually sends
    assert "Do NOT reference any line beyond Line 3" in body


def test_numbering_does_not_break_the_quoted_code_match():
    """`check_bug_localisation` credits a verbatim quote of the buggy line. The bare body must remain
    a substring of the numbered line, or numbering would silently destroy that signal."""
    scenario = dict(SCENARIO, ground_truth_bugs=[{"line": 2, "type": "logic"}])
    quoting = "the accumulator line is wrong: `total = 0` never updates"
    assert R.check_bug_localisation(quoting, scenario)["applicable"]
    body = sent(scenario)
    assert "total = 0" in body, "the bare line body must survive numbering as a substring"


def test_every_gold_scenario_with_source_gets_numbered():
    """A scenario whose code is embedded in `user_message` keeps the learner's own paste, unnumbered
    — that is the chat-box shape and it is equally real. Only the separate-source scenarios, which
    represent the workspace UI, get the numbered block."""
    numbered = unnumbered = 0
    for _name, val in R.GOLD_FILES.items():
        for path in ([val] if isinstance(val, Path) else val):
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if not (row.get("source_code") or "").strip():
                    continue
                if re.search(r"^\s*\d+ \| ", sent(row), re.M):
                    numbered += 1
                else:
                    unnumbered += 1
    assert numbered > 0, "no scenario received a numbered source block"
    # 48 numbered, 3 unnumbered. The frozen set was re-authored into the workspace shape by
    # stripping its embedded fence, because the embedding was an authoring convenience rather than
    # a production shape and it cost 0.702 against 0.396 on localisation.
    #
    # The 3 that remain are the multi-turn `eval_mt_*` scenarios, whose code lives in `messages[0]`
    # and which take the history path out of `build_messages` before any wrapping. That is a
    # genuinely different shape — a conversation already in progress — not an oversight.
    assert numbered == 48 and unnumbered == 3, (
        f"the shape split moved: {numbered} numbered, {unnumbered} unnumbered. Everything with a "
        "separate `source_code` should be numbered; only the multi-turn scenarios are exempt.")
