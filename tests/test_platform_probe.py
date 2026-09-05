"""The probe's parsing, which is where a wrong number would come from.

Everything else in `platform_probe.py` reports what a tool said. `parse_nccl` *interprets* it, and
its output selects a parallelism strategy — so a misread column silently routes the plan to the
wrong place and there is nothing downstream to catch it.

The fixture below is real `all_reduce_perf` output shape, not invented: the column order is
size, count, type, redop, root, then (time, algbw, busbw, #wrong) for out-of-place and again for
in-place. **busbw is column 7**, and picking `algbw` at column 6 instead is the plausible mistake —
it would flatter the interconnect by roughly 2x on a two-rank ring and route ZeRO-3 as viable when
it is not.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from training import platform_probe
from training.platform_probe import collect, parse_nccl, probe_nccl, summarise

# Trimmed real output. Two ranks, sizes from 8 B to 1 GiB.
NCCL_OUTPUT = """\
# nThread 1 nGpus 2 minBytes 8 maxBytes 1073741824 step: 2(factor) warmup iters: 5 iters: 20
#
#                                                              out-of-place                       in-place
#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong
#        (B)    (elements)                               (us)  (GB/s)  (GB/s)            (us)  (GB/s)  (GB/s)
           8             2     float     sum      -1    12.34    0.00    0.00      0    12.10    0.00    0.00      0
     1048576        262144     float     sum      -1    89.20   11.75   11.75      0    88.90   11.79   11.79      0
   268435456      67108864     float     sum      -1  22150.0   12.12    12.12     0  22100.0   12.15   12.15      0
   536870912     134217728     float     sum      -1  43900.0   12.23    12.23     0  43850.0   12.24   12.24      0
  1073741824     268435456     float     sum      -1  87500.0   12.27    12.27     0  87400.0   12.28   12.28      0
