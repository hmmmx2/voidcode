"""Wrapping an async generator breaks the finalization chain unless the wrapper forwards `aclose()`.

THIS COST THREE DEAD API PROCESSES AND TWO GPU ARMS.

The two-stage diagnosis was briefly delivered by prepending a frame, which meant:

    StreamingResponse(_semaphore_wrapped(_with_diagnosis(inner=generate_stream_sglang(...))))

A client that stops reading at `[DONE]` — which is exactly what the harness does, and what any
browser tab does on navigate — causes Starlette to `aclose()` only the OUTERMOST generator.
`_semaphore_wrapped` has a `finally`, so the semaphore looked fine and cleared itself of suspicion.
But `_with_diagnosis` had no `try/finally`, so `inner.aclose()` was never called and
`generate_stream_sglang`'s cleanup was deferred to async-generator GC.

Each two-stage request then leaked one unclosed SGLang stream. The API died after 23, 38 and 62
requests with **no traceback and no clean shutdown**, because nothing raised — a resource ceiling
was reached outside Python's exception path. Measured after removing the wrapper: 543 requests
served clean.

So the invariant is not "don't use this one wrapper". It is: **every layer between Starlette and the
generator that owns an HTTP connection must forward close.** These tests state that in a form that
fails if someone reintroduces a layer.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "apps" / "api" / "src" / "main.py").read_text(encoding="utf-8")


def test_no_streaming_response_nests_a_generator_inside_the_semaphore_wrapper():
    """`_semaphore_wrapped(<call>)` must receive a generator that OWNS the stream, not one wrapping
    another. One extra layer is all it took.
    """
    # `(?<!def )` so the function's OWN definition -- `async def _semaphore_wrapped(gen: ...)` --
    # is not read as a call site handing it something called `gen`.
    nested = re.findall(r"(?<!def )_semaphore_wrapped\(\s*(\w+)", MAIN)
    allowed = {"generate_stream_sglang", "generate_stream_vllm", "generate_stream"}
    unexpected = [n for n in nested if n not in allowed]
    assert not unexpected, (
        f"_semaphore_wrapped is being handed {unexpected}, which is not a known stream-owning "
        "generator. If that is a wrapper, it must forward aclose() in a try/finally — see this "
        "module's docstring for what happens when it does not."
    )


def test_no_locally_defined_async_generator_in_the_request_handler():
    """The wrapper was an `async def` nested inside the endpoint. Defining one there is the shape of
    the bug, because it is where the temptation to 'just prepend a frame' arises."""
    handler = MAIN[MAIN.index("async def chat_completions"):] if "async def chat_completions" in MAIN else MAIN
    inner_defs = re.findall(r"\n {8,}async def (\w+)\s*\(", handler)
    assert not inner_defs, (
        f"async generator(s) {inner_defs} defined inside the request handler. If one is genuinely "
        "needed, it must wrap the inner generator in try/finally and await inner.aclose()."
    )


def test_a_wrapper_without_aclose_leaks_and_one_with_it_does_not():
    """The bug and its fix, side by side, so the rule is demonstrated rather than only prohibited.

    Plain `asyncio.run` rather than an anyio plugin: this needs no event-loop fixtures and no extra
    dependency, and a test guarding against resource leaks should not add one.
    """
    import asyncio

    async def scenario(forward_close: bool) -> bool:
        closed = {"inner": False}

        async def inner():
            try:
                yield "a"
                yield "b"
            finally:
                closed["inner"] = True

        async def wrapper(gen):
            if forward_close:
                try:
                    yield "header"
                    async for item in gen:
                        yield item
                finally:
                    await gen.aclose()      # THE LINE THE BROKEN WRAPPER LACKED
            else:
                yield "header"
                async for item in gen:
                    yield item

        g = inner()
        w = wrapper(g)
        assert await w.__anext__() == "header"
        # Advance INTO the inner generator before disconnecting. A generator that never started has
        # no suspended frame, so `aclose()` on it runs no `finally` and the scenario would prove
        # nothing -- which is exactly the shape of the real path, where the client reads at least
        # one content frame before stopping.
        assert await w.__anext__() == "a"
        await w.aclose()                    # the client stops reading early
        return closed["inner"]

    assert asyncio.run(scenario(forward_close=True)) is True, (
        "a wrapper that forwards aclose must finalise the generator that owns the connection")
    assert asyncio.run(scenario(forward_close=False)) is False, (
        "REGRESSION GUARD IS DEAD: the un-forwarding wrapper now cleans up on its own, so this "
        "test no longer demonstrates the leak it exists to describe")
