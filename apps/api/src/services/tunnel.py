"""Keeping the SSH forward to a rented GPU alive across a stop and a start.

WHY SPIN-DOWN NEEDS THIS TO EXIST

The API reaches SGLang at `SGLANG_BASE_URL`, and on a RunPod pod that address is a LOCAL port
forwarded over SSH -- `ssh -N -L 8080:127.0.0.1:8080 -p <port> root@<ip>`. SGLang listens on 8080
inside the container, and the pod template exposes only `22/tcp` and `8888/http`, so RunPod's HTTP
proxy cannot reach it: every port tried on `<pod>-<port>.proxy.runpod.net` returns 404. The tunnel
is the only route.

Stopping the pod kills that tunnel, and **RunPod assigns a new SSH port on start** -- 22107 today,
something else tomorrow. So the forward cannot simply be restarted; the command itself is stale.
`spindown.ensure_awake` cannot fix this, because the broken thing is on the operator's machine
rather than on the pod. Without something that re-reads the port, arming `SPINDOWN_ENABLED` stops
the pod once and strands the backend.

WHAT THIS DOES NOT DO, AND THE LINE IS DELIBERATE

It never starts the pod and never stops it. `spindown` owns both, through `runpod_client`, which is
the one place in this system that can spend money -- and which refuses to list pods precisely so it
can never act on the wrong one. A supervisor that also started pods would be a second such place,
running unattended on a laptop, outside every guard built for the first. It reads the pod's address
and manages a local process. That is all.

The consequence is worth stating: while the pod is stopped this waits and does nothing, which is
correct. A learner's request wakes the pod through the API; this notices the pod is up and rebuilds
the forward.

WHY THE DECISIONS ARE SEPARATE FROM THE PROCESS

`plan_from` is pure: pod description in, decision out. Spawning `ssh` and polling a socket is not
testable without a network and a rented GPU, but "the port changed, so rebuild" and "the pod is
stopped, so wait" are exactly the rules that need testing, and they are here rather than tangled
into a loop.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: RunPod reports its state here. Anything other than RUNNING means there is nothing to connect to.
RUNNING = "RUNNING"

#: What `ports` must contain for the forward to be possible at all.
SSH_PORT_KEY = "22"


@dataclass(frozen=True)
class Endpoint:
    """Where the pod's sshd is right now."""

    host: str
    port: int

    def ssh_command(self, local_port: int, remote_port: int, user: str = "root") -> list[str]:
        """The forward, as argv.

        `ExitOnForwardFailure` matters more than it looks: without it, ssh happily connects and
        silently fails to bind the local port, leaving a live process and a dead tunnel -- which
        reads as "the supervisor is running, so the tunnel is fine" and is the failure this whole
        module exists to prevent. `ServerAliveInterval` makes a dropped pod surface as an exit
        rather than a hang.
        """
        return [
            "ssh", "-N",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-L", f"{local_port}:127.0.0.1:{remote_port}",
            "-p", str(self.port),
            f"{user}@{self.host}",
        ]


@dataclass(frozen=True)
class Plan:
    """What to do next, and why -- so a log line can say the reason rather than the action."""

    action: str  # "connect" | "wait" | "keep"
    endpoint: Endpoint | None
    reason: str


def endpoint_from(description: dict) -> Endpoint | None:
    """Where to ssh to, or None when the pod cannot say.

    Reads `portMappings["22"]` rather than parsing the `ports` list: `ports` describes what the
    TEMPLATE exposes (`"22/tcp"`), while `portMappings` carries the number actually assigned this
    run. Confusing the two is how you end up reconnecting to yesterday's port.
    """
    ip = description.get("publicIp")
    mappings = description.get("portMappings") or {}
    port = mappings.get(SSH_PORT_KEY)
    if not ip or not port:
        return None
    try:
        return Endpoint(str(ip), int(port))
    except (TypeError, ValueError):
        return None


def plan_from(description: dict, current: Endpoint | None, *, healthy: bool) -> Plan:
    """Decide, given what the provider says and what is running locally.

    `healthy` is whether the forward is actually carrying traffic, not whether a process exists. An
    ssh process that is alive but not forwarding is the case that makes a supervisor useless, so
    the caller is required to have checked the socket rather than the process table.
    """
    status = description.get("desiredStatus")
    if status != RUNNING:
        return Plan("wait", None, f"the pod is {status or 'in an unknown state'}, not running")

    endpoint = endpoint_from(description)
    if endpoint is None:
        # Running but not yet addressable. Normal for a few seconds after a start.
        return Plan("wait", None, "the pod is running but has not published an ssh port yet")

    if current is not None and current != endpoint:
        # THE CASE THIS MODULE EXISTS FOR. A restarted pod comes back on a different port, so the
        # old command would reconnect to nothing -- or, worse, to whatever now answers there.
        return Plan("connect", endpoint,
                    f"the ssh port moved from {current.port} to {endpoint.port}")

    if not healthy:
        return Plan("connect", endpoint, "the forward is not carrying traffic")

    return Plan("keep", endpoint, "the forward is healthy")


