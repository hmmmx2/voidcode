"""Where the backend is, and whether it is answering.

THE BUG THIS FILE WAS WRITTEN FOR IS `test_a_dead_backend_is_not_ready`.

`main.py` decided readiness with `_sglang_client is not None` -- a statement about whether a Python
object was constructed during startup, not about whether anything is listening. Point the
configuration at a dead address and `/health` reported `model_loaded: true`: to a Kubernetes
readiness probe, to a load balancer, and to whoever was trying to work out why every request failed.

A health endpoint that cannot report ill-health is worse than not having one, because everything
downstream is built on trusting it.

No network is touched here. `httpx.MockTransport` answers the probe, which is what lets a test
assert "the probe was made exactly once" -- a claim that is the whole point of the cache and that
a real backend could not be made to prove.
"""

from typing import ClassVar

import httpx
import pytest
from src.services import backend_registry as registry

pytestmark = pytest.mark.asyncio


class _Recorder:
    """A fake backend that counts requests, so caching can be asserted rather than assumed."""

    def __init__(self, status_code: int = 200, boom: bool = False, body: dict | None = None):
        self.status_code = status_code
        self.boom = boom
        #: What `/models` answers. Defaults to an empty list so every existing test is
        #: unaffected; the model-reporting tests supply a real OpenAI-shaped body.
        self.body = body if body is not None else {"object": "list", "data": []}
        self.calls: list[str] = []

    def factory(self, base_url: str):
        def handle(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            if self.boom:
                raise httpx.ConnectError("refused", request=request)
            return httpx.Response(self.status_code, json=self.body)

        return httpx.MockTransport(handle)


@pytest.fixture(autouse=True)
def clean_registry(monkeypatch):
    """The registry is a module-level singleton on purpose; tests must not inherit each other."""
    registry.reset_for_tests()
    yield
    registry.reset_for_tests()


def _install(monkeypatch, recorder: _Recorder) -> None:
    """Make the registry's probe talk to the recorder instead of the network."""
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = recorder.factory("")
        return real_client(*args, **kwargs)

    monkeypatch.setattr(registry.httpx, "AsyncClient", fake_client)


class TestReadiness:
    async def test_a_live_backend_is_ready(self, monkeypatch):
        rec = _Recorder(status_code=200)
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())

        assert await registry.probe() == registry.READY
        assert rec.calls == ["http://backend:30000/v1/models"]

    async def test_a_dead_backend_is_not_ready(self, monkeypatch):
        """THE ONE THAT MATTERS. This returned True before, against a backend that was not there."""
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://gone:30000/v1", lambda url: object())

        assert await registry.probe() == registry.DOWN

    async def test_a_backend_answering_with_an_error_is_not_ready(self, monkeypatch):
        """Listening is not the same as serving. A 503 from the backend is still not ready."""
        rec = _Recorder(status_code=503)
        _install(monkeypatch, rec)
        registry.configure("http://sick:30000/v1", lambda url: object())

        assert await registry.probe() == registry.DOWN

    async def test_nothing_configured_is_down_rather_than_an_exception(self):
        """A probe must never raise: it is what reports trouble, so it cannot be a source of it."""
        assert await registry.probe() == registry.DOWN

    async def test_it_probes_models_not_health(self, monkeypatch):
        """`/health` is SGLang-only and Ollama 404s it, which would report a live backend as dead.

        `main.py`'s startup poll made this choice already and explains why; asserting it here stops
        a future tidy-up from "fixing" the URL to the more obvious one.
        """
        rec = _Recorder()
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()
        assert rec.calls[0].endswith("/models")


class TestTheCache:
    async def test_repeated_checks_make_one_request(self, monkeypatch):
        """A readiness probe runs on a timer, per replica. Uncached, it is load applied to the
        thing being asked whether it is overloaded."""
        rec = _Recorder()
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())

        for tick in range(5):
            assert await registry.probe(now=100.0 + tick * 0.5) == registry.READY
        assert len(rec.calls) == 1, f"{len(rec.calls)} requests for five checks inside the TTL"

    async def test_the_cache_expires(self, monkeypatch):
        rec = _Recorder()
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())

        await registry.probe(now=100.0)
        await registry.probe(now=100.0 + registry.PROBE_TTL_SECONDS + 0.1)
        assert len(rec.calls) == 2

    async def test_a_backend_that_dies_is_noticed_within_the_ttl(self, monkeypatch):
        rec = _Recorder()
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())
        assert await registry.probe(now=100.0) == registry.READY

        rec.boom = True
        assert await registry.probe(now=100.0 + registry.PROBE_TTL_SECONDS + 0.1) == registry.DOWN


