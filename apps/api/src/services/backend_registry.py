"""Where the inference backend is, and whether it is actually answering.

TWO PROBLEMS, ONE CAUSE.

`main.py` built its `AsyncOpenAI` client once in the lifespan with the base URL baked in, and every
call site used that module global. Nothing re-read the address, so:

  1. **A backend that moves is invisible until the process restarts.** That is fine while the
     address is a fixed compose hostname and fatal the moment a pod is stopped and started -- RunPod
     re-assigns proxy ports on start, so the address a spun-down backend comes back on is not the
     one it left on. Spin-down is unshippable without this.

  2. **`/health` lied.** `_is_model_ready()` returned `_sglang_client is not None`, which is a
     statement about whether a Python object was constructed at startup, not about whether anything
     is listening. Point the config at a dead address and the endpoint still reported
     `model_loaded: true` -- to a load balancer, to a readiness probe, and to anyone debugging.
     That is a live bug independent of spin-down, and it is the more immediately harmful of the two:
     a health endpoint that cannot report ill-health is worse than not having one, because
     everything downstream is built on trusting it.

A THIRD THING THE SAME PROBE ANSWERS

`/models` says WHICH model is being served, not just that something is listening, and the probe was
throwing that away. `/health` reported `base_model` from `BASE_MODEL_ID` -- a value that describes
the in-process HuggingFace path and means nothing when inference is delegated. Observed 2026-09-10:
the endpoint reported `Qwen/Qwen2.5-7B-Instruct` while the backend was serving a 30B. Accurate on
one path, stale on the other, with nothing to distinguish the two from outside.

The answer is already in the response being parsed for liveness, so this costs no extra request.

WHY THE PROBE IS CACHED AND WHY THE TTL IS SHORT

`/health` is polled by a Kubernetes readiness probe and by anything else watching. An uncached probe
would put one HTTP request on the backend per health check per replica, which is load applied to
the thing being asked whether it is overloaded. A few seconds of staleness is the right trade: long
enough to collapse a burst of checks into one, short enough that a backend going down is noticed
within a probe interval or two.

WHY IT PROBES `/models` AND NOT `/health`

The same reason `main.py`'s startup poll does, and the comment there is worth preserving: `/models`
is exposed by both SGLang and Ollama, while `/health` is SGLang-only and Ollama returns 404 for it.
Probing an endpoint that a supported backend does not implement would report a healthy backend as
dead.

WHAT THIS DOES NOT DO

It does not discover an address. The address comes from configuration, or later from a pod-control
service writing one down after a successful start. It must never be found by asking a provider to
list pods -- that is the rule the RunPod client is built around, for the same reason: a listing is
one refactor away from acting on, or pointing at, the wrong machine.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import httpx

from .. import metrics

logger = logging.getLogger(__name__)

#: How long a probe result is trusted. See the module docstring on why this is not zero.
PROBE_TTL_SECONDS = 5.0

#: A probe is a liveness check, not a request. It must fail fast rather than queue behind a busy
#: backend -- a backend too loaded to answer in two seconds is not one to send another request to.
PROBE_TIMEOUT_SECONDS = 2.0

READY = "ready"
WAKING = "waking"
DOWN = "down"

#: Every state a probe can report, in the order a reader should think about them.
#:
#: Exported because `metrics.set_backend_state` needs the full set to zero the ones that are not
#: current, and a second copy of it over there would go stale the day a fourth state is added --
#: leaving a permanently-1 series for a state this module no longer reports.
STATES = (READY, WAKING, DOWN)


@dataclass
class _State:
    base_url: str = ""
    client: object | None = None
    status: str = DOWN
    probed_at: float = 0.0
    #: Set while a backend is known to be starting, so a caller can be told "waking" rather than
    #: "down". Nothing sets this yet; spin-down will.
    expected_back: bool = False
    #: {alias: underlying model} as the backend last reported it. Empty when the backend has
    #: not answered, which is the honest state -- an unreachable backend is one whose model we
    #: do not know, and saying so beats repeating the last thing it said before it died.
    models: dict[str, str] = field(default_factory=dict)


_state = _State()


def configure(base_url: str, client_factory) -> None:
    """Point the registry at an address. Rebuilds the client only when the address changed.

    Rebuilding unconditionally would discard a live connection pool on every call, which is exactly
    the sort of thing that looks harmless and shows up as latency.
    """
    if base_url == _state.base_url and _state.client is not None:
        return
    logger.info("inference backend address set to %s", base_url)
    _state.base_url = base_url
    _state.client = client_factory(base_url)
    # A new address has not been probed yet. Claiming otherwise is the bug this module exists for.
    _state.probed_at = 0.0
    _state.status = WAKING if _state.expected_back else DOWN


def current_client():
    """The client for the address in force now, or None if none is configured."""
    return _state.client


def base_url() -> str:
    return _state.base_url


def expect_restart(expected: bool = True) -> None:
    """Say that the backend is deliberately down and coming back.

    The difference matters to a caller: "down" is an error worth surfacing, "waking" is a wait worth
    reporting. Without this they are indistinguishable from outside.
    """
    _state.expected_back = expected
    if expected and _state.status == DOWN:
        _state.status = WAKING


async def probe(now: float | None = None) -> str:
    """Ask the backend whether it is there. Cached for `PROBE_TTL_SECONDS`.

    Returns one of READY, WAKING, DOWN. Never raises: a health check that can fail is a health check
    that turns a degraded backend into a 500 on the endpoint reporting the degradation.
    """
    now = now if now is not None else time.monotonic()
    if _state.client is None or not _state.base_url:
        return DOWN
    if now - _state.probed_at < PROBE_TTL_SECONDS:
        return _state.status

    url = _state.base_url.rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as http:
            response = await http.get(url)
        _state.status = READY if response.status_code == 200 else (
            WAKING if _state.expected_back else DOWN
        )
        _state.models = _models_from(response) if response.status_code == 200 else {}
    except Exception as exc:
        logger.debug("backend probe failed for %s: %s", url, exc)
        _state.status = WAKING if _state.expected_back else DOWN
        _state.models = {}

    _state.probed_at = now

    # REPORTED HERE BECAUSE THIS IS WHERE THE STATE IS DECIDED, and because `/health` is polled by
    # the kubelet and scraped by nobody -- so until this line existed there was no way to alert on
    # a backend that had been unreachable for five minutes. Deliberately after the early returns
    # above: an unconfigured registry (the in-process paths) emits no series at all rather than a
    # false `down`.
    metrics.set_backend_state(_state.status, STATES)
    return _state.status


def _models_from(response) -> dict[str, str]:
    """{alias: underlying model} from an OpenAI-shaped /models body.

    `root` is the real identity -- a served alias is a label, and two aliases routinely point at
    different weights (a base model and a fine-tune of it). Falls back to the alias when `root` is
    absent rather than dropping the entry, because a name is better than nothing.

    Never raises. This runs inside a liveness probe whose whole contract is that it cannot fail, so
    a backend answering 200 with something unexpected must degrade to "no idea", not to a 500 on
    the endpoint reporting backend health.
    """
    try:
        data = response.json().get("data") or []
    except Exception as exc:  # pragma: no cover - defensive; body shape is the backend's choice
        logger.debug("could not read the model list: %s", exc)
        return {}
    found: dict[str, str] = {}
    for entry in data:
        if not isinstance(entry, dict):
            continue
        alias = entry.get("id")
        if isinstance(alias, str) and alias:
            root = entry.get("root")
            found[alias] = root if isinstance(root, str) and root else alias
    return found


def served_model(alias: str = "") -> str | None:
    """What the backend is actually running behind `alias`, or None when that is not known.

    None rather than a guess. The caller reporting this is `/health`, and a health endpoint that
    invents a plausible answer is the exact failure this module was written for -- it is better to
    say nothing than to name a model that is not loaded.

    With one model served and no alias configured, that model is the answer; with several and no
    match, it is genuinely ambiguous and None is correct.
    """
    if not _state.models:
        return None
    if alias and alias in _state.models:
        return _state.models[alias]
    if len(_state.models) == 1:
        return next(iter(_state.models.values()))
    return None


def serving_aliases() -> list[str]:
    """The names this backend answers to, as of the last probe."""
    return sorted(_state.models)


def choose_model(configured: str) -> tuple[str, str, str]:
    """Which alias to send, and what to say about it: `(name, level, message)`.

    Pure apart from reading the last probe, and separated from the lifespan so the rules can be
    tested without a server. `level` is "" when there is nothing to report.

    THE RULES, AND WHY EACH ONE IS WHAT IT IS.

    Configured and served -> use it, say nothing. The ordinary case.

    Configured and NOT served -> keep it and report an ERROR naming what IS served. Keeping the
    wrong value rather than silently substituting a working one is deliberate: an operator who
    typed `rl` and got `base` would be measuring the wrong weights and would have no way to know.
    Fail visibly on their value, do not quietly succeed on another.

    Unset with exactly one model served -> adopt it. There is no ambiguity to resolve and no other
    answer that could be meant.

    Unset with several served -> FATAL. Not a warning, because an empty model name does not fail:
    measured against this backend on 2026-09-10, `model=""` returns 200 and serves `base`, the
    first model, while `model="default"` 404s. So the unconfigured case silently picks weights
    nobody chose, and an operator evaluating a fine-tune would be handed the base model with a 200
    and no way to tell. Refusing to start is the only outcome that cannot be mistaken for working.
    This project has already published one number that was measuring something other than what it
    claimed; that is the cost being avoided here.

    Backend listed nothing -> say the check could not run. Silence here would read as approval.
    """
    served = serving_aliases()
    if configured and configured in served:
        return configured, "", ""
    if not served:
        return configured, "warning", (
            "the backend listed no models, so SGLANG_MODEL_NAME could not be checked"
        )
    if configured:
        return configured, "error", (
            f"SGLANG_MODEL_NAME={configured!r} is not served by this backend, which offers "
            f"{served}. Every request will fail with a 404 until this is set to one of them."
        )
    if len(served) == 1:
        return served[0], "info", (
            f"SGLANG_MODEL_NAME is unset; using {served[0]!r}, the only model this backend serves"
        )
    return "", "fatal", (
        f"SGLANG_MODEL_NAME is unset and this backend serves {served}. Set it to one of them. "
        f"Refusing to start rather than defaulting: an empty model name does NOT fail here, it "
        f"quietly serves {served[0]!r}, so every request and every evaluation would run against "
        "weights nobody chose and look entirely healthy doing it."
    )


def reset_for_tests() -> None:
    """Clear all state. Only for tests -- the registry is a module-level singleton by design."""
    global _state
    _state = _State()
