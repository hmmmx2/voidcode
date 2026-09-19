"""Prometheus metrics. Spec §6.2 asks for instrumentation; there was no `/metrics` endpoint.

WHAT IS MEASURED, AND WHY THESE
----------------------------------
Request count and latency are the default answer and they are the least useful thing here. A
histogram of every HTTP path tells you the API is up, which `/health` already does. The series
below exist because each one answers a question that has come up in this codebase and could not
be answered. The count is deliberately not stated: it said "these four" while the list held five.

  * **`voidcode_unverified_identity_requests_total` and `voidcode_internal_auth_enforced` are
    GONE.** They measured the rollout of signed identity headers for the website's server-side
    proxy: how much traffic still arrived unsigned, and whether unsigned was still accepted. The
    proxy, the headers and the flag went with the website (see `identity.py`), so both series
    could only ever read zero — and a dashboard panel that can only read zero is read as a live
    risk by whoever opens it next. The panels were removed from
    `deploy/monitoring/grafana-voidcode.json` in the same change.

  * **`voidcode_ratelimit_not_enforced_total`** — the rate limiter fails OPEN when Redis is
    unreachable. That is a deliberate availability trade, and its cost is that the failure is
    invisible: requests keep succeeding and nothing is limited. A counter makes the window visible
    after the fact.

  * **`voidcode_recommendations_ranked_by`** — labelled `model` or `mastery`. Everything served today
    is the heuristic, because the ranker refuses to fit below two learners. When that changes, this
    is how anybody knows — otherwise a personalisation claim rests on someone's memory of which
    branch was taken.

  * **`voidcode_sandbox_verdicts_total`** — labelled by Judge0 status. A rise in Time Limit Exceeded
    is either a harder problem set or a slower judge, and telling those apart needs the series.

  * **`voidcode_inference_backend_state`** — labelled `ready`, `waking` or `down`.
    `/health` has always known this: it probes the delegated backend and reports `backendState`
    beside `model_loaded`. But `/health` is polled by the kubelet and scraped by nothing, so
    the answer reached a readiness decision and nowhere else — nobody could alert on "the
    backend has been unreachable for five minutes", which is the outage this project has
    already had once. The gap was never the endpoint; it was that the endpoint was the only
    reader.

WHY NOT A MIDDLEWARE OVER EVERY ROUTE
----------------------------------------
Cardinality. A `path` label on a router with `/{slug}` templates becomes one series per problem, and
a metrics endpoint that returns megabytes is one that gets scraped less often and then not at all.
Per-route latency belongs in a tracing tool, not here.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

try:
    from prometheus_client import (
        CONTENT_TYPE_LATEST,
        CollectorRegistry,
        Counter,
        Gauge,
        Histogram,
        generate_latest,
    )

    _AVAILABLE = True
except ImportError:  # pragma: no cover - the dependency is declared, this is belt and braces
    _AVAILABLE = False
    CONTENT_TYPE_LATEST = "text/plain"

#: A dedicated registry rather than the global default.
#:
#: The default registry is process-wide and pre-populated with GC and platform collectors, and
#: anything else that imports prometheus_client adds to it. An explicit registry means the endpoint
#: returns what this module declares and cannot start emitting a library's internals because a
#: dependency changed.
REGISTRY = CollectorRegistry() if _AVAILABLE else None

if _AVAILABLE:
    ratelimit_not_enforced = Counter(
        "voidcode_ratelimit_not_enforced_total",
        "Requests allowed through because Redis was unreachable and the limiter failed open.",
        ["limit"],
        registry=REGISTRY,
    )
    recommendations_ranked_by = Counter(
        "voidcode_recommendations_ranked_by",
        "Recommendation responses, by how they were actually ranked.",
        ["ranked_by"],
        registry=REGISTRY,
    )
    sandbox_verdicts = Counter(
        "voidcode_sandbox_verdicts_total",
        "Code execution results, by Judge0 status description.",
        ["status"],
        registry=REGISTRY,
    )
    # ── GPU serving budget ───────────────────────────────────────────────────
    #
    # Nothing on the GPU billing or serving path emitted a metric before this. `gpu_sweep_service`
    # even names `voidcode_gpu_reservations_swept_total` in its own docstring -- "a page, not a
    # revenue line" -- and the counter did not exist, so the page it argues for could never fire.
    #
    # These are the four numbers that say whether the queue is sized right. Depth and wait say
    # whether anybody is suffering; abandonment says whether they are giving up rather than
    # waiting; slots-in-use says whether the capacity figure bears any relation to the hardware,
    # which matters because that figure is currently unmeasured.
    gpu_reservations_swept = Counter(
        "voidcode_gpu_reservations_swept_total",
        "Holds released by the sweep because their settle never ran. Non-zero means requests are "
        "dying between reserve and settle; the credit is returned either way.",
        registry=REGISTRY,
    )
    gpu_queue_depth = Gauge(
        "voidcode_gpu_queue_depth",
        "Requests waiting for a serving slot, fleet-wide.",
        registry=REGISTRY,
    )
    gpu_slots_in_use = Gauge(
        "voidcode_gpu_slots_in_use",
        "Serving slots currently held under a live lease, fleet-wide. Compare against capacity: "
        "sustained saturation is the signal to raise capacity or spin up a second backend.",
        registry=REGISTRY,
    )
    gpu_queue_wait_seconds = Histogram(
        "voidcode_gpu_queue_wait_seconds",
        "How long an admitted request waited for a slot.",
        # Buckets chosen against the wait ceiling rather than a default spread: anything past ~120s
        # is refused, so buckets beyond that would always be empty and the interesting resolution
        # is at the low end, where a learner still thinks the page is working.
        buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120),
        registry=REGISTRY,
    )
    gpu_queue_abandoned = Counter(
        "voidcode_gpu_queue_abandoned_total",
        "Queued requests that left before being admitted, by why.",
        ["reason"],
        registry=REGISTRY,
    )
    #: Whether the delegated inference backend answered its last probe.
    #:
    #: A STATE LABEL RATHER THAN A 1/0 GAUGE, because `down` and `waking` call for opposite
    #: reactions and are indistinguishable from outside: one is a page, the other is a wait while a
    #: pod that was deliberately stopped comes back. Exactly one of the three is 1 at any time,
    #: which is the standard way to represent an enum here and is what makes
    #: `voidcode_inference_backend_state{state="down"} == 1 for 5m` a usable alert.
    #:
    #: ONLY EMITTED ON THE DELEGATED PATH. `backend_registry` is configured when inference is
    #: delegated over HTTP; on the in-process HuggingFace and vLLM paths it is never configured and
    #: this series is absent rather than reporting a false `down`. Absent is the honest answer
    #: there — backend readiness on those paths is "is a model object loaded", a different question
    #: that `/health` answers as `model_loaded`.
    #:
    #: AS FRESH AS THE LAST PROBE, which is not a scrape. Nothing here polls the backend on a timer:
    #: the value is set inside `backend_registry.probe()`, whose callers are `/health` and
    #: `_is_model_ready()`. In the cluster that means the readiness probe's cadence — ten seconds
    #: per pod — and a process nobody is probing reports its last known state until somebody asks.
    inference_backend_state = Gauge(
        "voidcode_inference_backend_state",
        "1 for the delegated inference backend's current state, 0 for the others. Absent when "
        "inference runs in-process.",
        ["state"],
        registry=REGISTRY,
    )

    solutions_withheld = Counter(
        "voidcode_solutions_withheld_total",
        "Replies where a complete solution to the learner's own exercise was removed on the way "
        "out. Non-zero is EXPECTED, not an incident: it is the model trying and the guard holding. "
        "A sustained rise means the prompts have drifted; a drop to zero means the guard stopped "
        "running, which looks identical to success and is why this is counted at all.",
        ["mode"],
        registry=REGISTRY,
    )
else:  # pragma: no cover
    ratelimit_not_enforced = None
    recommendations_ranked_by = sandbox_verdicts = None
    gpu_reservations_swept = gpu_queue_depth = gpu_slots_in_use = None
    gpu_queue_wait_seconds = gpu_queue_abandoned = solutions_withheld = None
    inference_backend_state = None


def _bump(metric, labels: dict | None = None) -> None:
    """Increment, or do nothing.

    Every call site uses this rather than touching the counter directly. Instrumentation must never
    be the reason a request fails: a metric that raises inside a handler turns an observability gap
    into an outage, which is the opposite of the point.
    """
    if metric is None:
        return
    try:
        (metric.labels(**labels) if labels else metric).inc()
    except Exception as exc:
        logger.debug("metric update failed: %s", exc)


def record_ratelimit_not_enforced(limit: str) -> None:
    _bump(ratelimit_not_enforced, {"limit": limit})


def record_ranked_by(ranked_by: str) -> None:
    _bump(recommendations_ranked_by, {"ranked_by": ranked_by})


def record_sandbox_verdict(status: str) -> None:
    # Judge0's descriptions are a closed set, so this label cannot explode. Truncated anyway,
    # because an unexpected value becoming a permanent series is how cardinality problems start.
    _bump(sandbox_verdicts, {"status": (status or "unknown")[:40]})


def record_reservation_swept() -> None:
    _bump(gpu_reservations_swept)


def record_queue_abandoned(reason: str) -> None:
    """`reason` is a closed set -- timeout, disconnected, full -- so it cannot explode."""
    _bump(gpu_queue_abandoned, {"reason": (reason or "unknown")[:24]})


def observe_queue_wait(seconds: float) -> None:
    if gpu_queue_wait_seconds is None:
        return
    try:
        gpu_queue_wait_seconds.observe(seconds)
    except Exception as exc:
        logger.debug("histogram update failed: %s", exc)


def set_queue_gauges(depth: int, slots_in_use: int) -> None:
    """Set both together, because they are only meaningful read against each other.

    A depth of twenty with slots idle means the queue is broken; a depth of twenty with every slot
    held means it is working and undersized. Reporting one without the other invites the wrong
    conclusion.
    """
    for gauge, value in ((gpu_queue_depth, depth), (gpu_slots_in_use, slots_in_use)):
        if gauge is None:
            continue
        try:
            gauge.set(value)
        except Exception as exc:
            logger.debug("gauge update failed: %s", exc)


def set_backend_state(state: str, known_states: tuple[str, ...]) -> None:
    """Record the backend's state, zeroing the others so exactly one series is 1.

    `known_states` is passed in rather than listed here: the states belong to
    `backend_registry`, and a copy of them in this module is a copy that goes stale the day a
    fourth is added — leaving a permanently-1 series for a state the registry no longer reports.

    Silent on failure, like every other setter here. A metrics write must not be able to fail the
    probe that produced the value.
    """
    if not _AVAILABLE or inference_backend_state is None:
        return
    try:
        for candidate in known_states:
            inference_backend_state.labels(state=candidate).set(1 if candidate == state else 0)
    except Exception as exc:
        logger.debug("backend state gauge update failed: %s", exc)


def render() -> tuple[bytes, str]:
    """The scrape body and its content type."""
    if not _AVAILABLE:
        return (b"# prometheus_client is not installed\n", "text/plain")
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
