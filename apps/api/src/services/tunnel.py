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
