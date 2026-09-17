"""The wiring invariants, asserted against `main.py`'s source.

These read source rather than call functions, and that is deliberate rather than lazy. Every defect
they guard is a **call site** defect — a release without a settle, a clock started too early, a
second generator layer — and none of them is visible from the outside of a function. The codebase
already uses this shape (`test_ratelimit.py` asserts the limiter's name appears in the routers that
must call it), for the same reason: the thing that was broken was the wiring, not the unit.

`main.py` is never imported here. It pulls torch at module scope, which is why the whole API suite
avoids it.
"""

import ast
import re
from pathlib import Path

import pytest

MAIN = Path(__file__).resolve().parents[1] / "src" / "main.py"
SOURCE = MAIN.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)

#: `metering.py` is parsed too, because it releases the same semaphore object. `interviews.py`
#: imports `_inference_semaphore` from `main` and hands it to `metering.gpu_slot`, so a guard that
#: reads only `main.py` is blind to half the release sites.
METERING = Path(__file__).resolve().parents[1] / "src" / "metering.py"
METERING_SOURCE = METERING.read_text(encoding="utf-8")
METERING_TREE = ast.parse(METERING_SOURCE)


def _find_function(tree: ast.AST, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _function(name: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    found = _find_function(TREE, name)
    if found is None:
        raise AssertionError(
            f"{name} is gone from main.py — this test needs rewriting, not deleting"
        )
    return found


def _sole_offset(body: str, pattern: str, what: str) -> int:
    """Where `pattern` appears, insisting it appears exactly once.

    `str.index` was used here and it is a trap in a wiring guard: when the thing it looks for is
    renamed, `index` raises `ValueError` from inside the test rather than failing with a message,
    so the person who renamed it sees a crash in a file they did not touch and no statement of what
    invariant they broke. `re.search` plus an explicit count says what happened and what to do —
    the shape `test_judge0_auth.py` already uses.
    """
    matches = list(re.finditer(pattern, body))
    assert len(matches) == 1, (
        f"expected exactly one occurrence of {what} ({pattern!r}), found {len(matches)}. "
        "If it was renamed or duplicated, update this test — the invariant it guards is still real."
    )
    return matches[0].start()


class TestEveryReleaseIsAlsoASettle:
    """The single highest-value guard in this file.

    A permit released without finishing the meter leaves a reservation `held` forever, and the
    learner's credit held with it until the sweep expires it. The failure is silent and the money is
    real, so the invariant is enforced structurally: there is exactly one place that releases.
    """

    def test_the_only_release_call_is_inside_release_slot(self):
        """Across BOTH files that touch this semaphore, not just `main.py`.

        The original version parsed `main.py` alone and matched only the literal name
        `_inference_semaphore`. `metering.gpu_slot` released the same object under the parameter
        name `semaphore` -- `interviews.py` imports `_inference_semaphore` from `main` and passes it
        in -- so two unguarded releases sat in plain sight of a test written to find exactly them.
        Matching on the attribute `.release` rather than on the receiver's name is what closes that.
        """
        offenders = []
        for label, tree, source in (
            ("main.py", TREE, SOURCE),
            ("metering.py", METERING_TREE, METERING_SOURCE),
        ):
            allowed = set()
            for name in ("_release_slot", "release_slot"):
                fn = _find_function(tree, name)
                if fn is not None:
                    allowed |= set(range(fn.lineno, (fn.end_lineno or fn.lineno) + 1))

            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr == "release":
                    if node.lineno not in allowed:
                        offenders.append(f"{label}:{node.lineno}")

        assert offenders == [], (
            f"a semaphore is released outside the release helper at {offenders}. Every release "
            "must also finish the meter, or that request's hold is stranded. Route it through "
            "`metering.release_slot(semaphore, meter, consumed=...)`."
        )

    def test_release_slot_actually_finishes_the_meter(self):
        """Guards the guard: the test above proves nothing if the helper stops settling."""
        helper = _find_function(METERING_TREE, "release_slot")
        assert helper is not None, "metering.release_slot is gone -- update the guard above"
        body = ast.get_source_segment(METERING_SOURCE, helper) or ""
        assert "semaphore.release()" in body
        assert "meter.finish(" in body

    def test_main_still_routes_its_releases_through_the_helper(self):
        """`main.py`'s own wrapper must delegate rather than release directly."""
        helper = _function("_release_slot")
        body = ast.get_source_segment(SOURCE, helper) or ""
        assert "metering.release_slot(" in body, (
            "`_release_slot` no longer delegates to `metering.release_slot`, so the two files can "
            "drift apart again"
        )


class TestTheClockStartsAfterTheSlotIsHeld:
    """A request must never pay for the time it spent waiting for a slot.

    Queue wait is a throughput problem. If the meter started above the acquire, a busy pod would
    charge learners for its own contention and the number would still look plausible.

    THERE ARE NOW TWO PLACES THAT TAKE A SLOT AND THEN PREPARE, and both are checked. The ordinary
    path does it in `create_chat_completion`; a request that had to queue does it inside
    `_queued_stream`, after the wait it reported to the caller. A guard that only knew about the
    first would have gone quiet about half the paths the moment the queue was switched on.
    """

    @pytest.mark.parametrize("holder", ["create_chat_completion", "_queued_stream"])
    def test_metering_begins_after_acquire_not_before(self, holder: str):
        body = ast.get_source_segment(SOURCE, _function(holder)) or ""
        acquire = _sole_offset(
            body, r"_inference_semaphore\.acquire\(\)", f"the semaphore acquire in {holder}"
        )
        prepare = _sole_offset(
            body, r"_prepare_for_generation\(", f"the preparation call in {holder}"
        )
        assert acquire < prepare, (
            f"{holder} prepares before acquiring a permit, so the meter would start during the "
            "wait and queue time would be billed"
        )

    def test_the_meter_starts_inside_preparation_and_nowhere_else(self):
        """`_begin_metering` moved into the helper; it must not reappear beside it.

        Two call sites would mean two holds for one request, and the second would be invisible until
        somebody read a ledger and found a learner charged twice for one answer.
        """
        calls = re.findall(r"_begin_metering\(", SOURCE)
        assert len(calls) == 2, (
            f"expected exactly two occurrences of `_begin_metering(` -- its definition and the one "
            f"call in `_prepare_for_generation` -- found {len(calls)}"
        )
        helper = ast.get_source_segment(SOURCE, _function("_prepare_for_generation")) or ""
        assert "_begin_metering(" in helper


class TestNoSecondGeneratorLayer:
    """`main.py` records an API that died silently after 20-60 requests when a discarded
    async-generator wrapper's `finally` never ran and the upstream stream leaked. The fix then was a
    response header rather than another generator. This encodes that as an executable rule."""

    def test_the_streaming_wrapper_takes_the_meter_rather_than_being_wrapped(self):
        wrapper = _function("_semaphore_wrapped")
        arg_names = [a.arg for a in wrapper.args.args]
        assert "meter" in arg_names, (
            "`_semaphore_wrapped` must accept the meter directly. Wrapping it in a second async "
            "generator to add metering is the failure mode main.py documents at length."
        )

    def test_every_streaming_response_passes_a_meter(self):
        """A streaming path that forgets the meter never settles — the stream is the long one."""
        calls = re.findall(r"_semaphore_wrapped\(", SOURCE)
        # One definition plus the three call sites.
        assert len(calls) >= 4, "expected the wrapper to be defined once and called three times"
        without_meter = re.findall(r"\)\),\s*\n\s*media_type=\"text/event-stream\"", SOURCE)
        assert without_meter == [], (
            "a `_semaphore_wrapped(...)` streaming response does not pass `meter`; that stream "
            "would never settle its reservation"
        )


class TestMeteringIsOffByDefault:
    def test_both_switches_default_off(self):
        """The request path must behave exactly as before until someone turns this on deliberately.

        There are no wallets yet. A metering flag that defaulted on would 402 or error every request
        the moment this merged.
        """
        from src import config

        assert config.GPU_METERING_ENABLED is False
        assert config.GPU_BILLING_ENFORCE is False

    def test_measurement_and_enforcement_are_separate_switches(self):
        """Measuring before charging is what lets a price come from observed occupancy.

        One flag would force the choice between "charge on a guessed price" and "collect no data".
        """
        config_source = (MAIN.parent / "config.py").read_text(encoding="utf-8")
        assert "GPU_METERING_ENABLED" in config_source
        assert "GPU_BILLING_ENFORCE" in config_source


class TestTheIdentityGate:
    def test_the_shared_anonymous_identity_is_refused(self):
        """One condition now, and it is the one that matters.

        The gate also required `caller.verified` — a signed `X-User-Id` header from the website's
        server-side proxy. That header is gone (`tests/test_web_auth_is_gone.py`), so a
        non-anonymous caller got here by presenting a session token this server issued. What still
        has to be excluded is the anonymous user: it is ONE identity shared by every signed-out
        caller, so a wallet on it would be one bank account for the whole internet.
        """
        gate = _function("_begin_metering")
        # Statements only: the docstring explains that `caller.verified` was removed, and a scan of
        # the raw text would match that explanation.
        statements = [
            node for node in gate.body
            if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant))
        ]
        code = chr(10).join(ast.get_source_segment(SOURCE, node) or "" for node in statements)
        assert "is_anonymous" in code, "the gate does not exclude the shared anonymous identity"
        assert "caller.verified" not in code, "the removed `verified` field is being read again"

    def test_the_endpoint_actually_resolves_a_caller(self):
        endpoint = _function("create_chat_completion")
        args = [a.arg for a in endpoint.args.args]
        assert "caller" in args, (
            "the metered endpoint takes no identity, so every request would be charged to nobody"
        )


