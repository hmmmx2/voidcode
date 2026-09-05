"""A followup scenario must carry the conversation it refers to, and must not be passable by echo.

TWO DEFECTS, BOTH OF WHICH MADE THE MODE UNMEASURABLE.

**No history.** All four scenarios opened with a back-reference — "You said…", "Earlier you
mentioned…", "Follow up:", "Following on from that…" — and carried no `messages`. The model was
asked to continue a conversation it had never been given. Three answered standalone and happened to
be fine; the fourth invented a prior topic and refused: *"we've shifted topics away from our current
discussion on LLM inference batching and KV cache management"*. That is the correct response to a
reference with no referent, and it was scored as a tutor failure.

**Echo-satisfiable keywords.** Two scenarios required a keyword present in the learner's own
question — `batch` in "You said **batch** norm…", `inference` in "…when I run **inference**?".
In both, the model's "covered 1 of 2" was entirely that free keyword and the substantive one was
missed, so the figure flattered while still failing.

These tests generalise both rules to every mode, because neither is specific to followup.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    sys.path.insert(0, str(p))

import run_evals as R  # noqa: E402


def forms(entry) -> list[str]:
    """Every acceptable surface form of one required concept.

    `must_mention` entries became GROUPS -- a single substring per concept was testing vocabulary
    rather than understanding, and the tell was the difficulty gradient running backwards. The echo
    and leak rules below apply to EVERY form in a group: if any one of them is echoable from the
    question, the whole group is satisfiable by echoing.
    """
    return [str(f).lower() for f in (entry if isinstance(entry, (list, tuple)) else [entry])]

#: Openers that only make sense if something came before.
BACK_REFERENCES = ("you said", "you mentioned", "earlier", "follow up", "following on",
                   "from that", "as you said", "like you explained")


def scenarios():
    out = []
    for mode, val in R.GOLD_FILES.items():
        for path in ([val] if isinstance(val, Path) else val):
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    row.setdefault("mode", mode)
                    out.append(row)
    return out


ALL = scenarios()


def test_a_back_reference_has_something_to_refer_to():
    """A scenario that says "you said X" without an assistant turn saying X is not a followup test,
    it is a test of what the model invents."""
    dangling = []
    for s in ALL:
        opener = s["user_message"].lower()[:60]
        if not any(ref in opener for ref in BACK_REFERENCES):
            continue
        history = s.get("messages") or []
        if not any(m.get("role") == "assistant" for m in history):
            dangling.append(s["id"])
    assert not dangling, (
        f"scenarios back-reference a turn that does not exist: {dangling}. The model can only "
        "invent the missing context, and whatever it invents is then scored.")


def test_required_keywords_are_not_answerable_by_echo():
    """A keyword already in the learner's question is satisfied by repeating them, so it measures
    nothing — and worse, it pads `covered` and makes a total miss look like partial credit."""
    echoing = []
    for s in ALL:
        question = s["user_message"].lower()
        for entry in s.get("must_mention") or []:
            for kw in forms(entry):
                if kw in question:
                    echoing.append((s["id"], kw))
    assert not echoing, f"must_mention keywords echoable from the question: {echoing}"


def test_the_prior_turns_do_not_contain_the_answer():
    """If the authored context already says what `must_mention` requires, the model passes by
    copying and the mode looks fixed while measuring nothing. This is the trap the authoring script
    refuses on, asserted here against the data rather than the generator."""
    leaking = []
    for s in ALL:
        history = " ".join(m.get("content", "") for m in (s.get("messages") or [])
                           if m.get("role") == "assistant").lower()
        if not history:
            continue
        for entry in s.get("must_mention") or []:
            for kw in forms(entry):
                if kw in history:
                    leaking.append((s["id"], kw))
    assert not leaking, f"prior assistant turns already contain required keywords: {leaking}"


@pytest.mark.parametrize("mode", ["followup"])
def test_the_mode_actually_receives_a_conversation(mode):
    rows = [s for s in ALL if s.get("mode") == mode]
    assert rows, f"no {mode} scenarios found"
    for s in rows:
        built = R.build_messages(s, "SYS")
        roles = [m["role"] for m in built]
        assert "assistant" in roles, f"{s['id']} reaches the model with no prior assistant turn"
        assert roles[-1] == "user", f"{s['id']} must end on the learner's question"
