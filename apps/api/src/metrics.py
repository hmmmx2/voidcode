"""Prometheus metrics. Spec §6.2 asks for instrumentation; there was no `/metrics` endpoint.

WHAT IS MEASURED, AND WHY THESE
----------------------------------
Request count and latency are the default answer and they are the least useful thing here. A
histogram of every HTTP path tells you the API is up, which `/health` already does. These four exist
because each one answers a question that has come up in this codebase and could not be answered:

  * **`voidcode_unverified_identity_requests_total`** — the deploy gate for `INTERNAL_AUTH_ENFORCE`.
    `identity.py` counts unsigned requests in a module global, and the only way to read it was to
    grep the logs. Flipping that flag safely means watching this reach zero, so it needs to be a
    series on a dashboard, not a number in a process.

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
    unverified_identity_requests = Counter(
        "voidcode_unverified_identity_requests_total",
        "Requests served with an unsigned X-User-Id while INTERNAL_AUTH_ENFORCE is off. "
        "Must reach zero before that flag is flipped.",
        registry=REGISTRY,
    )
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
    enforcement_enabled = Gauge(
        "voidcode_internal_auth_enforced",
        "1 when signed identity is required, 0 while unsigned requests are still accepted.",
        registry=REGISTRY,
    )
else:  # pragma: no cover
    unverified_identity_requests = ratelimit_not_enforced = None
    recommendations_ranked_by = sandbox_verdicts = enforcement_enabled = None


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


def record_unverified_identity() -> None:
    _bump(unverified_identity_requests)


def record_ratelimit_not_enforced(limit: str) -> None:
    _bump(ratelimit_not_enforced, {"limit": limit})


def record_ranked_by(ranked_by: str) -> None:
    _bump(recommendations_ranked_by, {"ranked_by": ranked_by})


def record_sandbox_verdict(status: str) -> None:
    # Judge0's descriptions are a closed set, so this label cannot explode. Truncated anyway,
    # because an unexpected value becoming a permanent series is how cardinality problems start.
    _bump(sandbox_verdicts, {"status": (status or "unknown")[:40]})


def set_enforcement(enabled: bool) -> None:
    if enforcement_enabled is not None:
        try:
            enforcement_enabled.set(1 if enabled else 0)
        except Exception as exc:
            logger.debug("gauge update failed: %s", exc)


def render() -> tuple[bytes, str]:
    """The scrape body and its content type."""
    if not _AVAILABLE:
        return (b"# prometheus_client is not installed\n", "text/plain")
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