class TestRefusalsHappenBeforeTheGpuIsTouched:
    """402 and 429 must both land before a permit is spent and before any generation starts.

    The two refusals sit in different functions now, so they are checked separately rather than by
    one parametrised marker. `prepare_messages_hybrid` moved into `_prepare_for_generation` along
    with the metering call that must precede it.
    """

    def test_the_rate_limit_runs_before_anything_expensive(self):
        """Ahead of the capacity gate, the queue and preparation alike.

        A flood that got as far as taking tickets would fill the queue with requests that were
        going to be refused anyway, pushing real learners behind them.
        """
        body = ast.get_source_segment(SOURCE, _function("create_chat_completion")) or ""
        limit = _sole_offset(body, r"ratelimit\.check_ip", "the rate limit")
        for later, label in (
            (r"queue_service\.try_acquire_lease\(", "the slot claim"),
            (r"_prepare_for_generation\(", "the preparation call"),
        ):
            assert limit < _sole_offset(body, later, label), (
                f"the rate limit runs after {label}"
            )

    def test_credit_is_checked_before_the_prompt_is_built(self):
        """Inside the helper both now live in: the hold, then the prompt.

        Building the prompt first would mean a learner with no credit still costs a retrieval and a
        template render before being told no.
        """
        body = ast.get_source_segment(SOURCE, _function("_prepare_for_generation")) or ""
        meter = _sole_offset(body, r"_begin_metering\(", "the metering start")
        prompt = _sole_offset(body, r"prepare_messages_hybrid\(", "the prompt build")
        assert meter < prompt, (
            "the prompt is built before credit is checked, so a refused request has already worked"
        )

    def test_the_queued_path_refuses_in_band_rather_than_raising(self):
        """Once headers are sent there is no status code left, and this is where that is honoured.

        A bare `raise HTTPException` inside `_queued_stream` would surface as a torn connection with
        no explanation, because the 200 has already gone out. Every refusal there has to become a
        frame.
        """
        body = ast.get_source_segment(SOURCE, _function("_queued_stream")) or ""
        assert "raise HTTPException" not in body, (
            "`_queued_stream` raises an HTTPException after headers are already sent; it must "
            "yield `_stream_error(...)` instead"
        )
        assert "_stream_error(" in body