class TestTheAddressCanChange:
    async def test_a_new_address_builds_a_new_client(self):
        built = []
        registry.configure("http://one:30000/v1", lambda url: built.append(url) or f"client:{url}")
        first = registry.current_client()
        registry.configure("http://two:30000/v1", lambda url: built.append(url) or f"client:{url}")

        assert registry.current_client() != first
        assert registry.base_url() == "http://two:30000/v1"
        assert built == ["http://one:30000/v1", "http://two:30000/v1"]

    async def test_the_same_address_does_not_rebuild(self):
        """Rebuilding discards a live connection pool. Harmless-looking; shows up as latency."""
        built = []
        for _ in range(3):
            registry.configure(
                "http://one:30000/v1", lambda url: built.append(url) or f"client:{url}"
            )
        assert built == ["http://one:30000/v1"]

    async def test_a_new_address_is_not_assumed_ready(self, monkeypatch):
        """The stale-cache trap: a fresh address inheriting the old one's verdict.

        Without clearing the probe timestamp, moving to a dead backend would keep reporting READY
        for the rest of the TTL -- which is the same lie in a new place.
        """
        rec = _Recorder()
        _install(monkeypatch, rec)
        registry.configure("http://one:30000/v1", lambda url: object())
        assert await registry.probe(now=100.0) == registry.READY

        rec.boom = True
        registry.configure("http://two:30000/v1", lambda url: object())
        assert await registry.probe(now=100.1) == registry.DOWN, (
            "a new address inherited the previous address's readiness"
        )


class TestWakingIsNotDown:
    async def test_an_expected_restart_reads_as_waking(self, monkeypatch):
        """"Deliberately down and coming back" and "down" look identical from outside.

        They call for opposite reactions -- one is a wait, the other is a page -- so the difference
        has to be recorded by whoever knows it, which is whatever stopped the backend.
        """
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://restarting:30000/v1", lambda url: object())
        registry.expect_restart(True)

        assert await registry.probe() == registry.WAKING

    async def test_it_goes_ready_once_the_backend_answers(self, monkeypatch):
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://restarting:30000/v1", lambda url: object())
        registry.expect_restart(True)
        assert await registry.probe(now=100.0) == registry.WAKING

        rec.boom = False
        assert await registry.probe(now=200.0) == registry.READY

    async def test_clearing_the_expectation_makes_it_down_again(self, monkeypatch):
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://gone:30000/v1", lambda url: object())
        registry.expect_restart(True)
        assert await registry.probe(now=100.0) == registry.WAKING

        registry.expect_restart(False)
        assert await registry.probe(now=200.0) == registry.DOWN


class TestTheEndpointWasWiredUp:
    """Source-scanned, because `main.py` cannot be imported here -- it pulls torch at module scope,
    which is the rule `conftest.py` states.

    SCANNED AS AST, NOT AS TEXT, AND THAT IS NOT fussiness. The first version of this test grepped
    for the banned expression and failed immediately -- on the docstring in `main.py` that explains
    why the expression is banned. A codebase that documents its own traps will always contain the
    strings a text scan forbids, so the scan has to see code.
    """

    @staticmethod
    def _main_ast():
        import ast
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(
            encoding="utf-8"
        )
        return ast.parse(source), source

    def test_readiness_asks_the_backend_instead_of_checking_for_an_object(self):
        import ast

        tree, source = self._main_ast()
        fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and n.name == "_is_model_ready"
        )
        assert isinstance(fn, ast.AsyncFunctionDef), (
            "_is_model_ready is synchronous again, so it cannot be asking the backend anything"
        )

        # Compare against the CODE, with the docstring dropped -- see the class docstring.
        body = list(fn.body)
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
            body = body[1:]
        code = "\n".join(ast.get_source_segment(source, node) or "" for node in body)

        assert "_sglang_client" not in code, (
            "readiness is back to asking whether a Python object exists, which is true against a "
            "backend that is not there"
        )
        assert "backend_registry.probe(" in code

    def test_health_awaits_the_probe_and_reports_the_state(self):
        import re

        _, source = self._main_ast()
        assert re.search(r'"model_loaded":\s*await _is_model_ready\(\)', source), (
            "/health no longer awaits the readiness probe"
        )
        assert '"backendState"' in source


