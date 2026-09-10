"""The guard exists and is tested. This asserts it is actually CONNECTED.

`test_withholding_gate.py` proves `src/withholding.py` works. That is worth nothing if the endpoint
never calls it, and this repo has shipped that exact shape before: a validated guard sitting behind
a duplicate schema, so the 415 never ran and every test stayed green.

TEXT SCANS, NOT IMPORTS, AND NOT BY PREFERENCE. `conftest.py` records that tests must never import
`main` -- it pulls torch at module scope. `test_gpu_metering_wiring.py` and `test_config_is_wired.py`
make the same trade for the same reason.

Every scan uses `re.findall` and asserts a COUNT, never `str.index`. `index` raises `ValueError`,
which reads as a broken test rather than a broken invariant; the precedent is
`test_judge0_auth.py`, whose message ends "update this test".
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MAIN = Path(__file__).resolve().parents[1] / "src" / "main.py"
SOURCE = MAIN.read_text(encoding="utf-8")


def found(pattern: str) -> list[str]:
    return re.findall(pattern, SOURCE)


class TestTheGuardIsReachable:
    def test_the_streaming_generator_accepts_the_protected_set(self):
        assert len(found(r"\n    protected: set\[str\] \| None = None,")) == 1, (
            "generate_stream_sglang no longer takes `protected` -- the streaming path cannot "
            "withhold anything without it")

    def test_the_streaming_call_site_passes_the_learner_s_own_functions(self):
        calls = found(r"protected=withholding\.protected_functions\(")
        assert len(calls) == 1, (
            f"expected exactly 1 wiring of protected_functions into the stream, found "
            f"{len(calls)} -- if a second serving path was added, wire it and update this count")

    def test_the_non_streaming_path_runs_the_gate_too(self):
        """The path the evaluation suite and every script uses.

        A guard covering only the browser leaves the answer reachable by anything holding a token,
        which is the same hole as the panel-framing one this project already measured.
        """
        assert len(found(r"withholding\.SolutionGate\(_protected\)")) == 1
        assert len(found(r"withholding\.completed_outside_a_fence\(")) == 1, (
            "the non-streaming path no longer checks for an UNFENCED handover, which is the one "
            "shape the streaming gate cannot see")

    def test_both_paths_count_what_they_withhold(self):
        """A guard that fires silently cannot be told apart from one that never fires.

        Zero is the number you would see if this stopped running entirely, so it has to be
        possible to watch it be non-zero.
        """
        bumps = found(r"metrics\._bump\(metrics\.solutions_withheld")
        assert len(bumps) == 2, (
            f"expected the streaming and non-streaming paths to each count a withheld solution, "
            f"found {len(bumps)}")


class TestTheOrderingThatMakesItWork:
    def test_the_gate_is_flushed_before_the_terminal_chunk(self):
        """Anything released after `finish_reason` is dropped by a strict client.

        And the end of a reply is exactly where a model that has been talked into it puts the
        function -- so a flush in the wrong place would look correct in every unit test and
        deliver the solution in production.
        """
        flush = [m.start() for m in re.finditer(r"tail = gate\.flush\(\)", SOURCE)]
        terminal = [m.start() for m in re.finditer(r"terminal_chunk = \{", SOURCE)]
        assert len(flush) == 1 and len(terminal) == 1, (
            f"expected one flush and one terminal chunk, found {len(flush)} and {len(terminal)}")
        assert flush[0] < terminal[0], (
            "the gate is flushed AFTER the terminal chunk; a withheld-then-released block would "
            "arrive after the client already saw the answer end")

    def test_the_gate_is_not_a_generator_wrapper(self):
        """The failure this file's neighbour documents at length, and must not be re-created.

        An API died silently after 20-60 requests with a discarded generator wrapper as the only
        suspect: never driven to completion, so its `finally` never ran and the upstream SGLang
        stream leaked. The guard therefore filters INSIDE `generate_stream_sglang`, where the
        frames are already built, adding no layer and no second `finally`.
        """
        assert len(found(r"async def _gated_stream|def _wrap_gate|async for .* in stream_gate")) == 0, (
            "something now wraps the token stream in another generator; see the comment in "
            "`_stream_for` for what that cost last time")


class TestItDefaultsOn:
    def test_the_shipped_default_is_on(self):
        """Read from the source, not from the running config.

        A test that reads `config.WITHHOLD_SOLUTIONS` passes or fails according to whatever is in
        the developer's `.env`, which this project has already been bitten by: arming a flag
        locally broke the tests asserting the shipped default. The question here is what the
        REPOSITORY ships, so the repository is what gets read.
        """
        config_source = (MAIN.parent / "config.py").read_text(encoding="utf-8")
        declarations = re.findall(
            r'WITHHOLD_SOLUTIONS = _flag\("WITHHOLD_SOLUTIONS", default=(\w+)\)', config_source)
        assert declarations == ["True"], (
            f"WITHHOLD_SOLUTIONS ships as {declarations} -- it is the only mechanism that can "
            "promise the tutor withholds the answer, and the prompts were measured to be "
            "insufficient on their own")

    @pytest.mark.parametrize("template", [".env.example", ".env.docker.example"])
    def test_the_templates_do_not_quietly_turn_it_off(self, template: str):
        text = (MAIN.parents[1] / template).read_text(encoding="utf-8")
        values = re.findall(r"^WITHHOLD_SOLUTIONS=(\S*)$", text, re.MULTILINE)
        assert values == ["true"], f"{template} sets WITHHOLD_SOLUTIONS to {values}"