class TestTheQueuedPathAddsNoSecondWrapper:
    """The failure this file already guards, restated for the path that was added after it.

    `main.py` records an API that died silently after 20-60 requests when a discarded async
    generator wrapper's `finally` never ran and the upstream stream leaked. `_queued_stream` had
    every reason to be written as a wrapper around `_semaphore_wrapped` and is deliberately not:
    it delegates with `async for` and carries the single `finally` itself.
    """

    def test_the_queued_stream_does_not_wrap_the_semaphore_wrapper(self):
        body = ast.get_source_segment(SOURCE, _function("_queued_stream")) or ""
        assert "_semaphore_wrapped(" not in body, (
            "`_queued_stream` wraps `_semaphore_wrapped`, which is two generator layers around one "
            "stream -- the shape that leaked upstream connections until an API stopped answering"
        )

    def test_it_carries_exactly_one_finally(self):
        fn = _function("_queued_stream")
        finallys = [
            node for node in ast.walk(fn)
            if isinstance(node, ast.Try) and node.finalbody
        ]
        assert len(finallys) == 1, (
            f"`_queued_stream` has {len(finallys)} `finally` blocks. One layer, one `finally`, one "
            "invariant -- a second is a second place for the release to be got wrong."
        )

    def test_it_only_releases_what_it_took(self):
        """Releasing a permit that was never acquired raises the count above the cap.

        That is a capacity leak which gets worse with every timed-out request and never announces
        itself: the pod simply starts accepting more concurrent work than it was sized for.
        """
        body = ast.get_source_segment(SOURCE, _function("_queued_stream")) or ""
        assert "if acquired_semaphore:" in body, (
            "`_queued_stream` releases unconditionally; a request that timed out in the queue "
            "never acquired the permit it would be handing back"
        )


