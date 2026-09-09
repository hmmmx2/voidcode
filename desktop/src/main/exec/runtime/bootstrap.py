"""Runs inside Pyodide, before any user code.

Installs the import allowlist and the measurement harness. Loaded once per sandbox
process and reused across runs, because re-importing numpy costs ~1.7 s.

A note on what the import guard is and is not
--------------------------------------------
It is a *pedagogical* constraint, not a security boundary. The exercise says "NumPy
only"; this makes that real by default instead of leaving it as prose nobody
enforces (spec §1.5).

It is not escape-proof, and it does not need to be. The actual boundary is Pyodide
itself: WASM linear memory, no sockets, no host filesystem. A user determined to
reach `importlib.__import__` can defeat the guard and still has nowhere to go. So
the guard is written to be unambiguous and hard to trip over accidentally, not to
survive an adversary — treating it as a sandbox would be the dangerous mistake.
"""

import builtins
import io
import json
import sys
import time
import tracemalloc
import traceback

_REAL_IMPORT = builtins.__import__


def _to_py(obj):
    """Convert a value handed over from JavaScript into native Python.

    Everything crossing the Pyodide boundary arrives as a `JsProxy`: a JS array is
    not a `list`, and a JS object is not a `dict` — in particular it has no `.get`.
    Converting once, here at the entry points, keeps the rest of this file written
    against ordinary Python types instead of proxy-aware defensive code.
    """
    to_py = getattr(obj, "to_py", None)
    return to_py() if callable(to_py) else obj

# Set by install_guard(); empty means "guard not active".
_allowed: frozenset[str] = frozenset()
_guard_active = False


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if _guard_active and root not in _allowed:
        raise ImportError(
            f"This exercise allows only: {', '.join(sorted(_allowed)) or '(nothing)'}. "
            f"`import {root}` is not permitted."
        )
    return _REAL_IMPORT(name, globals, locals, fromlist, level)


builtins.__import__ = _guarded_import


def prepare(allowed: list[str], preimport: list[str]) -> None:
    """Warm the allowed packages, then arm the guard.

    Order matters and is the whole trick. numpy's own `import` statements run on
    first import and reach for dozens of private submodules and stdlib helpers. If
    the guard were armed first, numpy's internals would trip it and the exercise
    would fail on an import the user never wrote.

    So: import everything the exercise permits while the guard is disarmed, letting
    those internal imports resolve and cache in `sys.modules`. Only then arm it, so
    the guard sees only what user code asks for.
    """
    global _allowed, _guard_active

    allowed = list(_to_py(allowed) or [])
    preimport = list(_to_py(preimport) or [])

    _guard_active = False
    for module in preimport:
        try:
            _REAL_IMPORT(module)
        except ImportError:
            # A package the exercise allows but that is not present in this build.
            # Not fatal: user code importing it gets the ordinary ImportError, which
            # is the truthful error rather than a misleading "not permitted".
            pass

    # Always tolerated: user code cannot avoid these, and blocking them produces
    # confusing failures rather than teaching anything.
    _allowed = frozenset(allowed) | {"builtins", "sys", "math", "typing", "__future__"}
    _guard_active = True


