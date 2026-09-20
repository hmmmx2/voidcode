"""V3: `content` accepts multimodal parts, and refuses the unsafe ones.

The vision encoder loads into VRAM on every request and never executes — one to two gigabytes paid
for a capability the API could not express, blocked by `content: str`.

Widening it is three lines. The tests that matter are the refusals, because an image is the
largest prompt-injection surface this product would have: text a user sends is at least visible to
them, while an instruction painted in pale grey on a loss-curve screenshot is not, and a tutor
that reads it will follow it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from pydantic import ValidationError  # noqa: E402
from src.schemas.chat import MAX_IMAGE_CHARS, SaveMessageRequest  # noqa: E402

PNG = "data:image/png;base64,iVBORw0KGgo="


def msg(content):
    return SaveMessageRequest(role="user", content=content)


def test_a_plain_string_still_works() -> None:
    """Every caller today sends a string. Widening must not become replacing."""
    assert msg("hello").content == "hello"


def test_text_and_image_parts_are_accepted() -> None:
    m = msg([{"type": "text", "text": "why does this plateau?"},
             {"type": "image_url", "image_url": {"url": PNG}}])
    assert len(m.content) == 2


def test_a_remote_url_is_refused() -> None:
    """Not fetched and sanitised — refused. A remote URL turns every rendered message into an
    outbound request to a host the sender chose: SSRF and a tracking pixel in one."""
    with pytest.raises(ValidationError, match="inline data"):
        msg([{"type": "image_url", "image_url": {"url": "https://evil.test/pixel.png"}}])


def test_a_non_image_data_uri_is_refused() -> None:
    """So a payload cannot arrive labelled as an image and be interpreted as something else."""
    with pytest.raises(ValidationError, match="not in"):
        msg([{"type": "image_url", "image_url": {"url": "data:text/html;base64,PHNjcmlwdD4="}}])


def test_an_oversized_image_is_refused() -> None:
    """Base64 inflates by 4/3, and an unbounded field is memory exhaustion before it is anything
    else."""
    huge = "data:image/png;base64," + "A" * (MAX_IMAGE_CHARS + 1)
    with pytest.raises(ValidationError, match="over the"):
        msg([{"type": "image_url", "image_url": {"url": huge}}])


def test_an_image_at_the_limit_is_accepted() -> None:
    """The boundary is inclusive. A test that only checks rejection cannot tell a working limit
    from one that rejects everything."""
    at_limit = "data:image/png;base64," + "A" * MAX_IMAGE_CHARS
    assert len(msg([{"type": "image_url", "image_url": {"url": at_limit}}]).content) == 1


def test_an_unknown_part_type_is_refused() -> None:
    with pytest.raises(ValidationError):
        msg([{"type": "audio_url", "audio_url": {"url": PNG}}])


# ── Delivery, not just acceptance ────────────────────────────────────────────
#
# Everything above is schema-level, and all of it passed while the feature was broken: `content`
# accepted an image, and NOTHING downstream read it. The request returned 200 with a fluent answer
# about a chart the model had never been shown, indistinguishable from a working reply.
#
# So these tests assert the image reaches the wire. A schema test cannot fail when the plumbing is
# missing, which is exactly why the schema alone made V3 look done.

from src.multimodal import (  # noqa: E402
    VisionUnsupported,
    assert_can_accept,
    has_images,
    image_count,
    text_of,
    to_wire,
)

TEXT_AND_IMAGE = [
    {"type": "text", "text": "why does this loss curve plateau?"},
    {"type": "image_url", "image_url": {"url": PNG}},
]


def test_text_of_is_identity_on_a_plain_string():
    """Every caller today sends a string; widening must not disturb them."""
    assert text_of("hello") == "hello"


def test_text_of_extracts_only_the_text_parts():
    """Routing (detect_mode, frustration, the retrieval query) is keyword-driven and string-only."""
    assert text_of(TEXT_AND_IMAGE) == "why does this loss curve plateau?"


def test_text_of_does_not_invent_a_placeholder_for_the_image():
    """A substituted '[image]' token would feed a word no student typed into detect_mode."""
    assert "image" not in text_of([{"type": "image_url", "image_url": {"url": PNG}}])


def test_to_wire_preserves_the_image_url():
    """THE regression test for V3. If the parts list is flattened to text anywhere in the request
    path, the image is silently dropped and this fails."""
    wire = to_wire(msg(TEXT_AND_IMAGE).content)
    assert isinstance(wire, list) and len(wire) == 2
    urls = [p["image_url"]["url"] for p in wire if p["type"] == "image_url"]
    assert urls == [PNG]


def test_to_wire_emits_plain_dicts_not_pydantic_models():
    """A Pydantic part reaching the serving client gets coerced by str() into literal prompt text
    like "ImagePart(type='image_url'...)" — a working-looking request that sends garbage."""
    for part in to_wire(msg(TEXT_AND_IMAGE).content):
        assert type(part) is dict


def test_to_wire_leaves_a_string_alone():
    assert to_wire("plain") == "plain"


def test_image_count_and_has_images():
    assert image_count(TEXT_AND_IMAGE) == 1
    assert image_count("no image here") == 0
    assert has_images([msg(TEXT_AND_IMAGE)]) is True
    assert has_images([msg("text only")]) is False


def test_images_are_refused_when_the_served_model_is_text_only(monkeypatch):
    """Production serves stock Qwen3.5-9B with no vision. Accepting and dropping is the failure
    this whole module exists to prevent, so the default must be a loud refusal."""
    monkeypatch.delenv("VISION_ENABLED", raising=False)
    with pytest.raises(VisionUnsupported) as exc:
        assert_can_accept([msg(TEXT_AND_IMAGE)])
    # The message must say the image was NOT used — a bare "unsupported" leaves the caller
    # wondering whether a degraded answer was still generated from it.
    assert "NOT sent to the model" in str(exc.value)


def test_images_pass_when_vision_is_enabled(monkeypatch):
    monkeypatch.setenv("VISION_ENABLED", "true")
    assert assert_can_accept([msg(TEXT_AND_IMAGE)]) is None


def test_text_only_requests_are_never_blocked(monkeypatch):
    """The guard must not become a tax on the 100% of traffic that sends strings."""
    monkeypatch.delenv("VISION_ENABLED", raising=False)
    assert assert_can_accept([msg("just text")]) is None


# ── The request model the ENDPOINT actually validates against ────────────────
#
# Everything above tests `SaveMessageRequest` (the history schema) and `assert_can_accept`
# directly. Both passed while the vision path was completely unreachable, because
# `/v1/chat/completions` validates against `main.ChatMessage`, which is a DIFFERENT model and was
# still `content: str`. FastAPI rejected an image with a 422 during body validation, before the
# guard could run — so the 415 and its "NOT sent to the model" message were dead code, and
# VISION_ENABLED=true on a multimodal deployment still could not pass an image through.
#
# Run in a subprocess: `src.main` imports torch and transformers at module scope, and the
# apps/api suite documents that it never imports main for exactly that reason. Skipped rather
# than failed where the inference stack is absent, so the light CI job stays light.

import json  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402

_ENDPOINT_MODEL_PROBE = r"""
import json, os, sys
sys.path.insert(0, %(api)r)
os.environ.pop("VISION_ENABLED", None)
from src.main import ChatCompletionRequest
from src import multimodal

