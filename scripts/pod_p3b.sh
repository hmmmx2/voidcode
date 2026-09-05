#!/bin/bash
# P3b: time GRPO rollout generation, HF `generate` vs vLLM, on identical prompts.
#
# Run as: bash pod_p3b.sh <hf|vllm|vllm_batched>
#
# Written as a file and scp'd. Every shell-quoting failure in this project came from composing a
# script inside an ssh command line -- a heredoc containing $(...) was once expanded locally and
# the script ran on the workstation instead.

set -u
BACKEND="${1:?usage: pod_p3b.sh <hf|vllm|vllm_batched>}"

cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH
export PYTHONPATH=/root:${PYTHONPATH:-}
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# vllm 0.26 pulls torch cu130; this pod ships the CUDA 12.4 toolkit, so libnvrtc.so.13 exists only
# inside the nvidia pip packages. The driver does support CUDA 13, so pointing the loader at it is
# the entire fix. Cost of not knowing this on the previous pod: one failed run.
export LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}

# Kill by GPU occupancy, not by process name. Killing a parent leaves vLLM's EngineCore child
# holding the whole card, and the next run then dies at engine init complaining about
# gpu_memory_utilization -- which points nowhere near the cause.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

OUT="/root/docs/p3b-${BACKEND}.json"
rm -f "$OUT"

python3 -u scripts/bench_rollout.py \
  --backend "$BACKEND" \
  --model Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --eval-set data/catalogue.json \
  --limit 13 --group 16 --max-new 640 --temperature 0.8 --util 0.85 \
  --out "$OUT" > "/root/p3b-${BACKEND}.log" 2>&1

# Gate on the artefact, not on reaching the last line: two earlier runs in this project printed a
# success marker while failing, and only the missing file gave them away.
if [ -f "$OUT" ]; then
  echo "P3B_OK ${BACKEND}"
  cat "$OUT"
else
  echo "P3B_FAILED ${BACKEND}"
  tail -20 "/root/p3b-${BACKEND}.log"
fi