class TestWhichModelIsActuallyServing:
    """`/health` reported a model that was not loaded, and nothing could tell from outside.

    Observed 2026-09-10: the endpoint said `Qwen/Qwen2.5-7B-Instruct` — the in-process
    HuggingFace default — while a 30B answered every request. `BASE_MODEL_ID` is accurate on
    the HF path and meaningless when inference is delegated, and one field was being used for
    both. The answer was already inside the liveness probe's own response.
    """

    TWO_MODELS: ClassVar[dict] = {"object": "list", "data": [
        {"id": "base", "root": "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"},
        {"id": "rl", "root": "/workspace/policy-30b-seed1", "parent": "base"},
    ]}

    async def test_it_resolves_the_configured_alias_to_the_real_model(self, monkeypatch):
        """A served alias is a label. Two aliases routinely point at different weights."""
        _install(monkeypatch, _Recorder(body=self.TWO_MODELS))
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()

        assert registry.served_model("rl") == "/workspace/policy-30b-seed1"
        assert registry.served_model("base") == "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"

    async def test_an_unknown_alias_gets_no_answer_rather_than_a_guess(self, monkeypatch):
        """None, not the first entry.

        A health endpoint that invents a plausible answer is the exact failure this module
        exists to fix. Naming no model is better than naming the wrong one.
        """
        _install(monkeypatch, _Recorder(body=self.TWO_MODELS))
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()

        assert registry.served_model("default") is None
        assert registry.served_model("") is None

    async def test_a_single_served_model_needs_no_alias(self, monkeypatch):
        """The ordinary deployment: one model, and no ambiguity to resolve."""
        body = {"object": "list", "data": [{"id": "default", "root": "Qwen/Qwen3-30B"}]}
        _install(monkeypatch, _Recorder(body=body))
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()

        assert registry.served_model("") == "Qwen/Qwen3-30B"

    async def test_an_entry_without_a_root_falls_back_to_its_id(self, monkeypatch):
        """A name is better than nothing; dropping the entry would report None for a live model."""
        body = {"object": "list", "data": [{"id": "llama3"}]}
        _install(monkeypatch, _Recorder(body=body))
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()

        assert registry.served_model("llama3") == "llama3"

    async def test_a_dead_backend_reports_no_model(self, monkeypatch):
        """THE ONE THAT MATTERS, and the reason the last-known value is not kept.

        A backend we cannot reach is one whose model we do not know. Repeating what it said
        before it died is precisely the stale-but-plausible answer that made this bug invisible
        for as long as it was.
        """
        rec = _Recorder(body=self.TWO_MODELS)
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()
        assert registry.served_model("rl") is not None

        rec.boom = True
        registry._state.probed_at = 0.0  # expire the cache rather than sleeping
        assert await registry.probe() == registry.DOWN
        assert registry.served_model("rl") is None

    async def test_a_backend_answering_with_nonsense_does_not_raise(self, monkeypatch):
        """A probe is what reports trouble, so it cannot become a source of it."""
        _install(monkeypatch, _Recorder(body={"unexpected": "shape"}))
        registry.configure("http://backend:30000/v1", lambda url: object())

        assert await registry.probe() == registry.READY
        assert registry.served_model("rl") is None

    async def test_it_costs_no_extra_request(self, monkeypatch):
        """The model list rides along on the liveness probe already being made."""
        rec = _Recorder(body=self.TWO_MODELS)
        _install(monkeypatch, rec)
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()
        registry.served_model("rl")
        registry.served_model("base")

        assert len(rec.calls) == 1, f"expected one request, made {len(rec.calls)}"


