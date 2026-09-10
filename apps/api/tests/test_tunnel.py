"""The decisions the tunnel supervisor makes, tested without a pod or a network.

WHAT THIS IS PROTECTING

`SPINDOWN_ENABLED` cannot be turned on until the SSH forward can survive a stop and a start.
RunPod assigns a NEW ssh port when a pod starts, so the old command reconnects to nothing -- and
the pod template exposes only `22/tcp` and `8888/http` while SGLang listens on 8080, so the HTTP
proxy is not an option and the tunnel is the only route to the model.

Spawning ssh and polling a socket needs a rented GPU. Deciding "the port moved, rebuild" and "the
pod is stopped, wait" does not, and those are the rules that go wrong. They live in
`src/services/tunnel.py` for exactly that reason.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from src.services.tunnel import Endpoint, endpoint_from, plan_from, serve_plan


def _load_supervisor():
    """Load the supervisor BY PATH, not by package name.

    `from scripts import tunnel_supervisor` works when this file runs alone and fails in a full
    suite run: the repository root has its own top-level `scripts` package, another test puts that
    root on `sys.path` first, and the import then resolves to the wrong one. A path is unambiguous
    and does not depend on which tests ran before this one.
    """
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "scripts" / "tunnel_supervisor.py"
    spec = importlib.util.spec_from_file_location("_voidcode_tunnel_supervisor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


supervisor = _load_supervisor()

RUNNING_POD = {
    "desiredStatus": "RUNNING",
    "publicIp": "69.30.85.23",
    "ports": ["8888/http", "22/tcp"],
    "portMappings": {"22": 22107},
}


class TestReadingTheAddress:
    def test_it_reads_the_assigned_port_not_the_exposed_one(self):
        """`ports` says what the template EXPOSES; `portMappings` says what was assigned today.

        `"22/tcp"` is a description of a template and never changes. `{"22": 22107}` is this run's
        number and changes on every start. Reading the first would rebuild the tunnel to port 22
        and fail forever, which is a very quiet way to be wrong.
        """
        assert endpoint_from(RUNNING_POD) == Endpoint("69.30.85.23", 22107)

    @pytest.mark.parametrize(
        ("description", "why"),
        [
            ({"publicIp": "1.2.3.4"}, "no portMappings at all"),
            ({"publicIp": "1.2.3.4", "portMappings": {}}, "portMappings is empty"),
            ({"portMappings": {"22": 22107}}, "no publicIp"),
            ({"publicIp": "1.2.3.4", "portMappings": {"8888": 1}}, "ssh is not mapped"),
            ({"publicIp": "1.2.3.4", "portMappings": {"22": "not-a-port"}}, "unparseable port"),
        ],
    )
    def test_an_unaddressable_pod_yields_nothing(self, description, why):
        """None rather than a partial Endpoint. A pod that has just started is briefly like this,
        and guessing a port would connect to whatever happens to be there."""
        assert endpoint_from(description) is None, why


class TestTheDecision:
    def test_a_healthy_forward_is_left_alone(self):
        plan = plan_from(RUNNING_POD, Endpoint("69.30.85.23", 22107), healthy=True)
        assert plan.action == "keep"

    def test_a_moved_port_is_the_case_this_exists_for(self):
        """The pod restarted on a different port, so the running forward points at nothing.

        Note it rebuilds even though the tunnel reports HEALTHY. An ssh process connected to the
        old port may well still be accepting locally -- to a machine that has gone, or to whatever
        now answers on that address. Trusting `healthy` here is how the supervisor would sit
        contentedly beside a dead backend.
        """
        plan = plan_from(RUNNING_POD, Endpoint("69.30.85.23", 22000), healthy=True)
        assert plan.action == "connect"
        assert plan.endpoint == Endpoint("69.30.85.23", 22107)
        assert "22000" in plan.reason and "22107" in plan.reason

    def test_a_dead_forward_on_the_same_port_reconnects(self):
        plan = plan_from(RUNNING_POD, Endpoint("69.30.85.23", 22107), healthy=False)
        assert plan.action == "connect"

    def test_nothing_running_yet_connects(self):
        plan = plan_from(RUNNING_POD, None, healthy=False)
        assert plan.action == "connect"
        assert plan.endpoint == Endpoint("69.30.85.23", 22107)

    @pytest.mark.parametrize("status", ["EXITED", "STOPPED", "TERMINATED", None])
    def test_a_pod_that_is_not_running_means_wait(self, status):
        """WAIT, never start. Spin-down owns starting, through the one client that can spend money
        and that refuses to list pods so it cannot act on the wrong one. A supervisor running
        unattended on a laptop must not become a second such place."""
        plan = plan_from({**RUNNING_POD, "desiredStatus": status}, None, healthy=False)
        assert plan.action == "wait"
        assert plan.endpoint is None

    def test_running_but_not_yet_addressable_means_wait(self):
        """The few seconds after a start, before the port is published. Retrying is right;
        inventing an address is not."""
        plan = plan_from({"desiredStatus": "RUNNING"}, None, healthy=False)
        assert plan.action == "wait"
        assert "ssh port" in plan.reason


class TestTheCommand:
    def test_it_forwards_the_local_port_to_the_pods_own_port(self):
        command = Endpoint("69.30.85.23", 22107).ssh_command(8080, 8080)
        assert "-L" in command
        assert command[command.index("-L") + 1] == "8080:127.0.0.1:8080"
        assert command[command.index("-p") + 1] == "22107"
        assert command[-1] == "root@69.30.85.23"

    def test_it_refuses_to_run_without_the_forward(self):
        """`ExitOnForwardFailure` is what makes a failure visible.

        Without it ssh connects happily, silently fails to bind the local port, and leaves a live
        process carrying nothing — which reads as "the supervisor is running, so we're fine". That
        is precisely the failure this module exists to prevent, so it is asserted rather than
        assumed.
        """
        command = Endpoint("h", 1).ssh_command(8080, 8080)
        assert "ExitOnForwardFailure=yes" in command

    def test_a_dropped_pod_surfaces_as_an_exit_rather_than_a_hang(self):
        command = Endpoint("h", 1).ssh_command(8080, 8080)
        assert "ServerAliveInterval=30" in command
        assert "ServerAliveCountMax=3" in command

    def test_a_reassigned_host_key_does_not_block_reconnection(self):
        """A restarted pod is a new machine with a new host key.

        Strict checking would refuse to connect after every spin-down, and the operator would fix
        it by editing known_hosts at 2am. The trade is accepted deliberately: this connects to an
        address the provider just told us, over a link that only carries a model API.
        """
        command = Endpoint("h", 1).ssh_command(8080, 8080)
        assert "StrictHostKeyChecking=no" in command
        assert "UserKnownHostsFile=/dev/null" in command


class TestWhatTheSupervisorCannotSee:
    """Two limits worth writing down, because both look like success.

    A local port check cannot tell a live backend from a dead one. `ssh -L` binds the local port as
    soon as it connects, so a TCP connect to it succeeds whether or not anything is listening
    inside the pod -- the channel only fails once traffic flows. `forwarding()` therefore answers
    "is the forward established", never "is SGLang up". That second question belongs to
    `backend_registry.probe()`, which is the one thing that actually speaks the model API, and
    `/health` reports it.

    And the pod runs RunPod's stock `runpod-torch-v240` template, whose start command brings up
    sshd and nothing else. `scripts/pod_serve_rl.sh` is run by hand. So after a spin-down the
    tunnel would reconnect, this module would call it healthy, and the port behind it would answer
    nothing -- which is why `SPINDOWN_ENABLED` is still off with the supervisor working.
    """

    def test_the_plan_never_claims_the_backend_is_up(self):
        """`healthy` is an input about the FORWARD, and the vocabulary stays that narrow.

        A plan that said "ready" would be making a claim this module has no way to check, and the
        next person would reasonably trust it.
        """
        for healthy in (True, False):
            plan = plan_from(RUNNING_POD, Endpoint("69.30.85.23", 22107), healthy=healthy)
            assert plan.action in {"keep", "connect", "wait"}
            assert "sglang" not in plan.reason.lower()
            assert "ready" not in plan.reason.lower()


class TestStartingTheModelServer:
    """Restoring the tunnel is only half a wake.

    The pod runs RunPod's stock `runpod-torch-v240` template, whose start command brings up sshd
    and nothing else, so after a spin-down the forward reconnects and the port behind it answers
    nothing. The supervisor can run `pod_serve_rl.sh` to fix that — and the way it can go wrong is
    much worse than not doing it at all.
    """

    def test_it_launches_when_the_tunnel_is_up_and_nothing_answers(self):
        plan = serve_plan(enabled=True, tunnel_up=True, backend_ready=False,
                          launched_ago=None, cooldown=900)
        assert plan.action == "launch"

    def test_a_launch_in_progress_is_never_relaunched(self):
        """THE ONE THAT MATTERS, and the failure is self-inflicted and total.

        `pod_serve_rl.sh` kills every process holding the GPU before it starts — correctly, since
        vLLM's EngineCore is a child and killing the parent leaves the card occupied. So relaunching
        during a load KILLS THE LOAD. A 30B takes minutes; a supervisor checking every 15s without
        this rule would kill and relaunch a hundred times, never converge, and fill the log with
        what reads as diligent recovery.
        """
        plan = serve_plan(enabled=True, tunnel_up=True, backend_ready=False,
                          launched_ago=30, cooldown=900)
        assert plan.action == "wait"
        assert "kill the load" in plan.reason

    def test_it_gives_up_waiting_once_the_cooldown_passes(self):
        """A launch that failed silently must eventually be retried, or one bad start is forever."""
        plan = serve_plan(enabled=True, tunnel_up=True, backend_ready=False,
                          launched_ago=901, cooldown=900)
        assert plan.action == "launch"

    def test_a_healthy_backend_is_left_alone(self):
        """Running the script against a working server would kill the GPU and reload for minutes."""
        plan = serve_plan(enabled=True, tunnel_up=True, backend_ready=True,
                          launched_ago=None, cooldown=900)
        assert plan.action == "none"

    def test_it_does_nothing_without_a_tunnel(self):
        """`backend_ready` cannot mean anything with no route to the backend, so a False there is
        about the tunnel rather than the model."""
        plan = serve_plan(enabled=True, tunnel_up=False, backend_ready=False,
                          launched_ago=None, cooldown=900)
        assert plan.action == "none"

    def test_it_is_off_unless_asked_for(self):
        """Off by default because it kills every process holding the pod's GPU. Pointed at a pod
        doing something else — a training run, say — it would end that work."""
        plan = serve_plan(enabled=False, tunnel_up=True, backend_ready=False,
                          launched_ago=None, cooldown=900)
        assert plan.action == "none"
        assert "not enabled" in plan.reason


class TestTheCooldownBookkeeping:
    """The cold-start drill found this, and the unit tests above did not.

    `serve_plan` was right. The CALLER was wrong: it recorded the cooldown only when the launch
    reported success. The ssh call was timing out and reporting failure, so no cooldown was ever
    recorded, and the supervisor relaunched every 20 seconds into its own loading engine. Three
    api_servers ended up stacked on the pod with the GPU at 0 MiB and nothing serving.

    Every test above passed throughout. They exercised the decision and nothing exercised the
    bookkeeping the decision depends on, which is a whole class of bug: a correct rule fed a state
    variable that is never set.
    """

    def _forward(self):
        forward = supervisor.Forward()
        forward.endpoint = Endpoint("1.2.3.4", 22)
        return forward

    def test_a_failed_launch_still_starts_the_cooldown(self, monkeypatch, tmp_path):
        """THE ONE THAT WOULD HAVE SAVED THE DRILL.

        A cooldown conditioned on knowing the attempt worked is absent exactly when it is needed:
        the reason to wait is that the last attempt may be running and killing it would be
        destructive, and "may be" is what a failure report cannot rule out.
        """
        monkeypatch.setattr(supervisor, "backend_ready", lambda *a, **k: False)
        monkeypatch.setattr(supervisor, "launch_serve", lambda *a, **k: False)
        script = tmp_path / "serve.sh"
        script.write_text("true", encoding="utf-8")

        state: dict = {}
        result = supervisor._maybe_serve(self._forward(), 8080, script, 900.0, state)

        assert result == "failed"
        assert "launched_at" in state, (
            "a launch that reported failure recorded no cooldown; the next check relaunches into "
            "a possibly-loading engine and kills it")

    def test_a_second_check_during_the_cooldown_does_not_relaunch(self, monkeypatch, tmp_path):
        """The consequence of the above, asserted end to end through the caller."""
        launches = []
        monkeypatch.setattr(supervisor, "backend_ready", lambda *a, **k: False)
        monkeypatch.setattr(supervisor, "launch_serve",
                            lambda *a, **k: launches.append(1) or False)
        script = tmp_path / "serve.sh"
        script.write_text("true", encoding="utf-8")

        state: dict = {}
        forward = self._forward()
        for _ in range(5):
            supervisor._maybe_serve(forward, 8080, script, 900.0, state)

        assert len(launches) == 1, (
            f"launched {len(launches)} times in a row; this is the loop that stacked three engines "
            "onto the GPU")

    def test_a_recovered_backend_clears_the_cooldown(self, monkeypatch, tmp_path):
        """So a LATER failure can act at once rather than waiting out a timer that already paid off."""
        monkeypatch.setattr(supervisor, "backend_ready", lambda *a, **k: True)
        script = tmp_path / "serve.sh"
        script.write_text("true", encoding="utf-8")

        state = {"launched_at": 1.0}
        assert supervisor._maybe_serve(self._forward(), 8080, script, 900.0, state) == "keep"
        assert "launched_at" not in state

    def test_a_timed_out_launch_is_treated_as_possibly_running(self):
        """`launch_serve` returns True on timeout, because the script may well have started.

        Reporting failure there is what made the caller's bug destructive rather than merely noisy.
        """
        source = (
            Path(supervisor.__file__).read_text(encoding="utf-8")
            .split("except subprocess.TimeoutExpired:")[1]
            .split("logger.info")[0]
        )
        assert "return True" in source, (
            "a timed-out launch reports failure again; the script may be running and the next "
            "check would kill it")
