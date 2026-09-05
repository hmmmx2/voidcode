"""
Judge0 Client Service

Encapsulates all communication with the Judge0 CE API.
Uses httpx for async HTTP requests with base64 encoding for safe
transmission of source code containing special characters.

Uses async submit + poll pattern (NOT ?wait=true) for reliability.
"""

import asyncio
import base64
import logging
import os

import httpx

logger = logging.getLogger(__name__)

JUDGE0_BASE_URL = os.environ.get("JUDGE0_BASE_URL", "http://localhost:2358")

# Judge0's own authentication. Sent as `X-Auth-Token` when set, matching the
# `AUTHN_HEADER`/`AUTHN_TOKEN` pair configured on the Judge0 container.
#
# WHY THIS MATTERS MORE HERE THAN ON A NORMAL SERVICE. Judge0 exists to run
# untrusted code, and it runs `privileged: true` because isolate needs it. Reached
# without a token, `POST /submissions` is an unauthenticated arbitrary-code-
# execution endpoint on a privileged container. `docker-compose.yml` used to
# publish port 2358 to the host with no token at all — safe only for as long as
# the host was a laptop.
#
# Empty by default so local development needs no setup, and Judge0 ignores the
# header when it is not configured to require one.
JUDGE0_AUTH_TOKEN = os.environ.get("JUDGE0_AUTH_TOKEN", "")

DEFAULT_CPU_TIME_LIMIT = 5       # seconds
DEFAULT_MEMORY_LIMIT = 256000    # KB (256MB)

# ── Limits sent explicitly, rather than left to the server's defaults ────────
#
# WHY THESE ARE HERE AT ALL. `sandbox/adversarial.py` found that a fork bomb, an
# output flood and a `time.sleep(25)` were all stopped — and every one of them was
# stopped by a JUDGE0 DEFAULT that this client never set. `GET /config_info` on the
# running instance reports `max_processes_and_or_threads: 60`, `max_file_size:
# 1024`, `enable_network: false`. Good values, none of them ours.
#
# A security limit inherited from a server default is a limit that changes when
# somebody edits an unrelated deployment. Sending them means the request states
# what it needs, and a misconfigured Judge0 fails our submission instead of
# silently widening the sandbox.

#: Wall clock, distinct from CPU time. A submission that sleeps burns no CPU, so
#: `cpu_time_limit` alone does not stop it — it just holds a worker. Measured:
#: `time.sleep(25)` against a 2 s CPU limit was killed at ~12.5 s by Judge0's own
#: wall default. This makes that bound ours.
WALL_TIME_MARGIN = 2.0
MAX_WALL_TIME_LIMIT = 20.0       # the instance's `max_wall_time_limit`

#: Processes and threads. The instance's default is 60; the fork-bomb probe was
#: refused after 58 attempts, which is that limit being hit. 30 is still far above
#: anything a solution to a catalogue problem needs.
MAX_PROCESSES = 30

#: KB a submission may write to any single file, which is also what bounds stdout.
#: The 200 MB output flood probe died against this.
MAX_FILE_SIZE_KB = 1024

#: KB of stack. Bounds runaway recursion as a stack overflow rather than letting it
#: consume the whole memory allowance.
STACK_LIMIT_KB = 64000
SUBMIT_TIMEOUT = 10              # timeout for the initial submit POST
POLL_TIMEOUT = 5                 # timeout for each poll GET
POLL_INTERVAL = 0.5              # seconds between polls
MAX_POLL_WAIT = 30               # max total seconds to wait for result


