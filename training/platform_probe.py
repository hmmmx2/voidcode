"""P0: everything about a rented instance that the rest of the plan depends on.

WHY THIS IS A SCRIPT AND NOT A SESSION OF POKING AROUND
-------------------------------------------------------
The first thing anyone does on a new GPU box is type commands until they feel oriented. That is
fine when the box is free. Here the meter runs at up to $1.76/hr, and the questions are known in
advance, so they should be asked by one command that emits a machine-readable record.

It is also the only way a **tier comparison** is worth anything, and every provider has one. On
RunPod it is Community Cloud against Secure Cloud: the same GPU model, but Community is
third-party multitenant hardware where "availability varies by provider", so the interconnect
you get is not a property of the GPU name. Running *the same probe* on both and diffing the JSON
is the measurement; running different ad-hoc commands on each is not.

This is provider-agnostic on purpose. It was written against Thunder Compute, where the same
question was prototyping (a virtualisation layer that breaks profilers, MPS and managed memory)
against production. Nothing in it assumed that vendor, which is why the switch to RunPod cost
nothing here.

WHAT IT ANSWERS, AND WHAT EACH ANSWER DECIDES
----------------------------------------------
  nccl busbw           -> which parallelism strategies are viable at all (the routing table)
  nccl transport       -> whether P2P is real or staged through host memory
  topology, PCIe link  -> explains the bandwidth rather than just reporting it
  profiler availability-> whether the kernel phase can report occupancy or only wall clock
  device properties    -> compute capability, so FP8 support is confirmed not assumed
  estimator check      -> whether the memory audit's model holds on the rented card

Every field is `null` when a probe could not run, never a plausible-looking default. A missing
number must stay visibly missing: the whole plan routes off these values, and a fabricated one
would route it wrongly and silently.

    python -m training.platform_probe --spec a40_x2_community --out docs/probe-a40_x2_community.json

Nothing here needs the training stack. torch is used when present and its absence is recorded
rather than fatal, so the script also runs on a fresh box before any pip install.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from typing import Any

GIB = 1024**3


# ── shelling out, carefully ───────────────────────────────────────────────────────────────────


def run(cmd: list[str], timeout: int = 120) -> dict[str, Any]:
    """Run a command, capturing everything, never raising.

    A probe that dies because one tool is missing tells you nothing about the other twelve.
    """
    if shutil.which(cmd[0]) is None:
        return {"ok": False, "reason": "not_installed", "cmd": " ".join(cmd)}
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "cmd": " ".join(cmd),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "timeout", "cmd": " ".join(cmd)}
    except Exception as exc:  # noqa: BLE001 - a probe must not take the run down
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}", "cmd": " ".join(cmd)}


# ── the host ──────────────────────────────────────────────────────────────────────────────────


#: RunPod publishes the pod's identity in the environment. Worth recording because ``--spec`` is
#: hand-typed and is therefore the one field in the record that can be wrong, while these cannot.
#: The datacenter matters too: the Community/Secure comparison is only fair between two pods, and
#: knowing where each ran is how a surprising diff gets explained rather than argued about.
#:
#: **An allowlist, deliberately.** Sweeping every ``RUNPOD_*`` variable would be shorter and would
#: eventually write an API key into a JSON file that goes into git. Identity only; no credentials.
POD_IDENTITY_VARS = (
    "RUNPOD_POD_ID",
    "RUNPOD_POD_HOSTNAME",
    "RUNPOD_DC_ID",
    "RUNPOD_GPU_COUNT",
    "RUNPOD_CPU_COUNT",
    "RUNPOD_MEM_GB",
)


def probe_pod_identity() -> dict[str, str]:
    return {name: os.environ[name] for name in POD_IDENTITY_VARS if os.environ.get(name)}


def probe_host() -> dict[str, Any]:
    smi = run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version,pcie.link.width.current,pcie.link.gen.current", "--format=csv,noheader"])
    gpus: list[dict[str, str]] = []
    if smi.get("ok"):
        for line in smi["stdout"].strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 5:
                gpus.append(
                    {
                        "name": parts[0],
                        "memory_total": parts[1],
                        "driver": parts[2],
                        "pcie_width_current": parts[3],
                        "pcie_gen_current": parts[4],
                    }
                )

    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "pod": probe_pod_identity(),
        "gpus": gpus,
        # `topo -m` is what explains a bandwidth number. NV# means NVLink, PIX/PXB/SYS are PCIe
        # paths of decreasing closeness; SYS crossing a socket is the slow one.
        "topology": run(["nvidia-smi", "topo", "-m"]).get("stdout"),
    }


# ── torch's view, which is the one training will actually get ─────────────────────────────────


def probe_torch() -> dict[str, Any]:
    try:
        import torch
    except ImportError:
        return {"available": False, "reason": "torch not installed"}

    out: dict[str, Any] = {
        "available": True,
        "version": torch.__version__,
        "cuda": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version(),
        "device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0,
        "devices": [],
        "p2p": [],
    }
    if not torch.cuda.is_available():
        out["reason"] = "torch.cuda.is_available() is False"
        return out

    for i in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(i)
        capability = f"{props.major}.{props.minor}"
        out["devices"].append(
            {
                "index": i,
                "name": props.name,
                "total_memory_gib": round(props.total_memory / GIB, 3),
                "capability": capability,
                "multi_processor_count": props.multi_processor_count,
                # >= sm_89 (Ada/Hopper/Blackwell) is the FP8 threshold. The A40 is sm_86 and will
                # report False, which is correct and expected: FP8 work runs on the local Blackwell
                # card instead. Recorded rather than assumed either way.
                "fp8_capable": (props.major, props.minor) >= (8, 9),
            }
        )

    # Peer-to-peer between every ordered pair. False everywhere means collectives stage through
    # host memory, which is the difference between ZeRO-3 being viable and being a trap.
    for i in range(torch.cuda.device_count()):
        for j in range(torch.cuda.device_count()):
            if i == j:
                continue
            try:
                out["p2p"].append({"from": i, "to": j, "can_access": bool(torch.cuda.can_device_access_peer(i, j))})
            except Exception as exc:  # noqa: BLE001
                out["p2p"].append({"from": i, "to": j, "error": str(exc)})

    return out


# ── NCCL: the number the plan routes on ───────────────────────────────────────────────────────


BUSBW_ROUTES = [
    (20.0, "ZeRO-2 and ZeRO-3 both viable"),
    (5.0, "ZeRO-2 / FSDP2 SHARD_GRAD_OP only, high gradient accumulation"),
    (0.0, "multi-GPU is net negative - report that as the finding"),
]


def parse_nccl(stdout: str) -> dict[str, Any]:
    """Pull the bus bandwidth at large sizes out of nccl-tests output.

    The columns are size, count, type, redop, root, then time/algbw/busbw for in-place and
    out-of-place. **busbw is the one that matters** — algbw does not account for the ring's
    traffic pattern, so quoting it flatters the interconnect.

    Sizes below ~256 MB are latency-bound and say nothing about bandwidth, which is why the
    plan asks for 256 MB and above specifically.
    """
    rows: list[dict[str, float]] = []
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) < 11 or not parts[0].isdigit():
            continue
        try:
            size = int(parts[0])
            # out-of-place busbw is column 7 in the standard layout
            busbw = float(parts[7])
            rows.append({"size_bytes": size, "size_mib": round(size / 1024**2, 2), "busbw_gbps": busbw})
        except (ValueError, IndexError):
            continue

    large = [r for r in rows if r["size_bytes"] >= 256 * 1024**2]
    peak = max((r["busbw_gbps"] for r in large), default=None)

    route = None
    if peak is not None:
        route = next(label for threshold, label in BUSBW_ROUTES if peak > threshold)

    return {
        "rows": rows,
        "peak_busbw_gbps_at_256mib_plus": peak,
        "route": route,
        "note": None if large else "no rows at or above 256 MiB - rerun with -e 1G",
    }


#: nccl-tests from 8 B to 1 GiB on two ranks is minutes, not hours. A run still going after this
#: has hung rather than slowed, and the useful outcome is a recorded failure, not a longer wait.
NCCL_TIMEOUT_S = 900


def _nccl_failed(reason: str, diagnosis: str, argv: list[str]) -> dict[str, Any]:
    """A failure that keeps ``parse_nccl``'s shape, so nothing downstream needs a special case.

    Every measured field stays ``None``. The alternative -- omitting them -- makes a crashed run
    and an unmeasured one indistinguishable to whatever reads the JSON later.
    """
    return {
        **parse_nccl(""),
        "ok": False,
        "failed": reason,
        "diagnosis": diagnosis,
        "cmd": " ".join(argv),
        # parse_nccl's note is about output shape; nothing was output, so it would mislead.
        "note": None,
    }


def probe_nccl(nccl_tests_dir: str | None, gpus: int) -> dict[str, Any]:
    if gpus < 2:
        return {"skipped": "fewer than 2 GPUs - a collective needs two ranks"}

    binary = None
    if nccl_tests_dir:
        candidate = os.path.join(nccl_tests_dir, "build", "all_reduce_perf")
        if os.path.exists(candidate):
            binary = candidate
    if binary is None:
        binary = shutil.which("all_reduce_perf")
    if binary is None:
        return {
            "skipped": "all_reduce_perf not found",
            "how_to_fix": "git clone https://github.com/NVIDIA/nccl-tests && cd nccl-tests && make -j",
        }

    env = dict(os.environ, NCCL_DEBUG="INFO")
    argv = [binary, "-b", "8", "-e", "1G", "-f", "2", "-g", str(gpus)]

    # Shelled out here rather than through `run()` because this one needs a custom env and a
    # long timeout -- but it must keep `run()`'s promise not to raise. A hung collective is the
    # likeliest failure on a multi-GPU pod, and letting it propagate would cost the disk,
    # profiler and matmul probes as well: a paid pod that returns a traceback.
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=NCCL_TIMEOUT_S, env=env)
    except subprocess.TimeoutExpired:
        return _nccl_failed(
            f"all_reduce_perf did not finish within {NCCL_TIMEOUT_S}s",
            "a hung collective is usually P2P or a half-configured fabric; rerun by hand with "
            "NCCL_DEBUG=INFO and watch which transport it selects before it stalls",
            argv,
        )
    except OSError as exc:
        return _nccl_failed(
            f"{type(exc).__name__}: {exc}",
            "the binary exists but would not execute -- usually built against a different NCCL, "
            "or not marked executable. Rebuild in the pod: cd nccl-tests && make -j",
            argv,
        )
    except Exception as exc:  # noqa: BLE001 - a probe must not take the run down
        return _nccl_failed(f"{type(exc).__name__}: {exc}", "unexpected; see cmd and rerun by hand", argv)

    combined = proc.stdout + proc.stderr

    # NCCL announces its transport choice in the debug output. "via P2P", "via SHM" and
    # "via NET" mean radically different things for the same measured number, and the
    # selection is what makes the bandwidth explainable.
    transports = sorted(set(re.findall(r"via\s+(P2P|SHM|NET/\S+|direct\s+\S+)", combined)))

    return {
        "ok": proc.returncode == 0,
        "transports_selected": transports,
        **parse_nccl(proc.stdout),
        "stderr_tail": combined[-2000:] if proc.returncode != 0 else None,
    }


# ── what the platform forbids ─────────────────────────────────────────────────────────────────


def probe_profilers() -> dict[str, Any]:
    """Do the profiling tools work, or only exist?

    Some providers virtualise the GPU and quietly break the profiling path -- Thunder Compute's
    compatibility page says to "use application-level logging, framework metrics, or benchmark
    scripts instead" of GPU profilers. Whether a given RunPod host differs is unmeasured, and it
    decides whether the kernel phase can report occupancy or only wall clock.

    Presence and *function* are probed separately, because a binary that exists and refuses to
    attach is the failure mode that wastes an afternoon.
    """
    result: dict[str, Any] = {
        "ncu_present": shutil.which("ncu") is not None,
        "nsys_present": shutil.which("nsys") is not None,
        "torch_profiler_works": None,
        "torch_profiler_error": None,
    }

    try:
        import torch
        from torch.profiler import ProfilerActivity, profile

        if torch.cuda.is_available():
            x = torch.randn(512, 512, device="cuda")
            with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
                (x @ x).sum().item()
            events = prof.key_averages()
            # Presence of CUDA events is the real test — the profiler can "work" while
            # reporting nothing from the device, which is the virtualisation signature.
            result["torch_profiler_works"] = any(getattr(e, "device_time_total", 0) for e in events)
            result["torch_profiler_cuda_events"] = sum(
                1 for e in events if getattr(e, "device_time_total", 0)
            )
        else:
            result["torch_profiler_error"] = "cuda unavailable"
    except Exception as exc:  # noqa: BLE001
        result["torch_profiler_works"] = False
        result["torch_profiler_error"] = f"{type(exc).__name__}: {exc}"

    return result


# ── storage, because a pod with the wrong disk wastes the whole session ────────────────────────


#: Roughly what this plan downloads and keeps on disk, so the free-space check means something.
#: Qwen2.5-7B-Instruct bf16 is ~15 GB, Qwen2.5-Coder-1.5B ~3 GB, and the training stack
#: (torch, vllm, deepspeed, transformer-engine) lands around 10 GB installed.
WORKING_SET_GIB = 30


def probe_disk() -> dict[str, Any]:
    """Where the space is, and whether the working set fits.

    Worth a probe rather than a glance because the failure is late and expensive: a container
    disk sized for a hello-world image accepts the pod, accepts the pip install, and then runs out
    partway through a 15 GB weight download -- after you have paid for the spin-up and the
    install.

    RunPod separates an ephemeral container disk from a persistent volume, conventionally mounted
    at /workspace. **Only the volume survives a stop/start**, so a model cached to the container
    disk is re-downloaded every time the pod restarts, silently and at full cost. Reporting the
    mount points is how you find out which one you actually landed in before relying on it.
    """
    paths = ["/", "/workspace", "/root", os.path.expanduser("~")]
    seen: dict[str, dict[str, Any]] = {}

    for path in paths:
        if not os.path.isdir(path):
            continue
        try:
            usage = shutil.disk_usage(path)
        except OSError as exc:
            seen[path] = {"error": str(exc)}
            continue
        seen[path] = {
            "total_gib": round(usage.total / GIB, 2),
            "free_gib": round(usage.free / GIB, 2),
            "fits_working_set": usage.free / GIB >= WORKING_SET_GIB,
        }

    workspace = seen.get("/workspace")
    root = seen.get("/")
    # Same total on both usually means /workspace is not a separate mount -- i.e. there is no
    # persistent volume and everything is on the ephemeral container disk.
    workspace_is_separate = None
    if workspace and root and "total_gib" in workspace and "total_gib" in root:
        workspace_is_separate = workspace["total_gib"] != root["total_gib"]

    return {
        "working_set_gib_assumed": WORKING_SET_GIB,
        "mounts": seen,
        "workspace_present": "/workspace" in seen,
        "workspace_is_separate_mount": workspace_is_separate,
        "hf_home": os.environ.get("HF_HOME"),
        "hf_hub_cache": os.environ.get("HUGGINGFACE_HUB_CACHE"),
    }


# ── a throughput floor, so the tiers are comparable on compute too ────────────────────────────


def probe_matmul(seconds: float = 3.0) -> dict[str, Any]:
    """Sustained BF16 matmul TFLOP/s on device 0.

    Not a benchmark of the plan's workload -- a sanity anchor. If two tiers, or two hosts of the
    same GPU model, differ on *compute* as well as on interconnect, every throughput comparison
    between phases run on different pods is confounded. This is the cheapest way to find out, and
    on shared multitenant hardware it is the check most worth having.
    """
    try:
        import torch
    except ImportError:
        return {"skipped": "torch not installed"}
    if not torch.cuda.is_available():
        return {"skipped": "cuda unavailable"}

    n = 8192
    a = torch.randn(n, n, device="cuda", dtype=torch.bfloat16)
    b = torch.randn(n, n, device="cuda", dtype=torch.bfloat16)

    for _ in range(3):
        a @ b
    torch.cuda.synchronize()

    iters = 0
    start = time.perf_counter()
    while time.perf_counter() - start < seconds:
        a @ b
        iters += 1
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - start

    flops = 2 * n**3 * iters
    return {
        "matrix": n,
        "dtype": "bfloat16",
        "iterations": iters,
        "seconds": round(elapsed, 3),
        "tflops": round(flops / elapsed / 1e12, 2),
    }


# ── assembly ──────────────────────────────────────────────────────────────────────────────────


def _guarded(fn: Any, *args: Any) -> dict[str, Any]:
    """Run one probe so that its failure costs only itself.

    The pod is metered and the probes are independent: there is no reason a CUDA fault in the
    matmul floor should cost the disk layout, which is the finding most likely to change what you
    do next. Failure is recorded in the same record as everything else, under a key a reader
    cannot mistake for a measurement.
    """
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - the whole point is that nothing escapes
        return {"probe_failed": f"{type(exc).__name__}: {exc}"}


def collect(spec: str, nccl_tests_dir: str | None) -> dict[str, Any]:
    host = _guarded(probe_host)
    torch_info = _guarded(probe_torch)
    # Both fall back cleanly: a failed probe has neither key, so this reads 0 rather than raising.
    gpus = int(torch_info.get("device_count") or len(host.get("gpus") or []))

    return {
        "schema": 1,
        # Which configuration produced these numbers. The plan's reporting rule depends on every
        # measurement carrying its hardware, and the tier is not recoverable from nvidia-smi:
        # Community and Secure Cloud report the same device name for the same GPU model.
        "spec": spec,
        "host": host,
        "torch": torch_info,
        "nccl": _guarded(probe_nccl, nccl_tests_dir, gpus),
        "profilers": _guarded(probe_profilers),
        "disk": _guarded(probe_disk),
        "matmul": _guarded(probe_matmul),
    }


def summarise(record: dict[str, Any]) -> str:
    lines: list[str] = [f"spec: {record['spec']}"]

    # Failures first. A probe that died only in the JSON is a probe nobody notices until the pod
    # is gone, and the whole point of the console summary is that it is read while it is not.
    for name in ("host", "torch", "nccl", "profilers", "disk", "matmul"):
        section = record.get(name)
        if isinstance(section, dict) and section.get("probe_failed"):
            lines.append(f"  PROBE FAILED {name:<10}: {section['probe_failed']}")

    devices = record["torch"].get("devices") or []
    for d in devices:
        lines.append(
            f"  gpu{d['index']}: {d['name']}  {d['total_memory_gib']} GiB  "
            f"sm_{d['capability'].replace('.', '')}  fp8={d['fp8_capable']}"
        )
    if not devices:
        lines.append("  gpu: NOT DETECTED by torch")

    nccl = record["nccl"]
    if nccl.get("probe_failed"):
        pass  # already stated above, and louder
    elif "skipped" in nccl:
        lines.append(f"  nccl: skipped - {nccl['skipped']}")
    elif nccl.get("failed"):
        lines.append(f"  nccl: FAILED - {nccl['failed']}")
        lines.append(f"        {nccl.get('diagnosis', '')}")
    else:
        peak = nccl.get("peak_busbw_gbps_at_256mib_plus")
        lines.append(f"  nccl busbw >=256MiB : {peak if peak is not None else 'NOT MEASURED'} GB/s")
        lines.append(f"  nccl transport      : {nccl.get('transports_selected') or 'NOT MEASURED'}")
        lines.append(f"  route               : {nccl.get('route') or 'NOT MEASURED'}")

    p2p = record["torch"].get("p2p") or []
    if p2p:
        lines.append(f"  p2p any             : {any(x.get('can_access') for x in p2p)}")

    prof = record["profilers"]
    if not prof.get("probe_failed"):
        lines.append(
            f"  profilers           : ncu={prof['ncu_present']} nsys={prof['nsys_present']} "
            f"torch.profiler={prof['torch_profiler_works']}"
        )

    disk = record.get("disk") or {}
    mounts = disk.get("mounts") or {}
    for path in ("/", "/workspace"):
        info = mounts.get(path)
        if info and "free_gib" in info:
            verdict = "fits" if info["fits_working_set"] else "TOO SMALL"
            lines.append(
                f"  disk {path:<15}: {info['free_gib']} GiB free of {info['total_gib']}  ({verdict})"
            )
    if disk.get("probe_failed"):
        pass  # "no /workspace" would be a claim about the pod; all we know is the probe died
    elif not disk.get("workspace_present"):
        lines.append("  WARNING             : no /workspace - nothing survives a pod restart")
    elif disk.get("workspace_is_separate_mount") is False:
        lines.append("  WARNING             : /workspace is not a separate mount - no persistent volume")

    mm = record["matmul"]
    lines.append(f"  bf16 matmul         : {mm.get('tflops', 'NOT MEASURED')} TFLOP/s")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--spec",
        required=True,
        help="what this ran on, e.g. a40_x2_secure or a40_x1_community -- recorded with the numbers",
    )
    parser.add_argument("--out", help="write the JSON record here")
    parser.add_argument("--nccl-tests", help="path to a built nccl-tests checkout")
    args = parser.parse_args()

    record = collect(args.spec, args.nccl_tests)
    print(summarise(record))

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print(f"\nwrote {args.out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
