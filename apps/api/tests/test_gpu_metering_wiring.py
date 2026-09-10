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
    def test_metering_begins_after_acquire_not_before(self):
        """A request must never pay for the time it spent waiting for a slot.

        Queue wait is a throughput problem. If `begin` moved above `acquire`, a busy pod would start
        charging learners for its own contention, and the number would still look plausible.
        """
        endpoint = _function("create_chat_completion")
        body = ast.get_source_segment(SOURCE, endpoint) or ""
        acquire = _sole_offset(
            body, r"_inference_semaphore\.acquire\(\)", "the semaphore acquire"
        )
        begin = _sole_offset(body, r"_begin_metering\(", "the metering start")
        assert acquire < begin, (
            "metering starts before the semaphore is acquired, so queue wait would be billed"
        )


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
    def test_anonymous_and_unverified_are_both_refused_when_enforcing(self):
        """`verified` alone is not a sufficient gate, and that is the subtle part.

        `resolve_caller` returns `Caller(ANONYMOUS_USER_ID, verified=True)` for a missing or
        malformed header — anonymous is "verified" because there is no id to forge. A gate checking
        only `verified` would pass every unauthenticated visitor.
        """
        gate = _function("_begin_metering")
        body = ast.get_source_segment(SOURCE, gate) or ""
        assert "is_anonymous" in body, "the gate does not exclude the shared anonymous identity"
        assert "caller.verified" in body, "the gate does not require a signed identity"

    def test_the_endpoint_actually_resolves_a_caller(self):
        endpoint = _function("create_chat_completion")
        args = [a.arg for a in endpoint.args.args]
        assert "caller" in args, (
            "the metered endpoint takes no identity, so every request would be charged to nobody"
        )


class TestRefusalsHappenBeforeTheGpuIsTouched:
    @pytest.mark.parametrize("marker", ["ratelimit.check_ip", "_begin_metering("])
    def test_the_refusal_precedes_generation(self, marker: str):
        """402 and 429 must both land before a permit is spent and before any generation starts."""
        endpoint = _function("create_chat_completion")
        body = ast.get_source_segment(SOURCE, endpoint) or ""
        refusal = _sole_offset(body, re.escape(marker), f"the {marker} guard")
        generation = _sole_offset(body, r"prepare_messages_hybrid\(", "the prompt build")
        assert refusal < generation, (
            f"{marker} runs after generation starts, so a refused request has already spent GPU"
        )


class TestTheInterviewGradingPathIsNotFreeGpu:
    """The bypass that no endpoint-level guard can see.

    `interviews.assess_answer` reaches `generate_response` directly rather than through
    `/v1/chat/completions`, and it must — `prepare_messages_hybrid` replaces the system prompt,
    which is what produced hallucinated feedback and is documented at that call site. But going
    around the endpoint went around the semaphore and the meter too, so grading ran unthrottled on
    the same card and cost nothing.
    """

    INTERVIEWS = Path(__file__).resolve().parents[1] / "src" / "routers" / "interviews.py"

    def test_generate_response_is_only_called_inside_a_metered_slot(self):
        source = self.INTERVIEWS.read_text(encoding="utf-8")
        tree = ast.parse(source)

        # Every REFERENCE, not every call. `generate_response` is handed to `asyncio.to_thread`
        # rather than called directly, so looking for `ast.Call` finds nothing and the test passes
        # while proving nothing — which is exactly what the first version of it did.
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Name)
            and node.id == "generate_response"
            and isinstance(node.ctx, ast.Load)
        ]
        assert calls, "generate_response is no longer used here — rewrite this test, do not drop it"

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
            and any(a.name == "generate_response" for a in node.names)
        }
        uncovered = sorted({c.lineno for c in calls} - covered - import_lines)
        assert uncovered == [], (
            f"generate_response used outside a metered slot at line(s) {uncovered}"
        )

    def test_it_takes_a_permit_not_only_a_meter(self):
        """The out-of-memory half of the bug, which billing being off does not excuse.

        Without the permit this runs `model.generate()` alongside up to MAX_CONCURRENT_REQUESTS
        chat generations, outside the gate that exists to stop that exhausting VRAM.
        """
        source = self.INTERVIEWS.read_text(encoding="utf-8")
        assert "_inference_semaphore" in source, (
            "grading does not take an inference permit; it can OOM the card regardless of billing"
        )