class TestChoosingTheModelAlias:
    """`SGLANG_MODEL_NAME` shipped as "default", which no backend here answers to.

    An unconfigured deployment logged six warmup warnings, then "warmup complete — all mode
    prefixes cached", then 404'd every request with "The model `default` does not exist". Three
    chances to say something useful and none of them taken. The decision now happens once, at
    startup, out loud — and lives here rather than in the lifespan so it can be tested without a
    server.
    """

    async def _probe_with(self, monkeypatch, aliases):
        body = {"object": "list", "data": [{"id": a, "root": f"/w/{a}"} for a in aliases]}
        _install(monkeypatch, _Recorder(body=body))
        registry.configure("http://backend:30000/v1", lambda url: object())
        await registry.probe()

    async def test_a_configured_alias_that_is_served_is_used_silently(self, monkeypatch):
        await self._probe_with(monkeypatch, ["base", "rl"])
        name, level, _ = registry.choose_model("rl")
        assert (name, level) == ("rl", "")

    async def test_an_unserved_alias_is_an_error_naming_the_real_ones(self, monkeypatch):
        """The message has to carry the options, or the operator learns only that it is broken."""
        await self._probe_with(monkeypatch, ["base", "rl"])
        _name, level, message = registry.choose_model("default")
        assert level == "error"
        assert "base" in message and "rl" in message
        assert "default" in message

    async def test_an_unserved_alias_is_NOT_silently_replaced(self, monkeypatch):
        """THE ONE THAT MATTERS MOST, and the reason this does not "helpfully" fall back.

        Substituting a working alias for a wrong one means an operator who typed `rl` gets `base`
        — a different set of weights — and no way to tell. Everything downstream, including the
        evaluations that decide whether a fine-tune is working, would be measuring the wrong model
        while looking entirely healthy. Fail visibly on their value instead.
        """
        await self._probe_with(monkeypatch, ["base", "rl"])
        name, _, _ = registry.choose_model("typo")
        assert name == "typo", "a wrong alias was swapped for a working one; the failure is now silent"

    async def test_unset_with_one_model_served_adopts_it(self, monkeypatch):
        """The ordinary single-model deployment. No ambiguity, so nothing to configure."""
        await self._probe_with(monkeypatch, ["only-one"])
        name, level, message = registry.choose_model("")
        assert name == "only-one"
        assert level == "info"
        assert "only-one" in message

    async def test_unset_with_several_served_is_fatal(self, monkeypatch):
        """FATAL, not a warning, and the reason is measured rather than assumed.

        An empty model name does NOT fail against this backend: `model=""` returns 200 and serves
        `base`, the first model, while `model="default"` 404s. So the unconfigured case silently
        picks weights nobody chose, and somebody evaluating a fine-tune gets the base model with a
        200 and no way to tell. Refusing to start is the only outcome that cannot be mistaken for
        working.
        """
        await self._probe_with(monkeypatch, ["base", "rl"])
        name, level, message = registry.choose_model("")
        assert level == "fatal", "an unresolvable alias is survivable; it silently serves the wrong model"
        assert name == ""
        assert "base" in message and "rl" in message
        assert "quietly serves" in message, "the message must say what happens, not just that it is unset"

    async def test_an_unreachable_backend_says_the_check_could_not_run(self, monkeypatch):
        """Silence would read as approval, and the value is unverified rather than fine."""
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://gone:30000/v1", lambda url: object())
        await registry.probe()

        name, level, message = registry.choose_model("rl")
        assert name == "rl"
        assert level == "warning"
        assert "could not be checked" in message