def run(source: str, entry: str, cases: list[dict], normalise: str = "") -> dict:
    """Execute `source`, then call `entry` once per case.

    Returns a plain dict (Pyodide converts it to a JS object). Timing is measured
    per case around the call only, so importing numpy is not billed to the user's
    time limit — the exercise's 200 ms budget is about their algorithm, not about
    interpreter startup.

    `normalise` is an optional expression in `_r`, applied to each return value before
    comparison. It is the problem's own statement of what counts as equal — rounding,
    integer coercion, order-insensitivity — and it runs against the reference and the
    learner identically. See `ExecRequest.normalise`.
    """
    global _guard_active

    cases = list(_to_py(cases) or [])

    stdout = io.StringIO()
    real_stdout, real_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = stdout

    tracemalloc.start()
    try:
        namespace: dict = {"__name__": "__exercise__"}
        try:
            exec(compile(source, "<solution>", "exec"), namespace)
        except BaseException:
            return _failure("compile_or_import", stdout.getvalue(), tracemalloc)

        fn = namespace.get(entry)
        if not callable(fn):
            return _failure(
                "missing_entry",
                stdout.getvalue(),
                tracemalloc,
                message=f"No function named `{entry}` was defined.",
            )

        # Compiled once, outside the case loop, and in its own namespace rather than the
        # exercise's — otherwise a learner who happens to define `json` or `round` would
        # change how their own answer is compared.
        normalise_fn = None
        if normalise:
            # `json` is handed over rather than imported. The import guard is a pedagogical
            # constraint on the *learner* — "this exercise is NumPy only" — and several of
            # these expressions are `json.dumps(...)` because that is what the web driver
            # printed. Importing it here would trip a rule aimed at somebody else, which is
            # exactly what happened: every one of the 38 references failed to execute with
            # "`import json` is not permitted".
            #
            # Its own namespace, not the exercise's: a learner who defines `json` or `round`
            # must not be able to change how their own answer is compared.
            normalise_ns: dict = {"json": json}
            exec(
                compile(
                    "def _normalise_output(_r):\n    return (" + normalise + ")",
                    "<normalise>",
                    "exec",
                ),
                normalise_ns,
            )
            normalise_fn = normalise_ns["_normalise_output"]

        results = []
        for case in cases:
            case = _to_py(case)
            args = list(case.get("args") or [])
            kwargs = dict(case.get("kwargs") or {})
            started = time.perf_counter()
            try:
                value = fn(*args, **kwargs)
                # Inside the same try as the call, deliberately. A learner who returns
                # `None` where a list is expected makes this raise, and that is reported
                # as a failing case — which is exactly what the web driver did when it
                # tried to iterate the same wrong value.
                if normalise_fn is not None:
                    value = normalise_fn(value)
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                results.append(
                    {
                        "id": case.get("id"),
                        "ok": True,
                        # repr, not the object: the host compares strings, and a
                        # numpy array does not survive the JS boundary usefully.
                        "repr": _normalise(value),
                        "elapsedMs": elapsed_ms,
                    }
                )
            except BaseException as exc:
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                results.append(
                    {
                        "id": case.get("id"),
                        "ok": False,
                        "error": f"{type(exc).__name__}: {exc}",
                        "traceback": _user_traceback(),
                        "elapsedMs": elapsed_ms,
                    }
                )

        current, peak = tracemalloc.get_traced_memory()
        return {
            "outcome": "ran",
            "cases": results,
            "stdout": stdout.getvalue(),
            "pythonPeakBytes": peak,
        }
    finally:
        tracemalloc.stop()
        sys.stdout, sys.stderr = real_stdout, real_stderr
        # Disarm between runs so `prepare` can re-import for the next exercise.
        _guard_active = False


def _normalise(value) -> str:
    """A stable textual form for comparison.

    Rounds floats so a grader is not comparing the last bit of a float64. numpy
    arrays and scalars go through `.tolist()` first so `array([0.5])` and `[0.5]`
    compare equal — the exercise asks for a value, not for a particular container.
    """
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        value = tolist()
    return repr(_round(value))


def _round(v, places: int = 8):
    if isinstance(v, float):
        r = round(v, places)
        # Collapse negative zero. IEEE-754 keeps the sign through a negation, so
        # `-log(1.0)` is -0.0 while a loop that accumulates into 0.0 gives +0.0 — the same
        # correct answer with two spellings. Comparison is on the repr, so without this a
        # learner's right answer is marked wrong against a reference that merely negated
        # differently. Found by the cross-entropy "perfect prediction" case.
        return 0.0 if r == 0 else r
    if isinstance(v, (list, tuple)):
        return [_round(x, places) for x in v]
    if isinstance(v, dict):
        return {k: _round(x, places) for k, x in v.items()}
    return v


def _user_traceback() -> str:
    """Traceback with our own frames stripped.

    A learner should see their own code, not `bootstrap.run` above it.
    """
    lines = traceback.format_exc().splitlines()
    kept = [l for l in lines if "bootstrap.py" not in l and "<frozen importlib" not in l]
    return "\n".join(kept)


def _failure(outcome: str, out: str, tm, message: str | None = None) -> dict:
    current, peak = tm.get_traced_memory()
    return {
        "outcome": outcome,
        "cases": [],
        "stdout": out,
        "pythonPeakBytes": peak,
        "error": message or f"{type(sys.exc_info()[1]).__name__}: {sys.exc_info()[1]}",
        "traceback": _user_traceback(),
    }
