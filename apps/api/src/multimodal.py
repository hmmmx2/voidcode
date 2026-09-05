"""Carry multimodal message content through the request path. V3.

`apps/api/src/schemas/chat.py` already accepts the OpenAI-compatible parts list and validates it
hard — `data:` URLs only, MIME allow-list, size cap. That half was done. **Nothing downstream read
it**, which is the defect this module closes.

WHY AN ACCEPTED-AND-DROPPED IMAGE IS WORSE THAN A REJECTED ONE
----------------------------------------------------------------
Before this, a client could POST a loss-curve screenshot, get 200 OK, and receive a fluent answer
that had never seen the image. No error, no warning, nothing in the response distinguishing it from
a working reply — the learner would read an answer about a chart the model was never shown and have
no way to tell. That is the project's signature failure mode (a plausible result rather than an
error) applied to a user-facing feature.

So the rule here is: an image is either **delivered to the model** or the request **fails loudly**.
There is no third branch.

TWO SEPARATE JOBS, AND CONFLATING THEM IS THE BUG
---------------------------------------------------
`prepare_messages_hybrid` uses the latest user message for two unrelated purposes:

  1. **Routing** — `detect_mode`, `detect_frustration`, `_extract_user_intent` and the retrieval
     query all need a plain string. Handed a list they would raise, or worse, stringify a Pydantic
     object into the retrieval query and silently poison the embedding.
  2. **The model payload** — needs the parts preserved, because flattening to text is exactly the
     drop this module exists to prevent.

`text_of()` serves the first, `to_wire()` the second. Both are pure and independently testable,
which is why they live here rather than inline in `main.py` — that file is 1,700 lines and its
tests assert on it as *text* via regex because importing it drags in torch.
"""
from __future__ import annotations

import os
from typing import Any


#: The operator asserts the served model can accept images. Default **false**: the production path
#: is stock Qwen3.5-9B via SGLang, and a text-only model handed an image_url part either errors deep
#: in the serving stack or ignores it — both worse than a 415 that names the reason.
#:
#: This is a capability flag rather than a model-name lookup on purpose. A hardcoded
#: model -> vision map would go stale the first time BASE_MODEL_ID changes, and would then be wrong
#: in the dangerous direction: claiming vision for a model that has none.
def vision_enabled() -> bool:
    """Read at call time, not import time, so tests and deploys can flip it without a reimport."""
    return os.getenv("VISION_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _parts(content: Any) -> list:
    """The parts list, or [] for a plain string. Accepts Pydantic parts or already-dumped dicts."""
    return list(content) if isinstance(content, list) else []


def _part_type(part: Any) -> str:
    return part.get("type", "") if isinstance(part, dict) else getattr(part, "type", "")


def text_of(content: Any) -> str:
    """Plain text for ROUTING ONLY — mode detection, intent extraction, the retrieval query.

    Never use this to build the model payload; that is `to_wire`, and using this instead is the
    drop this module exists to prevent.

    Image parts contribute nothing, deliberately. Substituting a placeholder like "[image]" would
    feed a token into `detect_mode` that no student typed, and the mode routing is keyword-driven.
    """
    if isinstance(content, str):
        return content
    texts = []
    for part in _parts(content):
        if _part_type(part) == "text":
            texts.append(part.get("text", "") if isinstance(part, dict) else getattr(part, "text", ""))
    return "\n".join(t for t in texts if t)


def image_count(content: Any) -> int:
    return sum(1 for part in _parts(content) if _part_type(part) == "image_url")


def has_images(messages: list) -> bool:
    """Does any message in the conversation carry an image?"""
    return any(image_count(getattr(m, "content", None)) for m in messages)


def to_wire(content: Any) -> Any:
    """The model payload. A string stays a string; a parts list becomes plain dicts.

    Pydantic models must not reach the serving client — `openai`/`httpx` would either fail to
    serialise them or coerce them via `str()`, which produces `ImagePart(type='image_url'...)` as
    the literal prompt text. That reads as a working request and sends garbage.
    """
    if isinstance(content, str):
        return content
    wire = []
    for part in _parts(content):
        if isinstance(part, dict):
            wire.append(part)
        elif hasattr(part, "model_dump"):
            wire.append(part.model_dump())
        else:                                    # pragma: no cover - schema forbids this
            raise TypeError(f"unserialisable content part: {type(part).__name__}")
    return wire


class VisionUnsupported(Exception):
    """Raised when a request carries an image and the served model cannot accept one.

    A dedicated type rather than HTTPException so this module stays importable without FastAPI and
    stays unit-testable; `main.py` maps it to a 415.
    """

    def __init__(self, n_images: int):
        self.n_images = n_images
        super().__init__(
            f"This request carries {n_images} image(s) and the served model is text-only. "
            "The image was NOT sent to the model and no answer was generated from it. "
            "Set VISION_ENABLED=true only when the deployed model is multimodal."
        )


def assert_can_accept(messages: list) -> None:
    """Fail loudly before inference if images are present and unsupported.

    Called BEFORE the model request so the failure is attributable. Checking afterwards would mean
    the request had already been answered — from text alone — and the caller would have a plausible
    answer plus an error, which is the worst of both.
    """
    if not has_images(messages):
        return
    if not vision_enabled():
        raise VisionUnsupported(sum(image_count(getattr(m, "content", None)) for m in messages))
