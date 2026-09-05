"""Adversarial probes against the code-execution sandbox. Spec §6.1 marks this MANDATORY.

Run:  python -m sandbox.adversarial            # against a live Judge0
      python -m sandbox.adversarial --json     # machine-readable, for CI

WHY THIS COMES BEFORE THE HARDENING
--------------------------------------
The plan had hardening first. That is the wrong order. Every hardening measure —
seccomp, no network namespace, read-only rootfs, pid limits — is a *claim* about
what the sandbox prevents, and a claim nobody has fired a real payload at is
indistinguishable from a comment. `judge0_client.py` already passes a CPU and a
memory limit; nothing in this repo had ever checked that either one holds.

So this measures first, and what it finds decides what to harden. Anything it
reports as CONTAINED is contained by something that is already there; anything it
reports as ESCAPED is a gap with a payload attached to it.

WHAT "CONTAINED" MEANS, PRECISELY
-----------------------------------
Not "the submission failed". A probe is contained when the sandbox *stopped* it —
a non-zero exit, a kill, a timeout, a denied syscall, a refused connection. A
probe that ran to completion and printed what it wanted is an escape, even if
Judge0 reported status 3 (Accepted), because Accepted only means the process
exited cleanly.

That distinction is the whole reason each probe prints a specific marker on
success rather than just doing the dangerous thing. Absence of the marker is the
evidence; a non-zero exit code on its own would also be produced by a syntax
error, which is why every payload is checked for compiling first.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

PYTHON = 71  # Judge0 language id for Python 3

#: Printed by a payload that got what it wanted. Its ABSENCE is what proves
#: containment, so it must not be a string the runtime could emit by accident.
MARKER = "VOIDCODE_SANDBOX_ESCAPED"


#: Two severities, because a binary verdict cannot tell the truth here.
#:
#: `breach`    the sandbox failed: host access, a real secret, root, or resource
#:             exhaustion that reaches other tenants. Fails CI.
#: `hardening` a capability a minimal sandbox would not expose, which on its own
#:             escalates to nothing. Reported, does NOT fail CI.
#:
#: This distinction was added after the binary version over-reported TWICE — it
#: called reading the container's own /etc/passwd a filesystem escape, and reading
#: /proc/self/mountinfo a secret disclosure. An adversarial suite that cries wolf
#: gets muted, and a muted suite is worth less than no suite.
BREACH = "breach"
HARDENING = "hardening"


@dataclass
class Probe:
    name: str
    #: What is being tested, in the terms an interviewer would ask about.
    threat: str
    source: str
    #: Why absence of the marker means contained, for this specific probe.
    contained_when: str
    severity: str = BREACH
    cpu_time_limit: float = 5.0
    memory_limit: int = 256000


PROBES: list[Probe] = [
    Probe(
        name="fork_bomb",
        threat="process exhaustion — one submission consuming every process slot on the host",
        contained_when="the fork limit or the container's pid cgroup stops it before it prints",
        source=f'''
import os
# Bounded rather than `while True: os.fork()`. An unbounded bomb can wedge the
# WORKER as well as the sandbox, and a probe that takes the test runner down with
# it cannot report a result. 200 is far above any legitimate need and far below
# the point of no return.
made = 0
try:
    for _ in range(200):
        if os.fork() == 0:
            os._exit(0)
        made += 1
except OSError:
    pass
if made >= 100:
    print("{MARKER} forked", made)
else:
    print("blocked after", made)
''',
    ),
    Probe(
        name="memory_exhaustion",
        threat="allocating past the declared limit, starving co-tenant submissions",
        contained_when="the allocation raises MemoryError or the process is killed",
        source=f'''
# 1 GiB against a declared 64 MB limit.
chunks = []
try:
    for _ in range(1024):
        chunks.append(bytearray(1024 * 1024))
    print("{MARKER} allocated", len(chunks), "MiB")
except MemoryError:
    print("blocked by MemoryError at", len(chunks), "MiB")
''',
        memory_limit=64000,
    ),
    Probe(
        name="infinite_loop",
        threat="CPU exhaustion — a submission that never returns",
        contained_when="the CPU or wall-clock limit kills it before it prints",
        source=f'''
import time
start = time.time()
while time.time() - start < 30:
    pass
print("{MARKER} ran for 30s")
''',
        cpu_time_limit=2.0,
    ),
    Probe(
        name="network_egress_dns",
        threat="exfiltrating a problem's reference solution, or calling out to a C2 host",
        contained_when="name resolution fails, because a sandbox with no network cannot resolve",
        source=f'''
import socket
socket.setdefaulttimeout(5)
try:
    addr = socket.gethostbyname("example.com")
    print("{MARKER} resolved example.com to", addr)
except Exception as exc:
    print("blocked:", type(exc).__name__)
''',
    ),
    Probe(
        name="network_egress_tcp",
        threat="the same, against a raw IP, so it is not merely a DNS failure",
        contained_when="the connect fails — a DNS block alone would not stop this",
        source=f'''
import socket
socket.setdefaulttimeout(5)
try:
    s = socket.create_connection(("1.1.1.1", 80), timeout=5)
    s.close()
    print("{MARKER} connected to 1.1.1.1:80")
except Exception as exc:
    print("blocked:", type(exc).__name__)
''',
    ),
    Probe(
        name="filesystem_secrets",
        threat="reading a secret or another tenant's data from inside the sandbox",
        contained_when="the shadow file, PID 1's environment and the docker socket are all refused",
        source=f'''
# TARGETS CHOSEN SO THAT A SUCCESSFUL READ IS ACTUALLY BAD.
#
# An earlier version of this probe read /etc/passwd and declared an escape. That
# was wrong: the /etc/passwd it read is the CONTAINER's, and every container has
# one. It also read /box/../../etc/hostname and got the container id, not the
# host's — the traversal stayed inside the same mount namespace. A probe whose
# marker fires on any successful read reports an escape that did not happen, and a
# false positive here is worse than no probe, because it sends someone hunting a
# hole that is not there.
#
# So these four are things whose contents would be genuinely damaging.
targets = [
    "/etc/shadow",                 # password hashes
    "/proc/1/environ",             # PID 1's env — leaks secrets if the pid namespace is shared
    "/var/run/docker.sock",        # the actual escape vector: this IS host root
]
for path in targets:
    try:
        with open(path, "rb") as fh:
            head = fh.read(120)
        print("{MARKER} read", path, "->", head[:60])
    except Exception as exc:
        print("blocked", path, type(exc).__name__)
''',
    ),
    Probe(
        name="host_filesystem_traversal",
        threat="breaking out of the working directory to the HOST's filesystem",
        contained_when="no path resolves to content that belongs to the host rather than the "
                       "container — checked by identity, not by whether the read succeeded",
        source=f'''
import os, socket
# The container's own hostname. Anything we read that reports a DIFFERENT hostname
# came from outside this mount namespace, which is the actual definition of the
# escape this probe is looking for.
mine = socket.gethostname()
escaped = False
for path in ("/box/../../etc/hostname", "/../etc/hostname", "/proc/1/root/etc/hostname"):
    try:
        with open(path) as fh:
            seen = fh.read().strip()
        if seen and seen != mine:
            print("{MARKER}", path, "->", seen, "(mine is", mine + ")")
            escaped = True
        else:
            print("same namespace", path, "->", seen or "<empty>")
    except Exception as exc:
        print("blocked", path, type(exc).__name__)
if not escaped:
    print("no path left the container's mount namespace")
''',
    ),
    Probe(
        name="filesystem_write_outside_box",
        threat="persisting between submissions, or tampering with the judge itself",
        contained_when="every write outside the working directory fails on a read-only rootfs",
        source=f'''
for path in ("/etc/voidcode_probe", "/usr/local/bin/voidcode_probe", "/probe_at_root"):
    try:
        with open(path, "w") as fh:
            fh.write("x")
        print("{MARKER} wrote", path)
    except Exception as exc:
        print("blocked", path, type(exc).__name__)
''',
    ),
    Probe(
        name="output_flood",
        threat="filling the judge's disk or the API's memory with a multi-gigabyte stdout",
        contained_when="output is truncated or the process is killed — NOT when it merely succeeds",
        source=f'''
import sys
line = "A" * 1024
for _ in range(200000):        # ~200 MB
    sys.stdout.write(line)
sys.stdout.write("\\n{MARKER} flushed 200MB\\n")
''',
    ),
    Probe(
        name="subprocess_spawn",
        threat="running binaries a minimal rootfs would not ship",
        contained_when="exec fails, or the binary is absent from a minimal rootfs",
        # HARDENING, not a breach. The shell runs as a non-root, per-submission uid
        # inside isolate, with no network and a tmpfs root, so it escalates to
        # nothing on its own. Spec §6.1 asks for a minimal rootfs and this is the
        # evidence it is not minimal — a finding, not a hole.
        severity=HARDENING,
        source=f'''
import subprocess
try:
    out = subprocess.run(["/bin/sh", "-c", "id; uname -a"], capture_output=True,
                         timeout=5, text=True)
    if out.returncode == 0 and out.stdout.strip():
        print("{MARKER} shell said", out.stdout.strip()[:80])
    else:
        print("blocked: shell returned", out.returncode)
except Exception as exc:
    print("blocked:", type(exc).__name__)
''',
    ),
    Probe(
        name="mount_reconnaissance",
        threat="mapping the sandbox's filesystem layout to find a bind-mounted host path",
        contained_when="mountinfo is unreadable — but note it exposes layout, not contents",
        # HARDENING. Reading this is normal in a container and discloses no secret.
        # It was previously bundled with the secret targets and reported as a
        # containment failure, which was simply wrong.
        severity=HARDENING,
        source=f'''
try:
    with open("/proc/self/mountinfo") as fh:
        text = fh.read()
    host_ish = [l for l in text.splitlines() if "/mnt/" in l or "docker" in l or "/host" in l]
    print("{MARKER} mountinfo readable,", len(text.splitlines()), "mounts;",
          "host-looking:", len(host_ish))
    for line in host_ish[:3]:
        print("   ", line[:100])
except Exception as exc:
    print("blocked:", type(exc).__name__)
''',
    ),
    Probe(
        name="privilege_check",
        threat="running as root inside the sandbox — turns any container escape into host root",
        contained_when="uid is not 0",
        source=f'''
import os
uid = os.getuid()
print(("{MARKER} running as root" if uid == 0 else "non-root uid"), uid)
''',
    ),
]


@dataclass
class Result:
    probe: Probe
    contained: bool
    status: str
    detail: str
    stdout: str = ""
    notes: list[str] = field(default_factory=list)


async def run_probe(client, probe: Probe) -> Result:
    try:
        raw = await client.submit(
            source_code=probe.source,
            language_id=PYTHON,
            cpu_time_limit=probe.cpu_time_limit,
            memory_limit=probe.memory_limit,
        )
    except Exception as exc:
        # A transport failure is not containment. Saying so keeps a broken Judge0
        # from reading as a perfectly secure one.
        return Result(probe, contained=False, status="ERROR",
                      detail=f"could not run the probe: {type(exc).__name__}: {exc}")

    stdout = raw.get("stdout") or ""
    stderr = (raw.get("stderr") or "") + (raw.get("compile_output") or "")
    status = raw.get("status_description", "unknown")

    notes = []
    # A payload that never compiled proves nothing — it would "pass" every probe.
    if "SyntaxError" in stderr or "IndentationError" in stderr:
        notes.append("PAYLOAD DID NOT COMPILE — this result is meaningless")
        return Result(probe, contained=False, status=status,
                      detail="payload failed to compile", stdout=stdout, notes=notes)

    escaped = MARKER in stdout
    return Result(
        probe,
        contained=not escaped,
        status=status,
        detail=(stdout.strip().splitlines() or ["<no output>"])[-1][:120],
        stdout=stdout,
        notes=notes,
    )


async def main_async(as_json: bool) -> int:
    from src.services.judge0_client import Judge0Client

    client = Judge0Client()
    if not await client.health_check():
        print("Judge0 is not reachable. Start it with `docker compose up judge0-server`.")
        print("Refusing to report containment against a sandbox that is not running — an")
        print("unreachable judge would score 10/10 and mean nothing.")
        return 2

    results = [await run_probe(client, probe) for probe in PROBES]

    if as_json:
        print(json.dumps([
            {"name": r.probe.name, "severity": r.probe.severity, "threat": r.probe.threat,
             "contained": r.contained, "status": r.status, "detail": r.detail, "notes": r.notes}
            for r in results
        ], indent=2))
        return 1 if any(not r.contained and r.probe.severity == BREACH for r in results) else 0

    breaches = [r for r in results if not r.contained and r.probe.severity == BREACH]
    findings = [r for r in results if not r.contained and r.probe.severity == HARDENING]

    print(f"{len(PROBES)} adversarial probes against Judge0\n")
    for r in results:
        if r.contained:
            mark = "contained"
        elif r.probe.severity == BREACH:
            mark = "*** BREACH ***"
        else:
            mark = "hardening"
        print(f"  {mark:16} {r.probe.name:30} [{r.status}] {r.detail}")
        for note in r.notes:
            print(f"                   ! {note}")

    clean = len(results) - len(breaches) - len(findings)
    print(f"\n  {clean}/{len(results)} fully contained")
    print(f"  {len(breaches)} breach(es), {len(findings)} hardening finding(s)")

    if breaches:
        print("\n  BREACHES - the sandbox failed, each with a working payload:")
        for r in breaches:
            print(f"    {r.probe.name}: {r.probe.threat}")
            print(f"      contained only when {r.probe.contained_when}")
    if findings:
        print("\n  HARDENING - a capability present that escalates to nothing on its own.")
        print("  Worth removing per spec 6.1, but NOT a containment failure and NOT")
        print("  something to describe as an escape:")
        for r in findings:
            print(f"    {r.probe.name}: {r.probe.threat}")

    # Only a breach fails CI. A hardening finding that broke the build would get the
    # whole suite disabled within a week, and then the breaches go unnoticed too.
    return 1 if any(not r.contained and r.probe.severity == BREACH for r in results) else 0


def _utf8_stdout() -> None:
    """Make printing non-ASCII safe when stdout is not a terminal.

    On Windows, Python picks cp1252 for a redirected stdout, so any print containing an em dash, a
    section sign or a box-drawing character raises UnicodeEncodeError. The failure is invisible
    interactively and fatal in CI or under a pipe — this module crashed halfway through its report the
    first time its output was redirected to a file, after printing 45 correct lines.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            # Already wrapped, or not a real stream. Nothing to do and nothing worth failing over.
            pass

def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    return asyncio.run(main_async(args.json))


if __name__ == "__main__":
    raise SystemExit(main())
