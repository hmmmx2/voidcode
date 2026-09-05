# P0 runbook — platform truth on two RunPod pods

The meter runs from the moment the pod starts. Everything below is decided in advance so the paid
time is spent measuring, not orienting. Read it once before you rent anything.

**Outcome:** two JSON records, a parallelism route, and the answer to whether Community Cloud is
good enough to run the rest of the plan on. **Budgeted $3.56**; RunPod bills per minute and the work
takes about 25 minutes a pod, so the real figure should land near half that.

---

## 1. Before you start the pod

| | Choose |
|---|---|
| GPU | **A40 × 2** |
| Template | **Runpod Pytorch 2.4.0** — `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` |
| Container disk | 20 GB is plenty |
| Volume disk | **100 GB at `/workspace`** |
| Network volume | **none** — the A40 does not offer it, and D-001 does not want it |

**Two A40s may have a third-generation NVLink bridge (112.5 GB/s), and may not.** The GPU name does
not say. That is the single most valuable thing this probe reports — it is the difference between
the full five-row parallelism table and a truncated one, and the L40S this replaced has no NVLink at
all.

**Why that template and not a newer one.** It is the newest official RunPod image whose tag
explicitly contains **`devel`**, and `nvcc` is the hard requirement — `nccl-tests` will not build
without it. The `Pytorch 2.8.0` (`1.0.2-cu1281-torch280-ubuntu2404`) and `2.9.0 for clusters`
templates carry newer CUDA and torch but do not say `devel` in the tag, so `nvcc` is not guaranteed.

**The bundled torch version does not matter.** The image only has to supply the toolchain; install
whatever torch the phase needs on top. The A40 is sm_86, supported by every CUDA since 11.x, so
nothing in P0 depends on the image's torch. If you do try a newer template, make this the first
command and switch templates if it comes back empty:

```bash
nvcc --version || ls /usr/local/cuda/bin/nvcc
```

**Both halves matter, and the first one lied on the Secure pod.** `nvcc --version` returned
`command not found` while `/usr/local/cuda/bin/nvcc` existed and worked (CUDA 12.4.131) — the
toolkit ships in the image, it is just not on `PATH`. Checking only the first would have thrown away
a good pod. Fix it with:

```bash
export PATH=/usr/local/cuda/bin:$PATH
```

Only if *both* checks fail are you actually on a runtime image.

**Not the "Network storage file browser" template.** `filebrowser/filebrowser` is a web UI for
browsing files on a network volume — a file manager, not a storage type, and not something this
plan needs. Storage is chosen in the pod configuration, not by the template.

**The `devel` image is the one thing that will cost you a restart if you get it wrong.** Building
`nccl-tests` needs `nvcc`, and RunPod's `runtime` images do not ship it. Any PyTorch **devel** image
works; torch being preinstalled saves a ~2.5 GB download.

Run the whole thing twice: once on **Community**, once on **Secure**. The diff is the deliverable.

## 2. Getting the probe onto the pod

`training/platform_probe.py` imports nothing outside the standard library at module scope — torch is
imported lazily and its absence is recorded rather than fatal — so **one file is the whole payload**.
This repo has no remote, and it does not need one:

```bash
scp -P <pod-ssh-port> training/platform_probe.py root@<pod-ip>:/workspace/
```

RunPod shows the exact `ssh` line on the pod's Connect tab; reuse its port and host.

## 3. On the pod

```bash
cd /workspace && export HF_HOME=/workspace/hf
git clone https://github.com/NVIDIA/nccl-tests.git && cd nccl-tests && make -j && cd ..
```

If the build cannot find CUDA, point it at the toolkit explicitly:

```bash
make -j CUDA_HOME=/usr/local/cuda
```

Then the measurement. **Set `--spec` to match the tier you are actually on** — it is the only field
in the record that is hand-typed, and every later comparison depends on it:

```bash
python platform_probe.py --spec a40_x2_community --out /workspace/probe-a40_x2_community.json --nccl-tests /workspace/nccl-tests
```

On the Secure pod, the same command with `a40_x2_secure` in both places.

The probe never raises. If NCCL hangs or the binary will not execute, it records the failure with a
diagnosis and still reports disk, profilers and the matmul floor — so a bad collective costs you one
number, not the session.

## 4. What to read before you terminate

The console summary is the point of reading it here rather than at home, while the pod still exists
and a surprise can still be chased.

- **`PROBE FAILED`** on any line — chase it now. It is cheaper than a second pod.
- **`nccl busbw >=256MiB`** — the number the plan routes on. See the table below.
- **`nccl transport`** — `P2P` explains a high number; `SHM` or `NET/...` explains a low one. A fast
  number over `SHM` deserves suspicion.
- **`fp8=True`** on both devices — confirms Ada, which the entire P4 phase assumes. If this reads
  `False`, you are not on an A40 and nothing else in the record is comparable.
