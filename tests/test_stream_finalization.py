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

---

**Why this guard resolves the argument instead of reading its name.** It used to match the *name*
handed to `_semaphore_wrapped` against an allow-list. That broke the moment the backend branching
moved into a helper:

    inner, stream_headers = _stream_for(request, request_id, prepared)
    StreamingResponse(_semaphore_wrapped(inner, meter, slot_lease), ...)

`inner` is a local, so the allow-list rejected it and the guard failed on correct code. Worse in the
other direction: had `_stream_for` started returning a wrapper, the name at the call site would
still have read `inner` and the guard would have passed a genuine leak. A name is not a layer count.

So the check now follows the argument back through locals, tuple unpacking and helper returns until
it reaches the calls that actually own a stream, and it **fails closed**: an argument it cannot
resolve is reported, never assumed safe. Unknown is the state the original bug lived in.
"""
import ast
import re
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
MAIN_PATH = ROOT / "apps" / "api" / "src" / "main.py"
MAIN = MAIN_PATH.read_text(encoding="utf-8")

WRAPPER = "_semaphore_wrapped"

# The generators that own an upstream stream and carry their own `finally`. Anything else reaching
# the wrapper is a layer, and a layer is the bug.
STREAM_OWNERS = frozenset({"generate_stream_sglang", "generate_stream_vllm", "generate_stream"})


class Resolution(NamedTuple):
    """What the first argument of one `_semaphore_wrapped(...)` call turned out to be."""

    line: int
    origins: frozenset          # the stream-owning calls it reduces to
    problem: str | None         # set when resolution failed; failing closed means this is a defect

    def describe(self) -> str:
        if self.problem:
            return f"line {self.line}: {self.problem}"
        return f"line {self.line}: {sorted(self.origins)}"


def _own_nodes(node: ast.AST):
    """Walk `node`'s subtree without descending into nested function or lambda bodies.

    A `return` inside a closure belongs to the closure, not to the function being resolved, and
    counting it would attribute the wrong value to a helper.
    """
    stack = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        yield current
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        stack.extend(ast.iter_child_nodes(current))


def _is_generator(fn: ast.AST) -> bool:
    return any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in _own_nodes(fn))


class _Resolver:
    """Reduce an expression to the set of stream-owning generator calls it can evaluate to."""

    def __init__(self, tree: ast.Module):
        self.functions: dict[str, ast.AST] = {
            node.name: node for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.parents: dict[ast.AST, ast.AST] = {}
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                self.parents[child] = parent

    def enclosing_function(self, node: ast.AST) -> ast.AST | None:
        current = self.parents.get(node)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return current
            current = self.parents.get(current)
        return None

    def resolve(self, expr: ast.AST, index: int | None, scope: ast.AST | None,
                seen: frozenset = frozenset()) -> tuple[frozenset, list[str]]:
        """Return (origins, problems).

        `index` selects an element of a tuple-valued expression, for `a, b = helper()`.
        `seen` breaks recursion on mutually-referential helpers rather than overflowing the stack.
        """
        if isinstance(expr, ast.Await):
            return self.resolve(expr.value, index, scope, seen)

        if isinstance(expr, ast.Tuple):
            if index is None:
                return frozenset(), [f"a tuple is not a generator (line {expr.lineno})"]
            if index >= len(expr.elts):
                return frozenset(), [f"tuple has no element {index} (line {expr.lineno})"]
            return self.resolve(expr.elts[index], None, scope, seen)

        if isinstance(expr, ast.Call):
            return self._resolve_call(expr, index, seen)

        if isinstance(expr, ast.Name):
            return self._resolve_name(expr, index, scope, seen)

        return frozenset(), [
            f"cannot resolve a {type(expr).__name__} (line {getattr(expr, 'lineno', '?')}); "
            f"failing closed rather than assuming it owns its stream"]

    def _resolve_call(self, call: ast.Call, index: int | None,
                      seen: frozenset) -> tuple[frozenset, list[str]]:
        name = call.func.id if isinstance(call.func, ast.Name) else None
        if name is None:
            return frozenset(), [
                f"call to a non-simple callable at line {call.lineno}, cannot resolve"]

        if name in STREAM_OWNERS:
            if index is not None:
                return frozenset(), [
                    f"{name}() at line {call.lineno} is a generator, not a tuple to index"]
            return frozenset({name}), []

        if name in seen:
            return frozenset(), [f"recursive resolution through {name}() at line {call.lineno}"]

        fn = self.functions.get(name)
        if fn is None:
            return frozenset(), [
                f"{name}() at line {call.lineno} is not defined in this module and is not a known "
                f"stream owner, so whether it forwards aclose() cannot be established here"]

        if _is_generator(fn):
            return frozenset(), [
                f"{name}() at line {call.lineno} is itself a generator (defined line {fn.lineno}) "
                f"and is not a known stream owner — that is an extra layer between Starlette "
                f"and the stream, which is exactly the shape that leaked"]

        returns = [node for node in _own_nodes(fn) if isinstance(node, ast.Return) and node.value]
        if not returns:
            return frozenset(), [
                f"{name}() at line {call.lineno} returns nothing resolvable (defined line "
                f"{fn.lineno})"]

        origins: frozenset = frozenset()
        problems: list[str] = []
        for node in returns:
            found, trouble = self.resolve(node.value, index, fn, seen | {name})
            origins |= found
            problems += trouble
        return origins, problems

    def _resolve_name(self, name: ast.Name, index: int | None, scope: ast.AST | None,
                      seen: frozenset) -> tuple[frozenset, list[str]]:
        if scope is None:
            return frozenset(), [f"`{name.id}` at line {name.lineno} has no enclosing function"]

        bindings: list[tuple[ast.AST, int | None]] = []
        for node in _own_nodes(scope):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name.id:
                    bindings.append((node.value, index))
                elif isinstance(target, (ast.Tuple, ast.List)):
                    for position, element in enumerate(target.elts):
                        if isinstance(element, ast.Name) and element.id == name.id:
                            # `inner, headers = _stream_for(...)` -- take element 0 of the return.
                            bindings.append((node.value, position))

        if not bindings:
            return frozenset(), [
                f"`{name.id}` at line {name.lineno} is not assigned in "
                f"{getattr(scope, 'name', '?')}(); it may be a parameter or a global, so whether "
                f"it owns its stream cannot be established here"]

        origins: frozenset = frozenset()
        problems: list[str] = []
        for value, position in bindings:
            found, trouble = self.resolve(value, position, scope, seen)
            origins |= found
            problems += trouble
        return origins, problems


def semaphore_wrapped_arguments(source: str) -> list[Resolution]:
    """Every `_semaphore_wrapped(...)` call site, with its first argument resolved."""
    tree = ast.parse(source)
    resolver = _Resolver(tree)
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == WRAPPER):
            continue
        if not node.args:
            out.append(Resolution(node.lineno, frozenset(),
                                  f"{WRAPPER}() called with no positional generator"))
            continue
        first = node.args[0]
        if isinstance(first, ast.Starred):
            out.append(Resolution(node.lineno, frozenset(),
                                  "generator passed via *args, cannot resolve"))
            continue
        scope = resolver.enclosing_function(node)
        origins, problems = resolver.resolve(first, None, scope)
        out.append(Resolution(node.lineno, origins,
                              "; ".join(problems) if problems else None))
    return out


class TestTheWrapperOnlyEverReceivesAStreamOwner:
    """The invariant, resolved rather than pattern-matched."""

    def test_every_call_site_resolves_to_a_stream_owning_generator(self):
        found = semaphore_wrapped_arguments(MAIN)
        assert found, (
            f"no {WRAPPER}() call sites found in main.py — the detector has stopped working, "
            f"or the wrapper was renamed and this guard now protects nothing")

        broken = [r for r in found if r.problem or not r.origins
                  or not r.origins <= STREAM_OWNERS]
        assert not broken, (
            f"{WRAPPER} is handed something that is not a known stream-owning generator. If a "
            f"layer was added it must forward aclose() in a try/finally — see this module's "
            f"docstring for what happens when it does not.\n  "
            + "\n  ".join(r.describe() for r in broken))

    def test_it_resolves_through_the_helper_rather_than_reading_the_local_name(self):
        """The regression that motivated the rewrite.

        The argument at the call site is a local called `inner`. A name-based check either rejects
        it (a false failure on correct code) or accepts it blindly (a false pass once the helper
        changes). Resolution must reach past both.
        """
        found = semaphore_wrapped_arguments(MAIN)
        origins = frozenset().union(*(r.origins for r in found))
        assert "inner" not in origins, "resolution stopped at the local name"
        assert origins, "resolved to nothing"
        assert origins <= STREAM_OWNERS
        # `_stream_for` branches on backend, so all three arms should be reachable.
        assert len(origins) >= 2, (
            f"only {sorted(origins)} reachable; the backend branches are not all being followed")


# Synthetic sources for the mutants. Each is the smallest program with the shape in question, so a
# failure names the shape rather than a line of main.py.
_PASSTHROUGH_HELPER = '''
async def generate_stream_sglang(**kw):
    yield "x"

def _stream_for(request):
    return generate_stream_sglang(), {}

async def _semaphore_wrapped(gen, meter):
    try:
        async for item in gen:
            yield item
    finally:
        await gen.aclose()

async def endpoint(request):
    inner, headers = _stream_for(request)
    return StreamingResponse(_semaphore_wrapped(inner, None), headers=headers)
'''

_WRAPPER_AT_THE_CALL_SITE = '''
async def generate_stream_sglang(**kw):
    yield "x"

async def _with_diagnosis(inner):
    yield "header"
    async for item in inner:
        yield item

async def _semaphore_wrapped(gen, meter):
    try:
        async for item in gen:
            yield item
    finally:
        await gen.aclose()

async def endpoint(request):
    return StreamingResponse(
        _semaphore_wrapped(_with_diagnosis(generate_stream_sglang()), None))
'''

_WRAPPER_HIDDEN_IN_THE_HELPER = '''
async def generate_stream_sglang(**kw):
    yield "x"

async def _with_diagnosis(inner):
    yield "header"
    async for item in inner:
        yield item

def _stream_for(request):
    return _with_diagnosis(generate_stream_sglang()), {}

async def _semaphore_wrapped(gen, meter):
    try:
        async for item in gen:
            yield item
    finally:
        await gen.aclose()

async def endpoint(request):
    inner, headers = _stream_for(request)
    return StreamingResponse(_semaphore_wrapped(inner, None), headers=headers)
'''

_UNKNOWN_ORIGIN = '''
async def _semaphore_wrapped(gen, meter):
    try:
        async for item in gen:
            yield item
    finally:
        await gen.aclose()

async def endpoint(request, gen_from_somewhere_else):
    return StreamingResponse(_semaphore_wrapped(gen_from_somewhere_else, None))
'''


def _verdict(source: str) -> list[Resolution]:
    return [r for r in semaphore_wrapped_arguments(source)
            if r.problem or not r.origins or not r.origins <= STREAM_OWNERS]


class TestTheResolverIsAliveInBothDirections:
    """A guard that only ever passes is indistinguishable from no guard. These are the mutants."""

    def test_a_passthrough_helper_is_accepted(self):
        """The real shape. A helper that returns the owning generator adds no layer, and a guard
        that rejected it would be the false failure this rewrite removes."""
        assert not _verdict(_PASSTHROUGH_HELPER), "correct code was rejected"

    def test_a_wrapper_at_the_call_site_is_caught(self):
        """The historical bug, verbatim in shape."""
        broken = _verdict(_WRAPPER_AT_THE_CALL_SITE)
        assert broken, "the original leaking shape was not caught"
        assert "_with_diagnosis" in broken[0].problem
        assert "extra layer" in broken[0].problem

    def test_a_wrapper_hidden_inside_the_helper_is_caught(self):
        """The case the name-based check could never see.

        The call site still reads `_semaphore_wrapped(inner, ...)` -- identical to correct code --
        and the layer is one level down, inside what the helper returns. This is the false pass the
        old guard would have given a real leak.
        """
        broken = _verdict(_WRAPPER_HIDDEN_IN_THE_HELPER)
        assert broken, (
            "a wrapper returned by the helper was not caught, so this guard would pass the leak "
            "it exists to prevent")
        assert "_with_diagnosis" in broken[0].problem

    def test_an_unresolvable_argument_fails_closed(self):
        """Unknown must not read as safe: unknown is where the original bug lived."""
        broken = _verdict(_UNKNOWN_ORIGIN)
        assert broken, "an argument of unknown origin was treated as safe"
        assert "cannot be established" in broken[0].problem

    def test_nothing_resolved_would_make_the_allow_list_check_vacuous(self):
        """`origins <= STREAM_OWNERS` is trivially true for an empty set, so the real check is that
        resolution produced something. Stated separately so it cannot rot into a tautology."""
        found = semaphore_wrapped_arguments(MAIN)
        origins = frozenset().union(*(r.origins for r in found))
        assert origins, "nothing resolved, so the allow-list check is vacuous"


class TestTheMutantsAreAppliedToMainItselfNotOnlyToSyntheticSources:
    """The synthetic mutants above prove the resolver reasons correctly. These prove it reasons
    correctly *about this file* -- a resolver can be sound and still be pointed at the wrong node.

    Both mutate `MAIN` in memory. Nothing is written.
    """

    ANCHOR = "_semaphore_wrapped(inner, meter, slot_lease)"

    def test_the_anchor_these_mutants_rely_on_still_exists(self):
        assert MAIN.count(self.ANCHOR) == 1, (
            f"the call site {self.ANCHOR!r} has moved, so the two mutants below are mutating "
            f"nothing and prove nothing")

    def test_an_extra_layer_in_the_real_call_site_is_caught(self):
        """Nest the wrapper inside itself -- a genuine second layer, built only from code already
        in main.py, so the mutant compiles and needs no invented helper."""
        mutated = MAIN.replace(
            self.ANCHOR,
            "_semaphore_wrapped(_semaphore_wrapped(inner, meter, slot_lease), meter, slot_lease)",
            1)
        broken = _verdict(mutated)
        assert broken, "an extra wrapper layer at the real call site was not caught"
        assert "extra layer" in broken[0].problem

    def test_an_unresolvable_argument_at_the_real_call_site_is_caught(self):
        mutated = MAIN.replace(
            self.ANCHOR, "_semaphore_wrapped(some_other_generator, meter, slot_lease)", 1)
        broken = _verdict(mutated)
        assert broken, "an argument of unknown origin at the real call site was treated as safe"
        assert "cannot be established" in broken[0].problem


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