@dataclass(frozen=True)
class ServePlan:
    """Whether to (re)launch the model server inside the pod, and why."""

    action: str  # "launch" | "wait" | "rebuild" | "none"
    reason: str


def serve_plan(
    *,
    enabled: bool,
    tunnel_up: bool,
    backend_ready: bool,
    launched_ago: float | None,
    cooldown: float,
    tunnel_rebuilt: bool = True,
    server_running: bool | None = None,
) -> ServePlan:
    """Decide whether the pod needs its model server started.

    WHY THIS IS NEEDED AT ALL: the pod runs RunPod's stock `runpod-torch-v240` template, whose start
    command brings up sshd and nothing else. After a spin-down the tunnel reconnects and the port
    behind it answers nothing, because the server was started by hand. So a wake that restores the
    tunnel is only half a wake.

    THE COOLDOWN IS THE WHOLE SAFETY PROPERTY. `pod_serve_rl.sh` kills every process holding the GPU
    before it starts -- correctly, because vLLM's EngineCore is a child and killing the parent
    leaves the card occupied. But that means launching it while a previous launch is still loading
    KILLS THE LOAD. A 30B takes minutes to come up; a supervisor checking every 15s without a
    cooldown would kill and relaunch a hundred times and the model would never finish, while the log
    filled with what looks like diligent recovery.

    `backend_ready` must be a real request to the model API, not a socket check: `ssh -L` binds the
    local port on connect, so a TCP connect succeeds whether or not anything listens inside the pod.

    `server_running` is the reliable signal and `launched_ago` is the fallback for when there is
    nothing to ask. Prefer the observation: a timer long enough to be safe is long enough to leave a
    genuinely failed launch unretried for that whole period, and one short enough to retry promptly
    is short enough to kill a slow load. There is no good value, which is the sign that the question
    was wrong.

    `launched_ago` must be set from the ATTEMPT, never from a confirmed success. The cold-start
    drill on 2026-09-10 had the caller record it only when the launch reported success; the launch
    call was timing out and reporting failure, so no cooldown was ever recorded, and the supervisor
    relaunched every 20s into its own loading engine. Three api_servers ended up stacked on the pod
    with the GPU at 0 MiB. A cooldown conditioned on knowing the outcome is a cooldown that is
    absent exactly when it is needed.
    """
    if not enabled:
        return ServePlan("none", "starting the model server is not enabled")
    if not tunnel_up:
        return ServePlan("none", "there is no tunnel to reach the backend through")
    if backend_ready:
        return ServePlan("none", "the backend is answering")
    if not tunnel_rebuilt:
        # TRY THE CHEAP, SAFE REMEDY BEFORE THE EXPENSIVE, DESTRUCTIVE ONE.
        #
        # "The backend is not answering" has two causes and they look identical from here: the
        # model is down, or the tunnel is stale. Observed on 2026-09-10 -- an ssh forward that
        # accepted connections locally and never carried them, while the pod was serving perfectly
        # on the other side. `forwarding()` cannot tell: `ssh -L` binds the local port on connect,
        # so a TCP check passes on a dead channel.
        #
        # Rebuilding the tunnel costs three seconds and breaks nothing. Relaunching the model kills
        # whatever holds the GPU and costs ten minutes. Ordering them by that asymmetry means the
        # common case is fixed cheaply, and the model is only touched once a FRESH tunnel has also
        # failed -- which is the only evidence that actually implicates the model.
        return ServePlan("rebuild", "the backend is not answering; rebuilding the tunnel first")
    if server_running:
        # OBSERVED, NOT GUESSED, and the second cold-start drill is why this exists.
        #
        # The cooldown below is a timer, and a timer has to be tuned against something nobody
        # measured: a 30B AWQ load runs about fourteen minutes here, the default was fifteen, and
        # on a slower run the timer expired first. The supervisor relaunched into a load sitting at
        # 16 GB of weights and killed it -- doing precisely the damage the cooldown exists to
        # prevent, by being slightly too short.
        #
        # A running server process is not evidence about elapsed time, it is the thing the timer
        # was trying to infer. When it can be checked, it decides.
        return ServePlan("wait", "a model server process is already running; it is still loading")
    if launched_ago is not None and launched_ago < cooldown:
        return ServePlan(
            "wait",
            f"launched {launched_ago:.0f}s ago and the model needs up to {cooldown:.0f}s to load; "
            "relaunching now would kill the load in progress",
        )
    return ServePlan("launch", "the tunnel is up and the backend is not answering")
