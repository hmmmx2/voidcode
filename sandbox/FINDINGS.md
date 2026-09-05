# Sandbox containment — measured, 2026-08-10

Produced by `python -m sandbox.adversarial` against Judge0 CE 1.13.1 running under
`docker-compose.yml`, on WSL2. **Re-run it after any change to the Judge0 image, its compose
service, or `judge0_client.py` limits** — every line below is a measurement, not a property of the
design, and it expires the moment the deployment changes.

```
12 probes:  10 fully contained,  0 breaches,  2 hardening findings
```

## What Judge0 + isolate already contain

None of this was added by us; all of it was verified rather than assumed. Before this suite existed,
`judge0_client.py` passed a CPU and a memory limit and **nothing in the repo had ever checked that
either one held.**

| Probe | Outcome | Stopped by |
|---|---|---|
| `fork_bomb` | contained | forks refused after 58 of 200 — *Judge0's default; see the next section* |
| `memory_exhaustion` | contained | killed — NZEC against a 64 MB limit |
| `infinite_loop` | contained | Time Limit Exceeded at 2 s CPU |
| `network_egress_dns` | contained | `gaierror` — no resolver |
| `network_egress_tcp` | contained | `OSError` to a raw IP, so not merely a DNS block |
| `filesystem_secrets` | contained | `/etc/shadow` denied, `/proc/1/environ` and `/var/run/docker.sock` absent |
| `host_filesystem_traversal` | contained | no path resolved outside the mount namespace |
| `filesystem_write_outside_box` | contained | `PermissionError` on a read-only rootfs |
| `output_flood` | contained | killed partway through 200 MB |
| `privilege_check` | contained | non-root, and a **different ephemeral uid per submission** |

The absent docker socket is the one that matters most: reaching it is host root, and it is not there.

## Hardening applied, and how it was verified

The first run showed all ten limits holding — and **every one was being enforced by a Judge0 default
that `judge0_client.py` never sent.** `GET /config_info` on the live instance confirmed it:
`max_processes_and_or_threads: 60`, `max_file_size: 1024`, `enable_network: false`. Good values,
none of them ours. A security limit inherited from a server default is one that changes when
somebody edits an unrelated deployment.

They are now sent explicitly, and the observed behaviour moved to match — which is the only evidence
that a configuration change did anything:

| probe | before | after | what the request now says |
|---|---|---|---|
| `fork_bomb` | refused after 58 | refused after **28** | `max_processes_and_or_threads: 30` |
| `time.sleep(25)` at `cpu_limit=2` | killed at 12.5 s | killed at **5.2 s** | `wall_time_limit: 6` |

The sleep case is the one worth keeping in mind: **`cpu_time_limit` does not stop a sleeping
process.** It burns no CPU, so nothing in the CPU accounting notices; it just holds a worker. Only a
wall-clock bound catches it, and until now that bound was Judge0's rather than ours.

`ALLOW_ENABLE_NETWORK=false` was also set on the container. Egress was already blocked, but
`allow_enable_network` was **true**, so a submission that asked for network would have been granted
it. Nothing passes user input into the payload today, so it was not reachable — the switch is now
removed at both ends rather than left depending on that staying true.

## Hardening findings — capabilities, not breaches

Neither escalates to anything on its own. Both are worth closing under spec §6.1's minimal-rootfs
requirement, and neither should be described as an escape.

**`subprocess_spawn`** — `/bin/sh` is present and executes. It runs as the same non-root ephemeral
uid, inside isolate, with no network and a tmpfs root, so it grants no capability the Python process
did not already have. It is evidence the rootfs is not minimal.

**`mount_reconnaissance`** — `/proc/self/mountinfo` is readable and names host paths such as
`/data/docker/containers/<id>/…`. That discloses *layout*, not *contents*; the traversal probe
proved no such path can actually be read from inside. Reconnaissance value only.

## Two false positives this suite reported before it was trusted

Recorded because they are the reason it now has severity tiers, and because both would have sent
someone hunting a hole that was not there.

1. It read `/etc/passwd` and declared a filesystem escape. That file is the **container's own** — every
   container has one. Nothing had escaped.
2. It read `/box/../../etc/hostname`, got `1289f8b564c6`, and called it host access. That is the
   container id; the host is `Alwin`. The traversal never left the mount namespace.

Both came from the same flaw: a marker that fired on *any* successful read. The fix was to choose
targets whose contents would be genuinely damaging, and to check the traversal by **identity** —
comparing the hostname read against the container's own — rather than by whether the read succeeded.

A binary contained/escaped verdict could not express "this is real but it is not a breach", which is
why `BREACH` and `HARDENING` exist and why only the former fails CI. A suite that cries wolf gets
muted, and a muted suite is worth less than no suite at all.

## What is still not tested

Stated so the coverage is not mistaken for completeness:

- **Only Python.** Java and C++ are accepted by the API and unprobed; a JVM has a different syscall
  surface and its own memory accounting.
- **No concurrent probes.** Every result here is a single submission against an idle judge. Whether
  one submission can starve another is a different question and needs load.
- **No syscall-level assertion.** Containment is inferred from behaviour, not from a seccomp profile
  that names what is denied. Spec §6.1 asks for deny-by-default; this measures the effect, not the
  policy.
- **gVisor and Kata are not in use.** §6.1 names them. Execution is delegated to Judge0 CE with
  isolate, which is a namespace-and-cgroup sandbox, not a kernel-isolating one. A kernel exploit
  reachable from Python would not be stopped by anything measured above.