- **`WARNING: /workspace is not a separate mount`** — the volume never attached. Fix before P2, or
  every model you cache is re-downloaded on each restart.
- **`bf16 matmul`** — the compute anchor. If the two tiers differ here as well as on interconnect,
  say so in `METRICS.md`; it confounds any cross-pod throughput comparison.

**The routing table**, applied to busbw at ≥256 MiB:

| Measured | Route | What it means for P2 |
|---|---|---|
| **> 20 GB/s** | ZeRO-2 and ZeRO-3 both viable | The full five-row table runs |
| **5–20 GB/s** | ZeRO-2 / FSDP2 `SHARD_GRAD_OP` only | Drop the ZeRO-3 and `FULL_SHARD` rows, raise gradient accumulation |
| **< 5 GB/s** | Multi-GPU is net negative | **Report that as the finding.** P2 becomes single-GPU baselines plus the write-up |

The third row is a result, not a failure. A negative measurement honestly obtained is worth more
than a table of numbers from an interconnect that could not support them.

## 5. Bring home, then terminate

```bash
scp -P <pod-ssh-port> root@<pod-ip>:/workspace/probe-*.json ./docs/
```

Then **terminate the pod** — do not stop it. A stopped pod with a 100 GB volume bills at $0.20/GB
per month, which is double the running rate, and there is nothing on it worth keeping: the JSON is
now in git and the weights are re-downloadable.

## 6. Writing up

1. Both JSON files into `docs/`, committed.
2. `docs/METRICS.md`'s P0 table filled in, both columns, `NOT MEASURED` wherever a probe did not run.
3. **`docs/DECISIONS.md` D-005** — record the route *and the busbw that drove it*, so the conclusion
   can be re-derived instead of taken on trust.
4. **`docs/DECISIONS.md` D-004** — Community vs Secure. If Community is within ~15% of Secure on
   busbw, move the reported legs to Community and drop roughly $14 from the budget. Record the two
   numbers either way; "close enough" is not a measurement.

## 7. If something goes wrong

| Symptom | Cause | Do |
|---|---|---|
| `make` fails, `nvcc: not found` | `runtime` image, not `devel` | Terminate, restart on a devel image. Cheaper than fighting it |
| `nccl: skipped - fewer than 2 GPUs` | `CUDA_VISIBLE_DEVICES` set, or a 1× pod | `echo $CUDA_VISIBLE_DEVICES`, unset it, rerun |
| `nccl: FAILED - did not finish within 900s` | Hung collective | Rerun by hand with `NCCL_DEBUG=INFO` and watch which transport it picks before stalling |
| `all_reduce_perf not found` | Built somewhere else | The probe wants `<dir>/build/all_reduce_perf`; pass the checkout root to `--nccl-tests` |
| `no rows at or above 256 MiB` | Run stopped early | Rerun `all_reduce_perf` with `-e 1G` by hand |
| `torch.profiler=False` | Host virtualises the GPU | Not fixable from here. Record it — P4 then reports wall clock only, and says so |


---

## Pod-session failure modes, all learned by hitting them

Four consecutive failed filter runs on one A40 session cost roughly $3. None was a hardware
problem. Recorded so the next session does not repeat them.

| Symptom | Cause | Fix |
|---|---|---|
| `ImportError: libnvrtc.so.13` | `vllm` pulls torch `cu130`; pod ships the CUDA 12.4 toolkit. The driver (580.x) *does* support CUDA 13 — only the loader path was wrong | `export LD_LIBRARY_PATH=/usr/local/lib/python3*/dist-packages/nvidia/cu13/lib:$LD_LIBRARY_PATH` |
| `ValueError: Free memory (5.04/44.42 GiB) ... less than desired gpu_memory_utilization` | Killing the parent leaves vLLM's **EngineCore child** holding all 40 GB. The error names `gpu_memory_utilization`, which points nowhere near the cause | Kill by GPU occupancy, not by script name: `for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do kill -9 $p; done` |
| `AttributeError: 'list' object has no attribute 'strip'` | DeepCoder stores some `input`/`output` values as lists. Annotating a parameter `str` does not make it one | `normalise_output` accepts lists; graders catch per problem so one bad row cannot destroy a paid-for run |
| A failed run printed a success marker | The wrapper echoed `FILTER_DONE` unconditionally | Gate the marker on the artefact: `[ -f out.json ] && echo OK \|\| echo FAILED` |
| No progress visible for two hours | The wrapper piped through `tail -40`, which buffers until exit | Write progress to a file the run appends to, or drop the pipe |

**And one about driving pods from Windows at all.** A heredoc containing `$(...)` was expanded by
the local shell before reaching the pod, so the script ran on the *workstation* instead. Write pod
scripts to a file with the Write tool and `scp` them, rather than composing them inside an `ssh`
command line. Every shell-quoting failure in this project came from that pattern.