class TestTheInterviewGradingPathIsNotFreeGpu:
    """The bypass that no endpoint-level guard can see.

    `interviews.assess_answer` reaches the generation layer directly rather than through
    `/v1/chat/completions`, and it must — `prepare_messages_hybrid` replaces the system prompt,
    which is what produced hallucinated feedback and is documented at that call site. But going
    around the endpoint went around the semaphore and the meter too, so grading ran unthrottled on
    the same card and cost nothing.

    THE NAME IS READ FROM THE IMPORT, not hardcoded. It has already changed once:
    `generate_response` is the HuggingFace path and reaches for a `tokenizer` that does not exist
    under `USE_SGLANG`, so grading 503'd on every attempt until it moved to `generate_once`.
    Pinning a literal here means the next such move makes this test pass by finding nothing,
    which is the failure mode its own comment below warns about.
    """

    INTERVIEWS = Path(__file__).resolve().parents[1] / "src" / "routers" / "interviews.py"

    @staticmethod
    def _generator_name(tree) -> str:
        """Whatever this router imports from `main` to generate with."""
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or "main" not in (node.module or ""):
                continue
            for alias in node.names:
                if alias.name.startswith("generate_"):
                    return alias.name
        raise AssertionError(
            "this router imports nothing named generate_* from main — if grading now reaches "
            "the model another way, point this test at it rather than deleting it")

    def test_the_generation_call_is_only_made_inside_a_metered_slot(self):
        source = self.INTERVIEWS.read_text(encoding="utf-8")
        tree = ast.parse(source)
        name = self._generator_name(tree)

        # Every REFERENCE, not every call. The HuggingFace form is handed to `asyncio.to_thread`
        # rather than called directly, so looking for `ast.Call` finds nothing and the test passes
        # while proving nothing — which is exactly what the first version of it did.
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Name)
            and node.id == name
            and isinstance(node.ctx, ast.Load)
        ]
        assert calls, f"{name} is no longer used here — rewrite this test, do not drop it"

        slots = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.AsyncWith)
            and "gpu_slot" in (ast.get_source_segment(source, node.items[0].context_expr) or "")
        ]
        assert slots, "the grading generation is not inside a `gpu_slot` — it is free, unthrottled GPU"

        covered = {
            call.lineno
            for slot in slots
            for call in calls
            if slot.lineno <= call.lineno <= (slot.end_lineno or slot.lineno)
        }
        # The import line is a reference too, and it is not inside the slot. Exclude the one that
        # is part of `from ..main import generate_response`.
        import_lines = {
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            and any(a.name == name for a in node.names)
        }
        uncovered = sorted({c.lineno for c in calls} - covered - import_lines)
        assert uncovered == [], (
            f"{name} used outside a metered slot at line(s) {uncovered}"
        )

    def test_it_takes_a_permit_not_only_a_meter(self):
        """The out-of-memory half of the bug, which billing being off does not excuse.

        Without the permit this runs alongside up to MAX_CONCURRENT_REQUESTS chat generations,
        outside the gate that exists to stop that exhausting VRAM on the HuggingFace path and
        overrunning the fleet-wide budget on the delegated one.
        """
        source = self.INTERVIEWS.read_text(encoding="utf-8")
        assert "_inference_semaphore" in source, (
            "grading does not take an inference permit; it can OOM the card regardless of billing"
        )
