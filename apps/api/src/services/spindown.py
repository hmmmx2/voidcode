"""Stop paying for a GPU nobody is using, and start it again when somebody is.

THE IDLE PREDICATE HAS FOUR CLAUSES AND ALL FOUR ARE LOAD-BEARING.

Dropping any one of them stops a stream a learner is watching:

  1. **No reservation is `held`.** A hold means a request is in flight and its credit is committed.
  2. **No queue ticket is `waiting` or `admitted`.** Somebody is in line, or has just been let in
     and has not taken their slot yet. A pod stopped here refuses the request it was about to serve.
  3. **No slot has a live lease.** The authoritative statement that capacity is in use, and the one
     that survives a replica dying -- clauses 1 and 2 are about what the database was told, this is
     about what is actually held.
  4. **Nothing settled recently.** The others are all instantaneous; without this, spin-down fires
     in the gap between one request finishing and the next arriving, and a learner reading an answer
     before asking a follow-up pays a multi-minute cold start for it.

They are tested one at a time rather than together, because a single combined test passes with two
of the three instantaneous clauses missing.

WHY THIS CANNOT SHIP BEFORE THE QUEUE

The first request after a spin-down waits minutes. `main.py`'s startup poll budgets five for a cold
SGLang and proceeds anyway; the serving benchmark measured 560 seconds to load 16 GB of AWQ weights
on a warm page cache. No client tolerates that silently, and the only honest place to report it is
the queue's own progress channel -- which is why `backend_registry` distinguishes `waking` from
`down`, and why this is the last of the pod-lifecycle work rather than the first.

WHY STOP AND NOT TERMINATE, WHICH REVERSES THIS PROJECT'S EXISTING RULE

`docs/rl/RUNBOOK-P0.md` and `docs/rl/DECISIONS.md` D-001 both say terminate, never stop, because a
stopped volume bills at $0.20/GB-month against $0.10 running -- double, for doing nothing. That rule
is correct and it is scoped to a batch TRAINING pod between phases, where the volume holds nothing
worth keeping and the next phase re-downloads regardless.

A serving pod is a different case and the arithmetic is not close. Stopping halts the GPU charge,
roughly $0.49/hr for the A40, and costs the extra $0.10/GB-month: about $0.014/hr on a 100 GB
volume. Terminating saves that fourteen-thousandths and pays ~10 minutes of GPU plus ~18 GB of
re-download on every wake -- and gets a new address every time, which is a correctness problem
rather than a cost one.

This is recorded as an amendment to D-001 scoped to serving pods, in the decisions file, so the next
person does not "fix" it back.

WHAT THIS MODULE DOES NOT DO

It does not decide capacity, it does not wake the pod on demand -- the first request after a stop is
what triggers `ensure_awake()` -- and it does not terminate anything, because `runpod_client` has no
terminate to call.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from .. import config
from ..database import AsyncSessionLocal
from ..models.gpu_billing import GpuReservation
from ..models.gpu_queue import STATE_ADMITTED, STATE_WAITING, GpuQueueTicket, GpuSlot
from . import backend_registry, runpod_client

logger = logging.getLogger(__name__)


class IdleReport:
    """Why the pod is or is not idle. A structure rather than a bool, so the log says which clause
    held it open -- 'not idle' with no reason is the kind of line nobody can act on."""

    __slots__ = ("held_reservations", "queued_tickets", "leased_slots", "seconds_since_settle")

    def __init__(self, held: int, queued: int, leased: int, since: float | None):
        self.held_reservations = held
        self.queued_tickets = queued
        self.leased_slots = leased
        self.seconds_since_settle = since

    def is_idle(self, idle_after_seconds: float) -> bool:
        if self.held_reservations or self.queued_tickets or self.leased_slots:
            return False
        # None means nothing has ever settled. That is idle: a pod that has served nothing is not
        # one somebody is waiting on.
        if self.seconds_since_settle is None:
            return True
        return self.seconds_since_settle >= idle_after_seconds

    def why_busy(self, idle_after_seconds: float) -> str:
        """What is holding the pod open, or "idle".

        TAKES THE THRESHOLD, because the recency clause cannot be judged without it. The first
        version did not, and reported "last settle 99999s ago" for a system that was thoroughly
        idle -- a log line that reads as a reason when it is the opposite of one. Only report a
        clause that is actually holding something open.
        """
        reasons = []
        if self.held_reservations:
            reasons.append(f"{self.held_reservations} held reservation(s)")
        if self.queued_tickets:
            reasons.append(f"{self.queued_tickets} queued ticket(s)")
        if self.leased_slots:
            reasons.append(f"{self.leased_slots} leased slot(s)")
        if (
            not reasons
            and self.seconds_since_settle is not None
            and self.seconds_since_settle < idle_after_seconds
        ):
            reasons.append(f"last settle {self.seconds_since_settle:.0f}s ago")
        return ", ".join(reasons) or "idle"


async def measure(db) -> IdleReport:
    """The four clauses, in one pass. Reads only; decides nothing."""
    now = datetime.now(timezone.utc)

    held = int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuReservation)
                .where(GpuReservation.state == "held")
            )
        ).scalar_one()
    )
    queued = int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuQueueTicket)
                .where(GpuQueueTicket.state.in_((STATE_WAITING, STATE_ADMITTED)))
            )
        ).scalar_one()
    )
    leased = int(
        (
            await db.execute(
                select(func.count())
                .select_from(GpuSlot)
                .where(GpuSlot.holder.is_not(None), GpuSlot.leased_until > now)
            )
        ).scalar_one()
    )
    last_settle = (
        await db.execute(select(func.max(GpuReservation.settled_at)))
    ).scalar_one_or_none()

    since = None
    if last_settle is not None:
        if last_settle.tzinfo is None:
            last_settle = last_settle.replace(tzinfo=timezone.utc)
        since = (now - last_settle).total_seconds()

    return IdleReport(held, queued, leased, since)


async def consider_stopping() -> bool:
    """Stop the pod if every clause says nobody needs it. Returns whether it was stopped.

    INERT WHEN POD CONTROL IS NOT ARMED, and it checks that FIRST -- before reading the database.
    A watcher that measured idleness and then discovered it could do nothing about it would log a
    decision it never had the authority to make, which is how a log stops being trustworthy.
    """
    if not config.SPINDOWN_ENABLED:
        return False
    if not runpod_client.is_armed():
        logger.debug("spin-down is enabled but pod control is not armed; doing nothing")
        return False

    async with AsyncSessionLocal() as db:
        report = await measure(db)

    if not report.is_idle(config.SPINDOWN_IDLE_SECONDS):
        logger.debug("pod is not idle: %s", report.why_busy(config.SPINDOWN_IDLE_SECONDS))
        return False

    logger.info(
        "no held reservations, no queued tickets, no leased slots, and nothing settled for %ss "
        "— stopping the pod",
        int(report.seconds_since_settle) if report.seconds_since_settle else "ever",
    )
    try:
        await runpod_client.stop()
    except runpod_client.PodControlError as exc:
        logger.error("could not stop the pod: %s", exc)
        return False

    # Recorded BEFORE anyone asks, so the first request after this reads "waking" rather than
    # "down". The two are indistinguishable from outside and call for opposite reactions.
    backend_registry.expect_restart(True)
    return True


async def ensure_awake() -> None:
    """Start the pod if it is not answering. Safe to call on every request; cheap when ready.

    Idempotent at the provider -- starting a running pod is a no-op -- and behind the same armed
    check as everything else, so an unconfigured deployment falls through immediately.
    """
    if not runpod_client.is_armed():
        return
    if await backend_registry.probe() == backend_registry.READY:
        return

    backend_registry.expect_restart(True)
    try:
        await runpod_client.start()
    except runpod_client.PodControlError as exc:
        logger.error("could not start the pod: %s", exc)


async def watch_loop(interval_seconds: float | None = None) -> None:
    """Check periodically. Started from the lifespan; exits immediately when disabled.

    Failures are swallowed and the loop continues. A watcher that dies on one bad database call
    stops watching forever, and the way that presents is a GPU bill rather than an error.
    """
    if not config.SPINDOWN_ENABLED:
        logger.info("spin-down is disabled; the idle watcher will not run")
        return

    interval = interval_seconds or config.SPINDOWN_CHECK_SECONDS
    logger.info("idle watcher started, checking every %.0fs", interval)
    while True:
        await asyncio.sleep(interval)
        try:
            await consider_stopping()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("idle check failed, continuing: %s", exc)
