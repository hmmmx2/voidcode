# P0 attempt, 2026-09-06 — QUARANTINED, not a platform-truth result

**Do not copy these numbers into `METRICS.md` or cite them as the A40 ×2 baseline.** They were
measured on a host that RunPod flagged as faulty *during the session*:

> "We have detected a critical error on this machine which may affect some pods. We are looking into
> the root cause and apologize for any inconvenience. We would recommend backing up your data and
> creating a new pod in the meantime."

That notice arrived **after** the collective failure below, and is the most likely explanation for
it. A number measured on hardware the vendor has declared broken is not platform truth about the
A40 — it is a measurement of a broken machine.

## What was observed

Pod `z6h0zfdo3wd7nc`, 2 × A40 (46068 MiB each), template
`runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`, NCCL 2.21.5+cuda12.4,
nccl-tests 2.20.0. Tier **not confirmed** — the `--spec` label was never stamped, which is itself a
reason this cannot enter the ledger.

| Observation | Evidence |
|---|---|
| **No NVLink bridge fitted.** `nvidia-smi topo -m` reports `PXB` between GPU0 and GPU1, not `NV#` | topology output, below |
| **Default P2P all_reduce deadlocks.** `timeout 120` → exit 124. The log stops at `# Using devices`, i.e. it hung during device/P2P init, before any collective ran | `nccl_default.log` (285 bytes — that is the whole file) |
| **With `NCCL_P2P_DISABLE=1` it completes** over `SHM/direct/direct` | `nccl_nop2p.log` |
| Bus bandwidth, 256 MiB | `3.00 GB/s` out-of-place, `2.80` in-place, **avg 2.89974 GB/s** |

An earlier hand run was left spinning for 10+ minutes with both GPUs pinned at 100% utilisation —
NCCL busy-waits, so a deadlocked collective looks identical to a working one on `nvidia-smi`.

## What it would have meant, if the host were healthy

Against the runbook's routing table, 2.90 GB/s falls in the bottom band:

| Measured | Route |
|---|---|
| > 20 GB/s | ZeRO-2 and ZeRO-3 both viable |
| 5–20 GB/s | ZeRO-2 / FSDP2 `SHARD_GRAD_OP` only |
| **< 5 GB/s** | **Multi-GPU is net negative — report that as the finding** |

**That conclusion is withheld.** The runbook is right that a negative result honestly obtained beats
a fabricated table — but "honestly obtained" requires a working machine, and this one was not.

## What has to happen before P0 can be recorded

1. Re-run on a **healthy** pod, confirmed by `nvidia-smi topo -m` and a completing default-transport
   `all_reduce_perf` (no `NCCL_P2P_DISABLE` needed).
2. Stamp `--spec` with the tier **read off the pod's Details tab**, not inferred.
3. Only then fill `METRICS.md` and `DECISIONS.md` D-004 / D-005.

Two things here are probably still true of *any* pod and worth carrying forward: the NVLink bridge is
**not** implied by the GPU name (this pair had none), and `NCCL_P2P_DISABLE=1` is the diagnostic that
distinguishes "no P2P path" from "slow P2P path".

## Files

| File | What |
|---|---|
| `nccl_default.log` | The hang. Ends at `# Using devices`. |
| `nccl_nop2p.log` | The completing run: transport lines and the 256 MiB row. |
| `diag_console.log` | Both arms with exit codes (124 = timed out, 0 = completed). |

```
        GPU0    GPU1    NIC0    NIC1    CPU Affinity  NUMA Affinity
GPU0     X      PXB     NODE    NODE    24-47,72-95   1
GPU1    PXB      X      NODE    NODE    24-47,72-95   1
```