class Judge0Client:
    """Async client for Judge0 CE API."""

    def __init__(self, base_url: str = JUDGE0_BASE_URL, auth_token: str = JUDGE0_AUTH_TOKEN):
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token

    @property
    def _headers(self) -> dict[str, str]:
        """Auth header for every call, or none when no token is configured.

        A property rather than a value set in __init__ so the three call sites cannot each decide
        whether to send it — one of them forgetting is a silently unauthenticated request that
        works fine until Judge0 starts requiring the token.
        """
        return {"X-Auth-Token": self.auth_token} if self.auth_token else {}

    async def submit(
        self,
        source_code: str,
        language_id: int,
        stdin: str | None = None,
        cpu_time_limit: float = DEFAULT_CPU_TIME_LIMIT,
        memory_limit: int = DEFAULT_MEMORY_LIMIT,
    ) -> dict:
        """
        Submit code to Judge0 using async submit + poll.

        Step 1: POST /submissions (no wait=true) → get token
        Step 2: Poll GET /submissions/{token} until status_id >= 3

        Returns parsed response dict with fields:
            stdout, stderr, compile_output, status_id,
            status_description, time, memory, exit_code

        THERE IS NO `expected_output` PARAMETER, deliberately.

        Judge0 accepts one and will compare for you, returning status 4 (Wrong
        Answer) instead of 3. We never used that verdict — the router always
        re-compared in Python — so the only thing passing it achieved was
        sending every expected answer to a third-party service on every run.

        Removing it also collapses grading semantics to a single place:
        `routers/execution.case_passed`. With both mechanisms live, "why did
        this pass" had two possible answers depending on which comparison you
        happened to read, and only one of them handled `\\r\\n`.
        """
        payload = {
            "source_code": base64.b64encode(source_code.encode()).decode(),
            "language_id": language_id,
            "cpu_time_limit": cpu_time_limit,
            "memory_limit": memory_limit,
            # See the constants above: each of these was already being enforced by a
            # Judge0 default that this client never asked for.
            "wall_time_limit": min(cpu_time_limit * 2 + WALL_TIME_MARGIN, MAX_WALL_TIME_LIMIT),
            "max_processes_and_or_threads": MAX_PROCESSES,
            "max_file_size": MAX_FILE_SIZE_KB,
            "stack_limit": STACK_LIMIT_KB,
            # Explicitly off. The instance defaults to false, but `allow_enable_network`
            # is TRUE on it, so a submission that set this would get egress. Nothing
            # here passes user input into the payload, so that is not reachable today —
            # this states the requirement rather than depending on it staying
            # unreachable. `ALLOW_ENABLE_NETWORK=false` on the container is the other
            # half, so the capability is off at both ends.
            "enable_network": False,
        }

        if stdin is not None:
            payload["stdin"] = base64.b64encode(stdin.encode()).decode()

        submit_url = f"{self.base_url}/submissions?base64_encoded=true"

        # ── Step 1: Submit and get token ─────────────────────────────
        async with httpx.AsyncClient(timeout=SUBMIT_TIMEOUT) as client:
            response = await client.post(submit_url, json=payload, headers=self._headers)
            response.raise_for_status()
            token = response.json().get("token")
            if not token:
                raise RuntimeError("Judge0 did not return a submission token")

        logger.debug(f"Submitted to Judge0, token={token}")

        # ── Step 2: Poll until done ──────────────────────────────────
        poll_url = f"{self.base_url}/submissions/{token}?base64_encoded=true"
        deadline = asyncio.get_event_loop().time() + MAX_POLL_WAIT

        async with httpx.AsyncClient(timeout=POLL_TIMEOUT) as client:
            while True:
                poll_resp = await client.get(poll_url, headers=self._headers)
                poll_resp.raise_for_status()
                raw = poll_resp.json()

                status_id = raw.get("status", {}).get("id", 0)
                # status_id < 3 means still In Queue (1) or Processing (2)
                if status_id >= 3:
                    return self._parse_response(raw)

                if asyncio.get_event_loop().time() >= deadline:
                    raise TimeoutError(
                        f"Judge0 submission {token} did not finish within {MAX_POLL_WAIT}s"
                    )

                await asyncio.sleep(POLL_INTERVAL)

    def _parse_response(self, raw: dict) -> dict:
        """Parse Judge0 response, decoding base64 fields."""

        def decode_field(val: str | None) -> str | None:
            if val is None:
                return None
            try:
                return base64.b64decode(val).decode("utf-8", errors="replace")
            except Exception:
                return val

        return {
            "stdout": decode_field(raw.get("stdout")),
            "stderr": decode_field(raw.get("stderr")),
            "compile_output": decode_field(raw.get("compile_output")),
            "status_id": raw.get("status", {}).get("id"),
            "status_description": raw.get("status", {}).get("description", "Unknown"),
            "time": raw.get("time"),
            "memory": raw.get("memory"),
            "exit_code": raw.get("exit_code"),
        }

    async def health_check(self) -> bool:
        """Check if Judge0 is reachable."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/about", headers=self._headers)
                return resp.status_code == 200
        except Exception:
            return False


# Singleton instance
judge0_client = Judge0Client()