# Out of bounds values : 0 OK
# Avg bus bandwidth    : 8.1234
"""


def test_reads_busbw_at_large_sizes_only() -> None:
    parsed = parse_nccl(NCCL_OUTPUT)

    # Every data row is picked up, and no header or comment line is.
    assert len(parsed["rows"]) == 5
    assert all(isinstance(r["size_bytes"], int) for r in parsed["rows"])

    # The peak considers only sizes at or above 256 MiB. The 1 MiB row measures latency, and
    # including it could only ever drag the figure down or, worse, become the figure on a run
    # that never reached large sizes.
    assert parsed["peak_busbw_gbps_at_256mib_plus"] == 12.27
    assert parsed["note"] is None


def output_with_busbw(busbw: float) -> str:
    """Build one large-size row at a chosen bus bandwidth.

    Constructed rather than string-substituted into the fixture. The first version of this test
    did `NCCL_OUTPUT.replace("12.27   12.27", ...)` and matched nothing, because the real output
    separates those columns with four spaces and I had written three — so the "fast" and "slow"
    cases were both silently the unmodified fixture, and the test passed one band three times.
    """
    header = "#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong"
    row = f"  1073741824     268435456     float     sum      -1  87500.0  {busbw:7.2f} {busbw:7.2f}     0  87400.0  {busbw:7.2f} {busbw:7.2f}      0"
    return header + "\n" + row + "\n"


def test_routes_from_the_measured_number() -> None:
    """The routing table, exercised at each band rather than trusted."""
    assert parse_nccl(NCCL_OUTPUT)["route"].startswith("ZeRO-2 / FSDP2")

    fast = parse_nccl(output_with_busbw(48.9))
    assert fast["peak_busbw_gbps_at_256mib_plus"] == 48.9
    assert fast["route"].startswith("ZeRO-2 and ZeRO-3")

    slow = parse_nccl(output_with_busbw(2.1))
    assert slow["peak_busbw_gbps_at_256mib_plus"] == 2.1
    assert "net negative" in slow["route"]

    # The boundaries themselves, since the table is written with strict `>`.
    assert parse_nccl(output_with_busbw(20.0))["route"].startswith("ZeRO-2 / FSDP2")
    assert parse_nccl(output_with_busbw(20.1))["route"].startswith("ZeRO-2 and ZeRO-3")
    assert "net negative" in parse_nccl(output_with_busbw(5.0))["route"]


def test_says_so_when_no_large_sizes_were_run() -> None:
    """A run stopped at 1 MiB must report NOT MEASURED, not a latency figure dressed as bandwidth."""
    small = "\n".join(
        line for line in NCCL_OUTPUT.splitlines() if not line.strip().startswith(("268435456", "536870912", "1073741824"))
    )
    parsed = parse_nccl(small)

    assert parsed["peak_busbw_gbps_at_256mib_plus"] is None
    assert parsed["route"] is None
    assert "256 MiB" in parsed["note"]


def test_empty_output_produces_no_number() -> None:
    """A failed nccl-tests run must leave the field empty rather than defaulting to zero.

    Zero would be read as "measured, and catastrophically slow", which routes to
    "multi-GPU is net negative" — a real conclusion drawn from a run that never happened.
    """
    parsed = parse_nccl("")
    assert parsed["rows"] == []
    assert parsed["peak_busbw_gbps_at_256mib_plus"] is None
    assert parsed["route"] is None


def test_summary_prints_not_measured_rather_than_a_blank() -> None:
    """The console summary is what a human reads at $0.88/hr; absence must be legible."""
    record = {
        "spec": "a40_x2_community",
        "torch": {"devices": [], "p2p": []},
        "nccl": parse_nccl(""),
        "profilers": {"ncu_present": False, "nsys_present": False, "torch_profiler_works": None},
        "matmul": {},
    }
    text = summarise(record)

    assert "a40_x2_community" in text
    assert "NOT DETECTED" in text
    assert text.count("NOT MEASURED") >= 3


# ── the storage warnings, which are the cheapest thing to get wrong ───────────────────────────
#
# RunPod separates an ephemeral container disk from a persistent volume at /workspace. Caching a
# 15 GB model to the wrong one means re-downloading it on every restart, silently and at full
# cost. These are the two states worth shouting about, so both are asserted.


def test_warns_when_there_is_no_persistent_volume() -> None:
    record = {
        "spec": "a40_x1_community",
        "torch": {"devices": [], "p2p": []},
        "nccl": {"skipped": "single GPU"},
        "profilers": {"ncu_present": False, "nsys_present": False, "torch_profiler_works": None},
        "disk": {
            "mounts": {"/": {"total_gib": 20.0, "free_gib": 12.0, "fits_working_set": False}},
            "workspace_present": False,
            "workspace_is_separate_mount": None,
        },
        "matmul": {},
    }
    text = summarise(record)

    assert "no /workspace" in text
    # And the size verdict is stated, because 12 GiB free does not hold a 15 GB model.
    assert "TOO SMALL" in text


def test_warns_when_workspace_is_not_a_separate_mount() -> None:
    """Same total on / and /workspace means the volume was never attached.

    The nastier case: the directory exists, so a script writing to it succeeds, and everything
    looks configured right up until the pod restarts empty.
    """
    record = {
        "spec": "a40_x2_secure",
        "torch": {"devices": [], "p2p": []},
        "nccl": {"skipped": "n/a"},
        "profilers": {"ncu_present": True, "nsys_present": True, "torch_profiler_works": True},
        "disk": {
            "mounts": {
                "/": {"total_gib": 100.0, "free_gib": 80.0, "fits_working_set": True},
                "/workspace": {"total_gib": 100.0, "free_gib": 80.0, "fits_working_set": True},
            },
            "workspace_present": True,
            "workspace_is_separate_mount": False,
        },
        "matmul": {"tflops": 180.0},
    }
    text = summarise(record)

    assert "not a separate mount" in text
    assert "no /workspace" not in text


def test_is_quiet_when_storage_is_correct() -> None:
    record = {
        "spec": "a40_x2_secure",
        "torch": {"devices": [], "p2p": []},
        "nccl": {"skipped": "n/a"},
        "profilers": {"ncu_present": True, "nsys_present": True, "torch_profiler_works": True},
        "disk": {
            "mounts": {
                "/": {"total_gib": 20.0, "free_gib": 15.0, "fits_working_set": False},
                "/workspace": {"total_gib": 200.0, "free_gib": 190.0, "fits_working_set": True},
            },
            "workspace_present": True,
            "workspace_is_separate_mount": True,
        },
        "matmul": {"tflops": 180.0},
    }
    text = summarise(record)

    assert "WARNING" not in text
    # The container disk being too small is fine and must not be reported as a problem, so long
    # as the volume is there — that is the normal, correct RunPod shape.
    assert "TOO SMALL" in text
    assert "fits" in text


# ── surviving the pod, which is the whole reason this is a script ─────────────────────────────
#
# `run()` is written so that one missing tool tells you nothing about the other twelve. But
# `probe_nccl` shells out directly rather than through it, and NCCL is the single likeliest
# thing on a multi-GPU pod to hang: a 900-second timeout then raises, `collect` propagates, and
# the disk, profiler and matmul probes never run. You have paid for the pod and received a
# traceback. These assert the guarantee the module's own docstring makes.


@pytest.mark.parametrize(
    ("boom", "expected_diagnosis"),
    [
        (subprocess.TimeoutExpired(cmd="all_reduce_perf", timeout=900), "hung collective"),
        (OSError(8, "Exec format error"), "would not execute"),
        (PermissionError(13, "Permission denied"), "would not execute"),
    ],
    ids=["nccl_hangs", "binary_not_executable", "permission_denied"],
)
def test_nccl_failure_is_recorded_with_a_usable_diagnosis(monkeypatch, boom, expected_diagnosis) -> None:
    def explode(*_args, **_kwargs):
        raise boom

    monkeypatch.setattr(platform_probe.os.path, "exists", lambda _p: True)
    monkeypatch.setattr(platform_probe.subprocess, "run", explode)

    result = probe_nccl("/anywhere", 2)

    # It returns, and it says what went wrong rather than implying nothing was attempted.
    assert result["ok"] is False
    assert result["failed"]
    # And it keeps parse_nccl's shape, so nothing downstream needs a special case.
    assert result["peak_busbw_gbps_at_256mib_plus"] is None
    assert result["route"] is None

    # The diagnosis is the part actually worth having while the meter runs, and it is the part a
    # weaker test misses: the catch-all arm satisfies every assertion above while saying only
    # "unexpected". Mutating the specific arms away survived until this line existed.
    assert expected_diagnosis in result["diagnosis"]


def test_one_dead_probe_does_not_cost_the_others(monkeypatch) -> None:
    """The expensive property: a $1.98/hr pod must still yield the probes that did work."""

    def explode():
        raise RuntimeError("CUDA driver exploded")

    monkeypatch.setattr(platform_probe, "probe_matmul", explode)

    record = collect("a40_x2_secure", None)

    assert record["matmul"]["probe_failed"].startswith("RuntimeError")
    # The point: everything else is still here.
    assert record["spec"] == "a40_x2_secure"
    assert "mounts" in record["disk"]
    assert "ncu_present" in record["profilers"]


def test_a_dead_probe_is_visible_in_the_summary() -> None:
    """A failure that only lands in the JSON is a failure nobody sees at the terminal."""
    record = {
        "spec": "a40_x2_secure",
        "torch": {"devices": [], "p2p": []},
        "nccl": {"skipped": "n/a"},
        "profilers": {"ncu_present": False, "nsys_present": False, "torch_profiler_works": None},
        "disk": {"probe_failed": "OSError: [Errno 5] Input/output error"},
        "matmul": {"probe_failed": "RuntimeError: CUDA driver exploded"},
    }
    text = summarise(record)

    assert "PROBE FAILED" in text
    assert "CUDA driver exploded" in text
    assert "Input/output error" in text


def test_an_unforeseen_nccl_error_still_returns_a_record(monkeypatch) -> None:
    """`probe_nccl` must be safe called directly, not only through `collect`'s guard.

    Its catch-all arm is belt-and-braces behind `_guarded`. Belt-and-braces that nothing
    exercises is just an untested branch, and a mutation removing it survived until this existed.
    """

    def explode(*_args, **_kwargs):
        raise MemoryError("cannot allocate")

    monkeypatch.setattr(platform_probe.os.path, "exists", lambda _p: True)
    monkeypatch.setattr(platform_probe.subprocess, "run", explode)

    result = probe_nccl("/anywhere", 2)

    assert result["ok"] is False
    assert "MemoryError" in result["failed"]
    assert result["route"] is None


# `run()` is the helper every other shell-out goes through, and its guards turned out to be
# untested: a mutation aimed at probe_nccl landed here instead and survived. Testing it here
# rather than leaving the gap, since it is the one function whose failure would be silent.


def test_run_reports_a_missing_tool_without_raising() -> None:
    result = platform_probe.run(["definitely-not-a-real-binary-xyz", "--version"])

    assert result["ok"] is False
    assert result["reason"] == "not_installed"


def test_run_reports_a_timeout_without_raising(monkeypatch) -> None:
    def hang(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="slow-tool", timeout=120)

    monkeypatch.setattr(platform_probe.shutil, "which", lambda _c: "/usr/bin/slow-tool")
    monkeypatch.setattr(platform_probe.subprocess, "run", hang)

    result = platform_probe.run(["slow-tool"])

    assert result["ok"] is False
    assert result["reason"] == "timeout"


def test_run_reports_an_unforeseen_error_without_raising(monkeypatch) -> None:
    def explode(*_args, **_kwargs):
        raise OSError(8, "Exec format error")

    monkeypatch.setattr(platform_probe.shutil, "which", lambda _c: "/usr/bin/broken")
    monkeypatch.setattr(platform_probe.subprocess, "run", explode)

    result = platform_probe.run(["broken"])

    assert result["ok"] is False
    assert "OSError" in result["reason"]


# ── pod identity, and the credential that must not ride along ─────────────────────────────────


def test_records_the_pod_identity(monkeypatch) -> None:
    """`--spec` is hand-typed and so is the one field that can be wrong. These cannot be."""
    monkeypatch.setenv("RUNPOD_POD_ID", "abc123xyz")
    monkeypatch.setenv("RUNPOD_DC_ID", "EU-RO-1")
    monkeypatch.setenv("RUNPOD_GPU_COUNT", "2")

    pod = platform_probe.probe_pod_identity()

    assert pod["RUNPOD_POD_ID"] == "abc123xyz"
    assert pod["RUNPOD_DC_ID"] == "EU-RO-1"
    assert pod["RUNPOD_GPU_COUNT"] == "2"


def test_pod_identity_never_captures_a_credential(monkeypatch) -> None:
    """The allowlist exists for this. A `RUNPOD_*` sweep would be shorter and would eventually
    write an API key into a JSON file that goes into git."""
    monkeypatch.setenv("RUNPOD_POD_ID", "abc123xyz")
    monkeypatch.setenv("RUNPOD_API_KEY", "sk-do-not-commit-me")
    monkeypatch.setenv("RUNPOD_SECRET_TOKEN", "also-not-this")

    pod = platform_probe.probe_pod_identity()

    assert pod == {"RUNPOD_POD_ID": "abc123xyz"}
    assert "sk-do-not-commit-me" not in repr(pod)


def test_pod_identity_is_empty_off_runpod(monkeypatch) -> None:
    """An empty dict, not fabricated placeholders — same rule as every other absent measurement."""
    for name in platform_probe.POD_IDENTITY_VARS:
        monkeypatch.delenv(name, raising=False)

    assert platform_probe.probe_pod_identity() == {}
