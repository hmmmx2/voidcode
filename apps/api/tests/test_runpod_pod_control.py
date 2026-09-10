"""Pod control cannot touch a pod it was not told about.

WHY THIS FILE IS WRITTEN THE WAY IT IS

A RunPod API key is account-wide. Every pod in the account is addressable by id, and RunPod offers
no per-pod credential — there is no token that can only touch one machine. At the time of writing
the same account has been running a paid A40 for weeks whose volume holds work that cannot be
recreated. Nothing outside this codebase stops a bug here from reaching it.

So these tests do not check that the client behaves correctly when used correctly. They check that
it cannot be made to do the wrong thing:

  * that an unconfigured client makes ZERO HTTP requests, asserted with a transport that records
    them — not merely that an exception was raised, because an exception raised after the request
    went out is not protection;
  * that no method accepts a pod id, so there is no argument to pass the wrong value to;
  * that the source contains no collection endpoint, because a listing is one refactor away from
    iterating and iterating is one bug away from stopping everything in the account.

The last one is a source scan, and it is the single most important assertion here.
"""

import ast
import inspect
import re
from pathlib import Path

import httpx
import pytest

from src import config
from src.services import runpod_client as rp

SOURCE_PATH = Path(rp.__file__)
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")

pytestmark = pytest.mark.asyncio


class _Sentinel:
    """Records every request. If pod control is inert, this stays empty."""

    def __init__(self):
        self.requests: list[str] = []

    def install(self, monkeypatch):
        real = httpx.AsyncClient

        def factory(*args, **kwargs):
            def handle(request: httpx.Request) -> httpx.Response:
                self.requests.append(f"{request.method} {request.url}")
                return httpx.Response(200, json={"id": "whatever", "desiredStatus": "RUNNING"})

            kwargs["transport"] = httpx.MockTransport(handle)
            return real(*args, **kwargs)

        monkeypatch.setattr(rp.httpx, "AsyncClient", factory)
        return self


@pytest.fixture
def sentinel(monkeypatch):
    return _Sentinel().install(monkeypatch)


def _arm(monkeypatch, *, enabled=True, key="rp_test_key", pod_id="pod-abc123"):
    monkeypatch.setattr(config, "POD_CONTROL_ENABLED", enabled)
    monkeypatch.setattr(config, "RUNPOD_API_KEY", key)
    monkeypatch.setattr(config, "RUNPOD_POD_ID", pod_id)


class TestItIsInertUnlessExplicitlyTargeted:
    async def test_the_switch_off_means_no_request_at_all(self, monkeypatch, sentinel):
        _arm(monkeypatch, enabled=False)
        with pytest.raises(rp.PodControlDisabled):
            await rp.stop()
        assert sentinel.requests == [], f"a disabled client still called out: {sentinel.requests}"

    async def test_no_api_key_means_no_request_at_all(self, monkeypatch, sentinel):
        _arm(monkeypatch, key="")
        with pytest.raises(rp.PodControlDisabled):
            await rp.stop()
        assert sentinel.requests == []

    async def test_no_pod_id_means_no_request_at_all(self, monkeypatch, sentinel):
        """The dangerous half. A key without an id is a client that can reach every pod and has
        not been told which one is its own."""
        _arm(monkeypatch, pod_id="")
        with pytest.raises(rp.PodControlDisabled):
            await rp.stop()
        assert sentinel.requests == []

    async def test_start_and_describe_are_equally_inert(self, monkeypatch, sentinel):
        _arm(monkeypatch, enabled=False)
        for call in (rp.start, rp.stop, rp.describe):
            with pytest.raises(rp.PodControlDisabled):
                await call()
        assert sentinel.requests == []

    def test_is_armed_reports_honestly(self, monkeypatch):
        _arm(monkeypatch, enabled=False)
        assert rp.is_armed() is False
        _arm(monkeypatch, key="")
        assert rp.is_armed() is False
        _arm(monkeypatch, pod_id="")
        assert rp.is_armed() is False
        _arm(monkeypatch)
        assert rp.is_armed() is True

    def test_the_default_configuration_is_disarmed(self):
        """A checkout with no environment set must not be one command from stopping a pod."""
        assert config.POD_CONTROL_ENABLED is False


class TestItCanOnlyEverNameTheConfiguredPod:
    async def test_a_call_targets_the_configured_id(self, monkeypatch, sentinel):
        _arm(monkeypatch, pod_id="pod-configured")
        await rp.stop()
        assert sentinel.requests == ["POST https://rest.runpod.io/v1/pods/pod-configured/stop"]

    async def test_changing_the_configured_id_changes_the_target(self, monkeypatch, sentinel):
        _arm(monkeypatch, pod_id="pod-one")
        await rp.start()
        _arm(monkeypatch, pod_id="pod-two")
        await rp.start()
        assert sentinel.requests == [
            "POST https://rest.runpod.io/v1/pods/pod-one/start",
            "POST https://rest.runpod.io/v1/pods/pod-two/start",
        ]

    def test_no_public_method_accepts_a_pod_id(self):
        """An argument that does not exist cannot be passed the wrong value.

        This is the structural half of the guarantee: the tests above show the client uses the
        configured id, and this shows there is no other id it could have been given.
        """
        for name in ("start", "stop", "describe"):
            params = list(inspect.signature(getattr(rp, name)).parameters)
            assert params == [], (
                f"`{name}` now takes {params}. Pod control must read its target from "
                "configuration only — a parameter is a way to name somebody else's pod."
            )

    def test_every_request_is_built_from_the_configured_id(self):
        """`re.findall` plus a count, not `str.index`.

        A count that goes to zero fails with a message telling you to update the test; an `index`
        that finds nothing raises ValueError from inside the test, in a file the person who broke
        it did not touch.
        """
        calls = re.findall(r"await client\.request\([^)]*\)", SOURCE, re.DOTALL)
        assert len(calls) == 1, (
            f"expected exactly one outbound call in runpod_client.py, found {len(calls)} — "
            "every request must go through `_call`, which asserts armed before building a URL"
        )

        urls = re.findall(r'f"\{RUNPOD_API\}/pods/\{(\w+)\}"', SOURCE)
        assert urls == ["pod_id"], (
            f"a pod URL is built from {urls} rather than from the configured id"
        )


