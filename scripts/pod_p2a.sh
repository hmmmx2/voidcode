#!/bin/bash
# P2a: the single-GPU 7.6B Adafactor run, end to end.
#
# This is not a new benchmark -- `training/parallel/bench.py` already measures exactly the right
# things, and running it at world=1 is the whole of P2a's remaining GPU work. The point is to put
# a real number against a *prediction*.
#
# docs/PLAN.md carries the memory audit's estimator output for one 48 GB card:
#
#   Adafactor BF16 + GC   static 29.08 GiB   peak @1024 31.65 GiB   -> fits, max seq ~6,100
#   8-bit AdamW, no master static 43.62 GiB  peak @1024 46.19 GiB   -> does NOT fit
#
# The estimator's claimed worst error is 2.42% static / 9.51% activation. That is a falsifiable
# claim and it has never been checked against hardware. If measured static lands outside ~28.4-29.8
# GiB, the estimator is wrong and every capacity decision resting on it needs revisiting.
#
# One caveat recorded up front: this A40 reports 44.42 GiB usable, not 48. The prediction was made
# for a 48 GB card, so the *fit margin* differs even if the estimate is right. The number being
# tested is the memory figure, not the verdict.

set -u
cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH
export PYTHONPATH=/root:${PYTHONPATH:-}
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# Kill by GPU occupancy, not by name: killing a parent leaves the child holding the whole card and
# the next run dies at init with an error naming gpu_memory_utilization, which points nowhere near
# the cause.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

mkdir -p /root/docs
rm -f /root/docs/p2a-7b-adafactor.json /root/p2a.log

# --strategy single, NOT ddp at world=1. Those are different measurements and the first attempt
# used the wrong one: DistributedDataParallel allocates gradient buckets for the all-reduce even
# with one rank, a full extra copy of the gradients (~15 GiB at 7.6B bf16). That run OOM'd at
# 43.84 GiB against a predicted 31.65 GiB peak, and it would have been reported as the estimator
# being 40% wrong when most of the gap was a wrapper the experiment had added itself.
#
# torchrun rather than bare python because bench.py initialises a process group regardless.
torchrun --nproc_per_node=1 -m training.parallel.bench \
  --strategy single \
  --steps 12 --warmup 4 --seq 1024 --layers 28 \
  --optimizer adafactor --recipe bf16_native \
  --out /root/docs/p2a-7b-adafactor.json \
  > /root/p2a.log 2>&1

# Gate on the artefact, not on reaching the last line. Two earlier runs in this project printed a
# success marker while failing, and only the missing file gave them away.
if [ -f /root/docs/p2a-7b-adafactor.json ]; then
  echo P2A_OK
  cat /root/docs/p2a-7b-adafactor.json
else
  echo P2A_FAILED
  tail -25 /root/p2a.log
fi