class TestTheStateReachesPrometheus:
    """The probe's answer has to leave the process, and until recently it did not.

    `/health` has reported `backendState` all along. But `/health` is polled by the kubelet and
    scraped by nothing, so the answer decided a readiness bit and went nowhere else -- there was no
    way to ask "has the backend been down for five minutes", which is the shape of the outage this
    project has already had once (`desktop/docs/DECISIONS.md`: "a soft catch-all made a permanent
    outage look like a busy backend").

    ASSERTED AGAINST THE RENDERED SCRAPE BODY, not against the gauge object. `metrics.set_backend_
    state` swallows its own exceptions on purpose -- instrumentation must not fail the probe that
    produced the value -- so a test that only called it would pass with the write silently dropped.
    The text of `/metrics` is what a scraper gets and is therefore the only honest assertion.
    """

    @staticmethod
    def _series() -> dict[str, float]:
        """{state: value} for this metric, read out of the scrape body."""
        from src import metrics

        assert metrics.inference_backend_state is not None, (
            "prometheus_client is missing from this environment, so every assertion in this class "
            "would pass vacuously on an empty scrape body. It is declared in all three "
            "requirements files; install it rather than skipping."
        )
        body, _ = metrics.render()
        found: dict[str, float] = {}
        for line in body.decode().splitlines():
            if line.startswith("voidcode_inference_backend_state{"):
                state = line.split('state="', 1)[1].split('"', 1)[0]
                found[state] = float(line.rsplit(" ", 1)[1])
        return found

    async def test_a_dead_backend_is_one_series_at_one(self, monkeypatch):
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://gone:30000/v1", lambda url: object())

        assert await registry.probe() == registry.DOWN
        assert self._series() == {"ready": 0.0, "waking": 0.0, "down": 1.0}

    async def test_a_live_backend_is_one_series_at_one(self, monkeypatch):
        _install(monkeypatch, _Recorder(status_code=200))
        registry.configure("http://backend:30000/v1", lambda url: object())

        assert await registry.probe() == registry.READY
        assert self._series() == {"ready": 1.0, "waking": 0.0, "down": 0.0}

    async def test_waking_is_distinguishable_from_down_in_the_metric_too(self, monkeypatch):
        """The distinction is the entire reason this is a state label rather than a 0/1 gauge.

        `down` is a page and `waking` is a wait. A boolean `backend_up` gauge would collapse them,
        and the alert built on it would either page on every deliberate restart or not page at all.
        """
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://restarting:30000/v1", lambda url: object())
        registry.expect_restart(True)

        assert await registry.probe() == registry.WAKING
        assert self._series() == {"ready": 0.0, "waking": 1.0, "down": 0.0}

    async def test_the_previous_state_is_zeroed_rather_than_left_standing(self, monkeypatch):
        """A gauge series persists once created, so the old state must be written down to 0.

        Setting only the current label would leave `down 1` next to `ready 1` forever, and
        `state="down" == 1 for 5m` would fire for the rest of the process's life on a backend that
        recovered in a second.
        """
        rec = _Recorder(boom=True)
        _install(monkeypatch, rec)
        registry.configure("http://flapping:30000/v1", lambda url: object())
        assert await registry.probe(now=100.0) == registry.DOWN
        assert self._series()["down"] == 1.0

        rec.boom = False
        assert await registry.probe(now=200.0) == registry.READY
        assert self._series() == {"ready": 1.0, "waking": 0.0, "down": 0.0}

    async def test_every_state_probe_can_assign_is_one_STATES_can_zero(self):
        """`STATES` is the list that zeroes the others, so a state missing from it is one that sticks.

        Add a fourth status to `probe()` and forget to add it here, and the metric would keep
        reporting the third state as current while `/health` reported the fourth -- a disagreement
        between two readers of the same variable, which is the failure this whole module exists for.

        Read off the AST rather than by calling: the interesting case is the state nobody wrote a
        test for yet, which is exactly the one no call can reach.
        """
        import ast
        import inspect

        tree = ast.parse(inspect.getsource(registry))
        probe = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "probe"
        )
        assigned: set[str] = set()
        for node in ast.walk(probe):
            if not isinstance(node, ast.Assign):
                continue
            targets = [
                t for t in node.targets
                if isinstance(t, ast.Attribute) and t.attr == "status"
            ]
            if not targets:
                continue
            names = {
                child.id for child in ast.walk(node.value) if isinstance(child, ast.Name)
            }
            # Minus the bases of attribute accesses: `WAKING if _state.expected_back else DOWN`
            # reads `_state`, which is the dataclass instance and not a candidate state.
            bases = {
                child.value.id
                for child in ast.walk(node.value)
                if isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name)
            }
            assigned |= names - bases

        assert assigned, "probe() no longer assigns _state.status; this test guards nothing"
        for name in sorted(assigned):
            value = getattr(registry, name, None)
            assert value in registry.STATES, (
                f"probe() can set _state.status to {name}={value!r}, which is not in STATES. The "
                "metric would never zero it, so a stale series would read as current forever."
            )
        assert len(set(registry.STATES)) == len(registry.STATES), "STATES has a duplicate"

    async def test_an_unconfigured_registry_emits_nothing(self, monkeypatch):
        """ABSENT, not `down`.

        The in-process HuggingFace and vLLM paths never configure this registry, and on those paths
        there is no backend to be unreachable -- readiness is "is a model object loaded", which
        `/health` answers as `model_loaded`. A `down 1` series there would be a false page on a
        deployment that is working, and the alert would have to be qualified with a label nobody
        would remember to add.
        """
        from src import metrics

        # Prove the emptiness is the registry's silence and not a metric that cannot write: a
        # separate state is set first, then cleared, so an always-empty reader would fail here.
        metrics.set_backend_state(registry.READY, registry.STATES)
        assert self._series() == {"ready": 1.0, "waking": 0.0, "down": 0.0}
        for state in registry.STATES:
            metrics.inference_backend_state.remove(state)
        assert self._series() == {}

        assert await registry.probe() == registry.DOWN, "an unconfigured registry is not ready"
        assert self._series() == {}, (
            "an unconfigured registry emitted a series. On the in-process paths that is a false "
            "'down' for a backend that does not exist."
        )
