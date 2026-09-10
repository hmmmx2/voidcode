"""Start and stop ONE pod, named in configuration, and nothing else.

THE SAFETY PROPERTY, AND WHY IT IS WRITTEN THIS WAY RATHER THAN CAREFULLY

A RunPod API key is account-wide. Every pod in the account is addressable by id, including ones that
have nothing to do with this service -- at the time of writing the same account has been running a
paid A40 for weeks of GPU training whose volume holds work that cannot be recreated. There is no
scope on the key, no per-pod credential, and no way to ask RunPod for a token that can only touch
one machine. Whatever protection exists has to exist here.

So it is not implemented carefully. It is implemented so that carelessness cannot reach another pod:

  1. **Inert unless explicitly targeted.** `_assert_armed()` raises unless BOTH `RUNPOD_API_KEY` and
     an explicit `RUNPOD_POD_ID` are set, and it runs before any URL is constructed. A misconfigured
     deployment makes no request at all rather than a request to somewhere unexpected.

  2. **No method takes a pod id.** The id is read from configuration inside this module. There is no
     signature through which a caller -- or a future refactor, or a test -- can name a different
     pod. An argument that does not exist cannot be passed the wrong value.

  3. **No collection endpoint, ever.** This client may call `/pods/{configured_id}` and its
     start/stop actions. It must never call `GET /pods`, and must never read a pod id out of a
     response body and act on it. A listing is one refactor away from iterating, and iterating is
     one bug away from stopping everything in the account. There is a test asserting the source
     contains no such call, and its docstring says what it is protecting.

  4. **A third switch on top of the two required values.** `POD_CONTROL_ENABLED` defaults false, so
     a deployment that happens to have both variables set still does nothing until somebody decides.

This extends a decision already made in this repo rather than inventing one: `training/platform_probe.py`
records RunPod environment variables for provenance through an explicit allowlist, and deliberately
excludes `RUNPOD_API_KEY` -- with a test asserting it -- because sweeping `RUNPOD_*` would eventually
write an API key into a JSON file that goes into git.

NO SDK, RAW httpx, FOLLOWING `payments.py`

There is no Stripe SDK on the payments path and there should be no RunPod SDK here, for the same
reasons: a dependency that can be replaced by twenty lines of `httpx` is twenty lines of `httpx`,
and an SDK's convenience methods are exactly where a `list_pods()` would come from.

WHAT THIS DOES NOT DO

It does not decide when to stop a pod -- that is the idle watcher's job. It does not discover an
address. And it cannot make a stopped pod serve: what runs inside a pod on boot comes from the pod
template's start command, not from here.
"""

from __future__ import annotations

import logging

import httpx

from .. import config

logger = logging.getLogger(__name__)

#: RunPod's REST API. Pinned to the versioned host rather than a redirect, so a change of default
#: version is a deliberate edit here.
RUNPOD_API = "https://rest.runpod.io/v1"

#: A pod action is not a request to wait on. If RunPod is slow, the right answer is to fail and let
#: the idle watcher try again on its next pass, not to hold a coroutine open.
TIMEOUT_SECONDS = 20.0


class PodControlError(Exception):
    """The provider refused or could not be reached."""


class PodControlDisabled(PodControlError):
    """Pod control is not configured, so nothing was attempted.

    A distinct type because the two need opposite reactions: this one is the expected state in every
    environment that does not manage its own pod, and it must not page anyone.
    """


def _require(name: str, value: str) -> str:
    """Same shape as `payments._require`, and the same rule: env only, never a request, never a DB."""
    if not value:
        raise PodControlDisabled(
            f"{name} is not configured, so pod control does nothing. Set it in the environment."
        )
    return value


def is_armed() -> bool:
    """Whether a call would do anything. Safe to ask from anywhere; makes no request."""
    return bool(
        config.POD_CONTROL_ENABLED and config.RUNPOD_API_KEY and config.RUNPOD_POD_ID
    )


def _assert_armed() -> tuple[str, str]:
    """Refuse before constructing a URL. Returns `(api_key, pod_id)`.

    The order matters: every public method calls this first, so an unconfigured or disarmed service
    cannot reach the point where a URL exists to be sent anywhere.
    """
    if not config.POD_CONTROL_ENABLED:
        raise PodControlDisabled(
            "POD_CONTROL_ENABLED is off. Pod control is inert by default because a RunPod API key "
            "is account-wide, and this account has pods that must not be touched."
        )
    key = _require("RUNPOD_API_KEY", config.RUNPOD_API_KEY)
    pod_id = _require("RUNPOD_POD_ID", config.RUNPOD_POD_ID)
    return key, pod_id


async def _call(method: str, action: str | None = None) -> dict:
    """The only place a request is made. One pod, named by configuration, never by an argument."""
    key, pod_id = _assert_armed()

    # Built from the CONFIGURED id. Note there is no parameter to interpolate here, by design --
    # see the module docstring.
    url = f"{RUNPOD_API}/pods/{pod_id}"
    if action:
        url = f"{url}/{action}"

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.request(
                method, url, headers={"Authorization": f"Bearer {key}"}
            )
    except httpx.HTTPError as exc:
        raise PodControlError(f"could not reach RunPod: {exc}") from exc

    if response.status_code >= 400:
        # The body may echo the request. Log the status and the action, never the response text and
        # never the key.
        logger.error("runpod %s %s returned %s", method, action or "get", response.status_code)
        raise PodControlError(f"RunPod returned {response.status_code} for {action or 'get'}")

    try:
        return response.json()
    except ValueError:
        return {}


async def describe() -> dict:
    """The configured pod's current state. The only read this client performs."""
    return await _call("GET")


async def start() -> dict:
    """Start the configured pod. Idempotent at the provider: starting a running pod is a no-op."""
    logger.info("starting the configured RunPod pod")
    return await _call("POST", "start")


async def stop() -> dict:
    """Stop the configured pod.

    STOP, NOT TERMINATE, and this client offers no terminate at all. `docs/rl/DECISIONS.md` D-001
    concluded the opposite -- terminate rather than stop, because a stopped volume bills at double
    the running rate -- but that decision is scoped to a batch TRAINING pod between phases, where
    nothing on the volume is worth keeping and the next phase re-downloads anyway.

    A serving pod is a different case. Stopping halts the GPU charge (roughly $0.49/hr for the A40)
    and raises the volume rate from $0.10 to $0.20 per GB-month; on a 100 GB volume that delta is
    about $0.014/hr. Paying a hundredth to save a half is not close. Terminating would also pay ~10
    minutes of GPU and ~18 GB of re-download on every wake.

    There is deliberately no `terminate()` here. Termination destroys a volume, it is not needed for
    the cost case, and the way to make an irreversible operation safe is not to implement it.
    """
    logger.info("stopping the configured RunPod pod")
    return await _call("POST", "stop")
