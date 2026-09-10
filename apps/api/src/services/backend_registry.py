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
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

#: How long a probe result is trusted. See the module docstring on why this is not zero.
PROBE_TTL_SECONDS = 5.0

#: A probe is a liveness check, not a request. It must fail fast rather than queue behind a busy
#: backend -- a backend too loaded to answer in two seconds is not one to send another request to.
PROBE_TIMEOUT_SECONDS = 2.0

READY = "ready"
WAKING = "waking"
DOWN = "down"


@dataclass
class _State:
    base_url: str = ""
    client: object | None = None
    status: str = DOWN
    probed_at: float = 0.0
    #: Set while a backend is known to be starting, so a caller can be told "waking" rather than
    #: "down". Nothing sets this yet; spin-down will.
    expected_back: bool = False


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
    except Exception as exc:
        logger.debug("backend probe failed for %s: %s", url, exc)
        _state.status = WAKING if _state.expected_back else DOWN

    _state.probed_at = now
    return _state.status


def reset_for_tests() -> None:
    """Clear all state. Only for tests -- the registry is a module-level singleton by design."""
    global _state
    _state = _State()
