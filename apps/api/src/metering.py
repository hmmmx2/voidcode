"""Measuring how long a request held a serving slot, and settling credit against it.

WHY THE CLOCK IS THE SEMAPHORE AND NOTHING ELSE

The billable interval and the semaphore-held interval are deliberately made the *same interval*.
Every place that releases a permit is therefore a place that finishes a meter, and there is exactly
one invariant to keep rather than one per backend.

That buys three things which per-generation timing would not:

  * **The two-stage debug second generation is billed automatically.** `_localise_bugs()` runs inside
    the same permit as the answer it precedes; occupancy metering cannot miss it.
  * **Streaming needs no new timing code.** The three streaming generators time nothing today and
    still do not have to.
  * **A future fourth release site that forgets to settle is detectable**, because it leaves a `held`
    reservation the sweep will find and a source-level test can refuse at review time.

The clock starts *after* `acquire()` returns, never before, so a request never pays for time it
spent waiting for a slot.

NO SECOND GENERATOR LAYER, EVER

`main.py` carries a comment recording an API that "died silently after 20-60 requests" because a
discarded async-generator wrapper's `finally` never ran and the upstream stream leaked. Nothing here
wraps a generator. `_semaphore_wrapped` -- which already exists and already has the `finally` this
needs -- gains one optional argument and keeps its body.

AND NO DATABASE I/O INSIDE THAT `finally`

When a client disconnects, the surrounding task is being cancelled while that `finally` runs.
Awaiting there risks swallowing the `CancelledError` or hanging the close. So the finish path spawns
a task and returns immediately, and the task holds a strong reference in a module-level set --
a garbage-collected task is precisely the class of bug that killed this API once already.
"""

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field

from .database import AsyncSessionLocal
from .services import gpu_pricing, gpu_wallet_service

logger = logging.getLogger(__name__)

#: Strong references to in-flight settle tasks. Without this, asyncio only holds a weak reference and
#: a settle can be collected mid-flight, silently losing the charge.
_settle_tasks: set[asyncio.Task] = set()


@dataclass
class Meter:
    """One request's occupancy of one slot, and the reservation it settles against."""

    reservation_id: uuid.UUID
    user_id: uuid.UUID
    hold_micro: int
    #: `time.monotonic()`, not wall clock: a clock adjustment mid-request must not change a charge.
    started_at: float = field(default_factory=time.monotonic)
    #: Set by the non-streaming paths, which already time the backend call. Audit only.
    backend_ms: int | None = None
    _finished: bool = False

    @property
    def slot_ms(self) -> int:
        return int((time.monotonic() - self.started_at) * 1000)

    def finish(self, *, consumed: bool) -> None:
        """Settle (or void) without blocking the caller. Safe inside a `finally` during cancellation.

        `consumed=False` means the request never reached the model -- a failed prompt build, or a
        configuration refusal -- so the hold is released without charge.
        """
        if self._finished:
            return
        self._finished = True
        slot_ms = self.slot_ms

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop: nothing can be scheduled. The sweep is the backstop, which is why it exists.
            logger.error(
                "gpu meter could not schedule a settle (no running loop): reservation=%s",
                self.reservation_id,
            )
            return

        task = loop.create_task(self._finish_now(slot_ms=slot_ms, consumed=consumed))
        _settle_tasks.add(task)
        task.add_done_callback(_settle_tasks.discard)

    async def _finish_now(self, *, slot_ms: int, consumed: bool) -> None:
        # Its own session: the request-scoped one from `get_db()` is closed by now, and its
        # commit-on-exit semantics are wrong for this anyway.
        try:
            async with AsyncSessionLocal() as db:
                if consumed:
                    await gpu_wallet_service.settle(
                        db, self.reservation_id, slot_ms=slot_ms, backend_ms=self.backend_ms
                    )
                else:
                    await gpu_wallet_service.void(db, self.reservation_id)
        except Exception:
            # Never re-raise out of a background task: it would be logged as "task exception was
            # never retrieved" and nothing else. The hold stays `held` and the sweep releases it.
            logger.exception(
                "gpu settle failed, leaving the hold for the sweep: reservation=%s",
                self.reservation_id,
            )