body = {"messages": [{"role": "user", "content": [
    {"type": "text", "text": "what is in this image?"},
    {"type": "image_url", "image_url": {"url": %(png)r}},
]}]}

out = {}
req = ChatCompletionRequest(**body)          # 422 lived here
out["parsed"] = True
out["is_parts_list"] = isinstance(req.messages[0].content, list)
try:
    multimodal.assert_can_accept(req.messages)
    out["guard"] = "did not fire"
except multimodal.VisionUnsupported as exc:
    out["guard"] = "fired"
    out["detail"] = str(exc)

os.environ["VISION_ENABLED"] = "true"
multimodal.assert_can_accept(req.messages)   # must now pass through to the model
out["enabled_passes"] = True
out["wire"] = multimodal.to_wire(req.messages[0].content)
print("PROBE" + json.dumps(out))
"""


def _run_probe():
    api = str(ROOT / "apps" / "api")
    src = _ENDPOINT_MODEL_PROBE % {"api": api, "png": PNG}
    proc = subprocess.run([sys.executable, "-c", src], capture_output=True, text=True, cwd=api)
    if proc.returncode != 0:
        # A DENY-LIST OF TWO MODULE NAMES STOOD HERE and `uvicorn` walked straight past it.
        # `apps/api/src/main.py` imports uvicorn at line 58, before it ever reaches torch, so on
        # `ci.yml`'s ML tree job — which installs neither, on purpose — these three tests failed
        # with "probe failed rc=1" and a child traceback, rather than skipping. The same trap this
        # repository records elsewhere: a list of the bad spellings misses the next one.
        #
        # So the rule instead of the list. OURS vs THEIRS: a third-party module missing means this
        # environment has no inference stack, which is a legitimate skip. One of OUR packages
        # missing means a rename or a deletion, and that must fail loudly — skipping there would
        # retire the test silently, which is the whole failure mode this file exists to prevent.
        missing = re.findall(r"No module named '([A-Za-z0-9_.]+)'", proc.stderr)
        ours = {"src", "scripts", "rl", "features", "reward", "analysis", "ranking"}
        theirs = sorted({m for m in missing if m.split(".")[0] not in ours})
        if theirs:
            pytest.skip(f"inference stack not installed ({', '.join(theirs)})")
        pytest.fail(f"probe failed rc={proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    line = [out for out in proc.stdout.splitlines() if out.startswith("PROBE")]
    assert line, f"probe printed nothing parseable:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(line[-1][len("PROBE"):])


def test_the_chat_endpoint_body_model_accepts_an_image():
    """Red when `main.ChatMessage.content` is `str`: the body never parses, so the guard is dead."""
    out = _run_probe()
    assert out["parsed"] is True
    assert out["is_parts_list"] is True, "content was coerced to a string, not kept as parts"


def test_the_endpoint_guard_fires_on_a_parsed_image_request():
    """The 415 path must be reachable from a real request body, not only from a hand-built list."""
    out = _run_probe()
    assert out["guard"] == "fired"
    assert "NOT sent to the model" in out["detail"]


def test_vision_enabled_lets_the_image_reach_the_wire():
    """The other half: with a multimodal model deployed, the image must actually get delivered."""
    out = _run_probe()
    assert out["enabled_passes"] is True
    urls = [p["image_url"]["url"] for p in out["wire"] if p.get("type") == "image_url"]
    assert urls == [PNG], f"image did not survive serialisation to the model: {out['wire']}"
