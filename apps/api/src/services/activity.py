"""When the GPU was last actually used, independent of whether anyone is being billed for it.

WHY THE IDLE PREDICATE NEEDED THIS

`spindown.measure` had four clauses. Three of them -- held reservations, queued tickets, live slot
leases -- are INSTANTANEOUS: non-zero only while a request is in flight, and zero the moment it
finishes. The only clause tracking recent activity was `max(gpu_reservations.settled_at)`, and
settles happen only when `GPU_METERING_ENABLED` is on.

With metering off that timestamp is frozen. Measured 2026-09-11 on the development stack: the last
settle was 28 hours old, the full tutor evaluation suite had run 91 generations through the backend
forty minutes earlier, and the predicate reported "idle". Arming spin-down would have stopped the
pod within one check interval, and again a couple of minutes after every wake, no matter who was
using it -- taking the backend away from a learner mid-session, which is the exact failure
`config.py` warns about two lines above the flag.

So: a clock that advances when the GPU is used, whatever the billing flags say.

WHY REDIS AND NOT A MODULE GLOBAL

`deploy/base/api-hpa.yaml` runs two to four replicas, and the idle watcher runs in every one of
them. A per-process timestamp means replica A can see an idle system and stop the pod while replica
B is streaming an answer. The clock has to be shared by every process that can serve or stop, and
Redis already is.

WHY UNKNOWN MEANS BUSY

The settle clause treats "nothing recorded" as idle, which is right for it: a pod that has never
served anything is not one somebody is waiting on. This clock cannot borrow that default. It is the
only signal that says "somebody is using this right now", so a failure to read it must hold the pod
OPEN rather than release it -- an unreachable Redis is a reason to be cautious, not a licence to
stop a machine that might be mid-answer. Hence `ActivityUnknown`, which the caller turns into "not
idle" rather than silently into a number.
"""

from __future__ import annotations

import logging
import time

from .. import redis_client

logger = logging.getLogger(__name__)

#: One key, shared by every replica. Namespaced like the rest of this application's Redis use.
KEY = "voidcode:gpu:last_activity"

#: Long enough that a pod idle over a weekend still reads as idle rather than as unknown, and short
#: enough that the key cannot outlive any plausible idle window. Expiry is a tidiness measure, not a
#: correctness one: an absent key means "nothing recently", which is what an expired one meant too.
TTL_SECONDS = 7 * 24 * 60 * 60


class ActivityUnknown(Exception):
    """The clock could not be read. NOT the same as "nothing has happened"."""


async def touch() -> None:
    """Record that the GPU is being used right now.

    Never raises and never blocks a request on a failure. A serving path that 500s because a
    bookkeeping write failed has turned an observability feature into an outage, and the cost of
    losing one write is at worst a spin-down a few minutes early -- while the cost of failing the
    request is immediate and the learner's.
    """
    try:
        await redis_client.get_redis().set(KEY, str(time.time()), ex=TTL_SECONDS)
    except Exception as exc:
        logger.debug("could not record gpu activity: %s", exc)


async def seconds_since() -> float | None:
    """How long since the GPU was last used, or None if it never has been.

    Raises `ActivityUnknown` when the clock cannot be read at all. The distinction is the whole
    point: "nothing has ever been served" and "I cannot tell you" call for opposite decisions, and
    collapsing them into one None is how a pod gets stopped under a live user.
    """
    try:
        raw = await redis_client.get_redis().get(KEY)
    except Exception as exc:
        raise ActivityUnknown(str(exc)) from exc

    if raw is None:
        return None
    try:
        return max(0.0, time.time() - float(raw))
    except (TypeError, ValueError) as exc:
        # A key of the right name holding the wrong thing is not "no activity" either.
        raise ActivityUnknown(f"unreadable value in {KEY}: {raw!r}") from exc