async def begin(
    db,
    user_id: uuid.UUID,
    *,
    request_id: str,
    kind: str,
    backend: str,
    max_slot_seconds: int,
    floor_micro: int,
) -> Meter:
    """Reserve the worst case and start the clock. Raises `WalletError` if it cannot be afforded.

    The hold is a ceiling, not a forecast. Holding the maximum is what makes "refuse before the pod
    runs" possible: a learner who cannot afford the worst case is refused up front rather than
    discovering it mid-generation, and the settle returns whatever was not used.
    """
    row = gpu_pricing.rate_for()
    hold_micro = gpu_pricing.hold_micro_for(max_slot_seconds, floor_micro=floor_micro)

    reservation = await gpu_wallet_service.reserve(
        db,
        user_id,
        hold_micro=hold_micro,
        request_id=request_id,
        kind=kind,
        backend=backend,
        rate_micro_per_slot_second=row.rate_micro_per_slot_second,
    )
    return Meter(
        reservation_id=reservation.id, user_id=user_id, hold_micro=hold_micro
    )


async def drain(timeout: float = 5.0) -> None:
    """Wait for in-flight settles at shutdown, so a rollout does not strand holds.

    Called from the lifespan's shutdown. `terminationGracePeriodSeconds` is 60, so five seconds is
    affordable. Anything still unfinished after that is the sweep's problem, which is fine -- this is
    an optimisation on the sweep, not a substitute for it.
    """
    if not _settle_tasks:
        return
    pending = list(_settle_tasks)
    logger.info("waiting for %d gpu settle task(s) at shutdown", len(pending))
    done, still_pending = await asyncio.wait(pending, timeout=timeout)
    if still_pending:
        logger.warning(
            "%d gpu settle task(s) did not finish in %.1fs; the sweep will release them",
            len(still_pending), timeout,
        )


@contextlib.asynccontextmanager
async def gpu_slot(
    semaphore: asyncio.Semaphore,
    user_id: uuid.UUID,
    *,
    kind: str,
    backend: str,
    max_slot_seconds: int,
    floor_micro: int,
    acquire_timeout: float = 30.0,
    enforce: bool = False,
):
    """Hold a serving slot for one awaited generation, metered, for callers that are not the
    streaming endpoint.

    SAFE AS A CONTEXT MANAGER HERE, AND ONLY HERE. The streaming path cannot use one, because
    wrapping an async generator is the failure `main.py` documents at length. This wraps a single
    `await`, so there is no generator to discard and no `finally` that can be skipped.

    IT ALSO TAKES THE PERMIT, WHICH THE CALLER PREVIOUSLY DID NOT. Interview grading ran
    `generate_response` through `asyncio.to_thread` with no permit at all, so on the HuggingFace
    backend it executed `model.generate()` concurrently with up to `MAX_CONCURRENT_REQUESTS` chat
    generations — outside the semaphore that exists specifically to stop that from exhausting VRAM.
    That is a live out-of-memory risk independent of billing, and it is fixed here because the fix
    and the meter are the same acquire.

    Waiting rather than failing fast, unlike the chat endpoint: grading follows a submission the
    learner has already made, so a short wait is better than losing their assessment. Bounded, so a
    wedged pod returns an error instead of hanging the request.
    """
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=acquire_timeout)
    except (TimeoutError, asyncio.TimeoutError) as exc:
        raise SlotUnavailable(
            f"no serving slot became free within {acquire_timeout:.0f}s"
        ) from exc

    meter = None
    try:
        if enforce:
            async with AsyncSessionLocal() as db:
                meter = await begin(
                    db, user_id, request_id=f"assess-{uuid.uuid4().hex}", kind=kind,
                    backend=backend, max_slot_seconds=max_slot_seconds, floor_micro=floor_micro,
                )
        yield meter
    except BaseException:
        semaphore.release()
        if meter is not None:
            meter.finish(consumed=False)
        raise
    else:
        semaphore.release()
        if meter is not None:
            meter.finish(consumed=True)


class SlotUnavailable(Exception):
    """No serving slot came free in time. Callers map this to a 503."""
