"""Keep the SSH forward to the GPU pod alive, across a spin-down and a wake.

WHY THIS IS NEEDED BEFORE `SPINDOWN_ENABLED` CAN BE TURNED ON

The API talks to SGLang at `SGLANG_BASE_URL`, which on this deployment is a local port forwarded
over SSH. The pod template exposes only `22/tcp` and `8888/http`, and SGLang listens on 8080, so
RunPod's HTTP proxy cannot reach it -- every port tried on `<pod>-<port>.proxy.runpod.net` returns
404. The tunnel is the only route to the model.

Stopping the pod kills the tunnel, and RunPod assigns a NEW SSH port on start. So the forward
cannot just be restarted; the command is stale. `spindown.ensure_awake` cannot help, because the
broken thing is on this machine rather than on the pod. Without this supervisor, arming spin-down
stops the pod once and strands the backend until somebody re-runs ssh by hand with a port they have
to look up.

IT NEVER STARTS OR STOPS THE POD

`spindown` owns that, through `runpod_client` -- the one place in this system that can spend money,
and the one that refuses to list pods so it can never act on the wrong one. A supervisor that also
started pods would be a second such place, running unattended, outside every guard built for the
first. While the pod is stopped this waits and does nothing, which is correct: a learner's request
wakes it through the API, and this notices and rebuilds the forward.

IT CAN START THE MODEL SERVER INSIDE THE POD, AND THAT IS A DIFFERENT THING

Restoring the tunnel is only half a wake. The pod runs RunPod's stock `runpod-torch-v240` template,
whose start command brings up sshd and nothing else, so after a stop the forward reconnects and the
port behind it answers nothing. With `--serve-script`, this uploads that script and runs it once the
tunnel is up and the backend is not answering.

Renting a machine and running a process on a machine you already rent are different powers, which is
why one lives here and the other does not. Still OFF by default: the script kills every process
holding the GPU before it starts, so pointing this at a pod doing something else would end that
work.

USAGE

    python -m scripts.tunnel_supervisor

Run it from `apps/api` with the API's environment loaded, the same as any other script here. It
needs `RUNPOD_API_KEY`, `RUNPOD_POD_ID` and `POD_CONTROL_ENABLED=true` -- the same arming as pod
control, because it reads the pod through the same client.

    --local-port    the port the API connects to        (default: from SGLANG_BASE_URL)
    --remote-port   the port the model server listens on, in the pod (default: 8080)
    --interval      seconds between checks             (default: 15)
    --once          check once and exit, for a smoke test
    --serve-script  local script to upload and run when the backend is not answering.
                    OFF unless given. `scripts/pod_serve_rl.sh` is the one this pod uses.
    --serve-cooldown  seconds to let a launch finish before trying again (default: 900).
                    A 30B takes minutes to load and the script kills the GPU first, so a
                    shorter value here relaunches into its own load and never converges.

Ctrl-C stops it and takes the tunnel with it.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from src import config
from src.services import runpod_client, tunnel

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("tunnel")


def _default_local_port() -> int:
    """Whatever the API is configured to talk to, so the two cannot drift apart."""
    parsed = urlparse(config.SGLANG_BASE_URL)
    return parsed.port or 8080


def forwarding(port: int, host: str = "127.0.0.1", timeout: float = 2.0) -> bool:
    """Is something ACCEPTING on the local port?

    A socket check, not a process check, and the difference is the whole point. `ssh` can be alive
    and not forwarding -- a half-open connection to a pod that has gone away leaves a process that
    looks healthy in `ps` and carries nothing. Asking the port is asking the question that matters.
    """
    with contextlib.suppress(OSError):
        with socket.create_connection((host, port), timeout=timeout):
            return True
    return False


def backend_ready(port: int, timeout: float = 5.0) -> bool:
    """Does the MODEL API answer, not merely the socket?

    `forwarding()` cannot tell these apart: `ssh -L` binds the local port as soon as it connects,
    so a TCP connect succeeds whether or not anything is listening inside the pod. Only a real
    request distinguishes "the tunnel is up" from "the model is serving", and after a spin-down
    those two states are exactly what need distinguishing.
    """
    request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/models")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def launch_serve(endpoint: tunnel.Endpoint, script: Path) -> bool:
    """Upload the serve script and run it, detached. Returns whether the launch was accepted.

    The script is sent from the repository rather than assumed to be on the pod, so what runs is
    what is version-controlled and reviewable -- `pod_serve_rl.sh` carries a GPU-occupancy kill and
    a `setsid nohup` that took a debugging session each to get right, and reproducing them inline
    here would be copying them badly.

    Returning means "the launch was accepted", never "the model is up". Loading a 30B takes
    minutes; readiness is decided later by `backend_ready`, which asks the model API.
    """
    body = script.read_text(encoding="utf-8")
    remote = f"/workspace/{script.name}"
    base = [
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=20", "-p", str(endpoint.port), f"root@{endpoint.host}",
    ]
    try:
        # Text mode with newline="" would keep CRLF, and bash rejects a script with carriage
        # returns in a way that reads as a syntax error in the script itself.
        upload = subprocess.run(
            [*base, f"cat > {remote} && chmod +x {remote}"],
            input=body.replace("\r\n", "\n").encode("utf-8"),
            capture_output=True, timeout=60, check=False,
        )
        if upload.returncode != 0:
            logger.error("could not upload %s: %s", script.name,
                         upload.stderr.decode("utf-8", "replace").strip()[:300])
            return False

        # `bash <script>` returns as soon as the script backgrounds the engine; the script itself
        # owns detaching it, so this does not wait for a model load.
        run = subprocess.run(
            [*base, f"bash {remote}"], capture_output=True, timeout=180, check=False,
        )
        if run.returncode != 0:
            logger.error("serve script failed: %s",
                         run.stderr.decode("utf-8", "replace").strip()[:300])
            return False
    except subprocess.TimeoutExpired:
        logger.error("timed out launching the serve script")
        return False

    logger.info("serve script launched; the model will take minutes to load")
    return True


class Forward:
    """The ssh child process, and the endpoint it was built for."""

    def __init__(self) -> None:
        self.process: subprocess.Popen | None = None
        self.endpoint: tunnel.Endpoint | None = None

    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def stop(self) -> None:
        if self.process is None:
            return
        with contextlib.suppress(Exception):
            self.process.terminate()
            self.process.wait(timeout=10)
        self.process = None
        self.endpoint = None

    def start(self, endpoint: tunnel.Endpoint, local_port: int, remote_port: int) -> None:
        """Replace whatever was running with a forward to `endpoint`.

        The old process is killed FIRST. Two ssh processes asking for the same local port means the
        second fails on `ExitOnForwardFailure` and exits, and the supervisor concludes it cannot
        connect -- while the stale one holds the port open to a pod that no longer exists.
        """
        self.stop()
        command = endpoint.ssh_command(local_port, remote_port)
        logger.info("opening forward: %s", " ".join(command))
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        self.endpoint = endpoint


async def check(
    forward: Forward,
    local_port: int,
    remote_port: int,
    *,
    serve_script: Path | None = None,
    serve_cooldown: float = 900.0,
    state: dict | None = None,
) -> str:
    """One pass. Returns the action taken, for the caller to log or assert on."""
    state = state if state is not None else {}
    try:
        description = await runpod_client.describe()
    except runpod_client.PodControlError as exc:
        # Not fatal, and deliberately not a reason to tear the tunnel down. A RunPod API blip says
        # nothing about whether the forward is carrying traffic, and killing a working tunnel
        # because a status call failed would be an outage caused entirely by the supervisor.
        logger.warning("could not read the pod (leaving the tunnel alone): %s", exc)
        return "unknown"

    healthy = forward.alive() and forwarding(local_port)
    plan = tunnel.plan_from(description, forward.endpoint, healthy=healthy)

    if plan.action == "keep":
        return _maybe_serve(forward, local_port, serve_script, serve_cooldown, state)

    if plan.action == "wait":
        if forward.alive():
            # The pod has gone away; a forward to it is at best useless and at worst pointing at
            # whatever occupies that address next.
            logger.info("closing the forward: %s", plan.reason)
            forward.stop()
        else:
            logger.info("waiting: %s", plan.reason)
        return "wait"

    if forward.process is None and forwarding(local_port):
        # SOMEBODY ELSE IS ALREADY FORWARDING THIS PORT -- almost always a hand-run `ssh -L` from
        # before this supervisor existed. Spawning a second one would fail on
        # `ExitOnForwardFailure` with `bind: Address already in use`, and the supervisor would
        # report "cannot connect" while a perfectly good tunnel sat right there.
        #
        # It does NOT kill the other process. Something on this machine is deliberately holding a
        # port, and a background script that terminates processes it did not start is a worse
        # problem than the one being solved. Say what is in the way and let the operator decide.
        logger.error(
            "127.0.0.1:%d is already forwarded by another process, so this supervisor cannot take "
            "it over. Stop that tunnel and this will adopt the port on the next check -- until "
            "then the port survives a spin-down only as long as that process does.", local_port)
        return "occupied"

    logger.info("reconnecting: %s", plan.reason)
    assert plan.endpoint is not None
    forward.start(plan.endpoint, local_port, remote_port)

    # Give ssh a moment to bind before reporting, so the next pass does not immediately decide the
    # brand-new forward is unhealthy and rebuild it.
    for _ in range(20):
        await asyncio.sleep(0.5)
        if forwarding(local_port):
            logger.info("forward is up on 127.0.0.1:%d", local_port)
            return "connected"
        if not forward.alive():
            stderr = b""
            if forward.process is not None and forward.process.stderr is not None:
                with contextlib.suppress(Exception):
                    stderr = forward.process.stderr.read() or b""
            logger.error("ssh exited immediately: %s", stderr.decode("utf-8", "replace").strip())
            return "failed"

    logger.error("ssh is running but nothing is accepting on %d", local_port)
    return "failed"


def _maybe_serve(
    forward: Forward,
    local_port: int,
    serve_script: Path | None,
    cooldown: float,
    state: dict,
) -> str:
    """With the tunnel healthy, decide whether the pod still needs its model server started."""
    ready = backend_ready(local_port)
    launched_at = state.get("launched_at")
    plan = tunnel.serve_plan(
        enabled=serve_script is not None,
        tunnel_up=True,
        backend_ready=ready,
        launched_ago=None if launched_at is None else time.monotonic() - launched_at,
        cooldown=cooldown,
    )

    if plan.action == "none":
        if ready:
            # Clears the cooldown so a LATER failure can relaunch immediately rather than waiting
            # out a timer belonging to a launch that already succeeded.
            state.pop("launched_at", None)
        return "keep"
    if plan.action == "wait":
        logger.info("not relaunching: %s", plan.reason)
        return "loading"

    logger.warning("the tunnel is up but the backend is not answering; starting the model server")
    assert serve_script is not None and forward.endpoint is not None
    if launch_serve(forward.endpoint, serve_script):
        state["launched_at"] = time.monotonic()
        return "launched"
    return "failed"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-port", type=int, default=_default_local_port())
    parser.add_argument("--remote-port", type=int, default=8080)
    parser.add_argument("--interval", type=float, default=15.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument(
        "--serve-script", type=Path, default=None,
        help="local script to upload and run when the backend is not answering; OFF unless "
             "given, because it kills every process holding the pod's GPU")
    parser.add_argument("--serve-cooldown", type=float, default=900.0)
    args = parser.parse_args()

    if args.serve_script is not None and not args.serve_script.is_file():
        logger.error("no such serve script: %s", args.serve_script)
        return 2

    if not runpod_client.is_armed():
        logger.error(
            "pod control is not armed: this needs POD_CONTROL_ENABLED=true, RUNPOD_API_KEY and "
            "RUNPOD_POD_ID. It only READS the pod, but it reads it through the same client.")
        return 2

    logger.info(
        "supervising 127.0.0.1:%d -> pod:%d, checking every %.0fs. This never starts or stops the "
        "pod; spin-down owns that.", args.local_port, args.remote_port, args.interval)

    if args.serve_script is not None:
        logger.info(
            "will start the model server with %s when the backend stops answering, at most "
            "once every %.0fs", args.serve_script, args.serve_cooldown)

    forward = Forward()
    state: dict = {}
    try:
        while True:
            await check(forward, args.local_port, args.remote_port,
                        serve_script=args.serve_script,
                        serve_cooldown=args.serve_cooldown, state=state)
            if args.once:
                return 0
            await asyncio.sleep(args.interval)
    except KeyboardInterrupt:
        logger.info("stopping, and closing the forward with it")
        return 0
    finally:
        forward.stop()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