class TestItNeverListsPods:
    """THE TEST THAT PROTECTS EVERY OTHER POD IN THE ACCOUNT.

    A collection endpoint is one refactor away from a loop, and a loop over pods in an account that
    contains someone's multi-week training run is one bug away from destroying it. The client is
    therefore not allowed to know how to ask for a list at all.
    """

    def test_the_source_contains_no_collection_request(self):
        # Scanned as AST with docstrings dropped: this module explains at length why it must not
        # list pods, so a text scan would match its own reasoning.
        tree = ast.parse(SOURCE)
        code_chunks = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module)):
                body = list(node.body)
                if body and isinstance(body[0], ast.Expr) and isinstance(
                    body[0].value, ast.Constant
                ):
                    body = body[1:]
                for stmt in body:
                    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    code_chunks.append(ast.get_source_segment(SOURCE, stmt) or "")
        code = "\n".join(code_chunks)

        for banned in ('"/pods"', "'/pods'", "/pods?", "pods/list"):
            assert banned not in code, (
                f"runpod_client.py contains {banned!r}. It must only ever address the ONE "
                "configured pod: a listing is how a service that manages its own pod becomes a "
                "service that can stop somebody else's."
            )

    def test_it_never_reads_a_pod_id_out_of_a_response(self):
        """Acting on an id from a response body is the same hazard by a different route."""
        tree = ast.parse(SOURCE)
        for node in ast.walk(tree):
            if isinstance(node, ast.Subscript):
                segment = ast.get_source_segment(SOURCE, node) or ""
                assert '["id"]' not in segment, (
                    "a pod id is being read out of a response body. The target comes from "
                    "configuration and nowhere else."
                )


class TestThereIsNoTerminate:
    def test_the_client_offers_no_terminate(self):
        """Termination destroys a volume, and it is not needed for the cost case.

        Stopping halts the GPU charge and roughly doubles a volume's storage rate — about $0.014/hr
        on 100 GB against roughly $0.49/hr of A40. The way to make an irreversible operation safe is
        not to implement it.
        """
        assert not hasattr(rp, "terminate")
        tree = ast.parse(SOURCE)
        names = {
            n.name for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        assert "terminate" not in names
        assert "delete" not in names


class TestStartupRefusesAHalfConfiguredService:
    """Each of these tests exactly one guard, with every unrelated switch neutralised.

    `assert_production_config` accumulates several independent checks, and other test modules in
    this suite call `importlib.reload(config)` with their own environments -- which leaves module
    state behind. Without the fixture below, `test_disabled_needs_neither` passed alone and failed
    in a full run, tripping the billing-versus-identity guard that has nothing to do with pod
    control. A test whose result depends on what ran before it is not testing what it says.
    """

    @pytest.fixture(autouse=True)
    def only_the_pod_guard(self, monkeypatch):
        monkeypatch.setattr(config, "GPU_BILLING_ENFORCE", False)
        monkeypatch.setattr(config, "INTERNAL_AUTH_ENFORCE", False)
        monkeypatch.setattr(config, "PAYMENTS_ENABLED", False)
        monkeypatch.setattr(config, "IS_PRODUCTION", False)

    def test_enabled_without_a_key_is_a_startup_failure(self, monkeypatch):
        monkeypatch.setattr(config, "POD_CONTROL_ENABLED", True)
        monkeypatch.setattr(config, "RUNPOD_API_KEY", "")
        monkeypatch.setattr(config, "RUNPOD_POD_ID", "pod-abc")
        with pytest.raises(config.ConfigError, match="RUNPOD_API_KEY"):
            config.assert_production_config()

    def test_enabled_without_a_pod_id_is_a_startup_failure(self, monkeypatch):
        monkeypatch.setattr(config, "POD_CONTROL_ENABLED", True)
        monkeypatch.setattr(config, "RUNPOD_API_KEY", "rp_key")
        monkeypatch.setattr(config, "RUNPOD_POD_ID", "")
        with pytest.raises(config.ConfigError, match="RUNPOD_POD_ID"):
            config.assert_production_config()

    def test_disabled_needs_neither(self, monkeypatch):
        """The common case — every deployment that does not manage its own pod — must still boot."""
        monkeypatch.setattr(config, "POD_CONTROL_ENABLED", False)
        monkeypatch.setattr(config, "RUNPOD_API_KEY", "")
        monkeypatch.setattr(config, "RUNPOD_POD_ID", "")
        config.assert_production_config()


class TestTheKeyIsTreatedAsASecret:
    def test_it_is_never_logged(self):
        """A key in a log is a key in a log aggregator, a screenshot and a support ticket."""
        tree = ast.parse(SOURCE)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id == "logger":
                    segment = ast.get_source_segment(SOURCE, node) or ""
                    for leak in ("key", "RUNPOD_API_KEY", "Authorization"):
                        assert leak not in segment, f"a log line references {leak!r}: {segment}"

    def test_the_response_body_is_never_logged(self):
        """RunPod may echo the request, and the request carries the header."""
        assert "response.text" not in SOURCE
