#!/bin/bash
# Serve the RL-trained 30B and measure what a slot actually costs.
#
# WHAT THIS IS FOR. `gpu_pricing.PRICING` ships a row marked `measured=False` because its
# `nominal_concurrency` of 16 is an API-side semaphore count (MAX_CONCURRENT_REQUESTS 8 x 2
# replicas), not a statement about an A40. If the card serves six concurrent requests of this model
# rather than sixteen, a fully busy hour produces 6 x 3600 slot-seconds and the price under-recovers
# nearly threefold while every ledger figure stays arithmetically correct. This measures which it is.
#
# TWO ANSWERS ARE COLLECTED, DELIBERATELY. vLLM prints the concurrency its KV cache can hold at the
# configured context length -- a capacity statement -- and the load sweep measures what it actually
# sustains without per-slot throughput collapsing. They can disagree, and the smaller one is the
# honest input to the price.
#
# RUN IT ONLY WHEN THE CARD IS FREE. The replication and the ablation each take the whole A40; a
# benchmark sharing the card measures contention and reports it as capacity.

set -u
cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH

# See pod_serve.sh: vllm pulls torch cu130 while the pod ships the CUDA 12.4 toolkit, so
# libnvrtc.so.13 exists only inside the nvidia pip packages. The driver supports CUDA 13; pointing
# the loader at it is the whole fix, and not knowing it cost a full run once.
export LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}

AWQ_MODEL="QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"
ADAPTER="${ADAPTER:-/workspace/policy-30b-uncapped}"
# Match production: the API serves at 5120 under the trainer's config, and KV cache capacity is a
# function of context length, so measuring at 4096 would flatter the concurrency number.
MAX_LEN="${MAX_LEN:-5120}"
# 0.85 rather than the 0.40 the trainer used: nothing else is resident now, and the whole point is
# to find out what the card does when it is not sharing with a 4-bit trainer.
GPU_UTIL="${GPU_UTIL:-0.85}"

echo "===== SERVING BENCHMARK: $AWQ_MODEL + $(basename "$ADAPTER") ====="
date -u
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader

# Refuse to measure a shared card. A benchmark that quietly reports contention as capacity is worse
# than no benchmark: the number looks plausible and sets a price.
USED_MIB=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
if [ "$USED_MIB" -gt 2000 ]; then
  echo "REFUSING: ${USED_MIB} MiB already in use on the card."
  echo "Something else is resident (the replication or the ablation). Capacity measured against"
  echo "a busy card is contention, not capacity. Wait for it to finish."
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv
  exit 2
fi

if [ ! -d "$ADAPTER" ]; then
  echo "REFUSING: no adapter at $ADAPTER"
  exit 2
fi

# Kill by GPU occupancy, not process name: killing a parent leaves vLLM's EngineCore child holding
# the card, and the next start then fails complaining about gpu_memory_utilization, which points
# nowhere near the cause.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

rm -f /root/bench_serve.log

# --enable-lora with rank 32: the adapter targets attention projections only, which is exactly why
# it can be served at all -- vLLM has no fused-MoE LoRA, and this model is an MoE. The training
# loop served this same adapter over this same AWQ base for its rollouts, so the path is proven.
setsid nohup python3 -m vllm.entrypoints.openai.api_server \
  --model "$AWQ_MODEL" \
  --served-model-name base \
  --enable-lora --max-lora-rank 32 --max-loras 1 \
  --lora-modules "rl=$ADAPTER" \
  --host 0.0.0.0 --port 8080 \
  --max-model-len "$MAX_LEN" --gpu-memory-utilization "$GPU_UTIL" \
  --trust-remote-code \
  > /root/bench_serve.log 2>&1 &

echo "serve launched pid $!"

# Poll rather than sleep a guess: a 16 GB AWQ load varies with page cache state, and a fixed sleep
# either wastes paid minutes or calls a slow start a failure.
READY=0
for i in $(seq 1 90); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/v1/models 2>/dev/null | grep -q 200; then
    echo "SERVE_READY after ${i}0s"
    READY=1
    break
  fi
  sleep 10
done
if [ "$READY" -ne 1 ]; then
  echo "SERVE_FAILED - not ready after 900s"
  tail -40 /root/bench_serve.log
  exit 1
fi

echo
echo "--- what vLLM says it can hold (capacity, before any load) ---"
# These two lines are the engine's own arithmetic on KV cache size and the concurrency it implies.
# Worth capturing verbatim: it is a different kind of evidence from the load sweep and it is free.
grep -iE "KV cache size|Maximum concurrency|GPU KV cache|available KV cache" /root/bench_serve.log | tail -6
echo
echo "--- models advertised ---"
curl -s http://127.0.0.1:8080/v1/models | head -c 400
echo

echo
echo "===== LOAD SWEEP ====="
# `rl` is the adapter, not the bare base: the price is for serving the trained policy, and a LoRA
# adds per-token work that the base alone would not show.
python3 /workspace/bench_serving.py \
  --base-url http://127.0.0.1:8080/v1 \
  --model rl \
  --concurrency "${LEVELS:-1,2,4,8,16}" \
  --max-tokens "${MAX_TOKENS:-768}" \
  --out /workspace/bench-serving-30b.json
BENCH_EXIT=$?
echo "BENCH_EXIT=$BENCH_EXIT"

echo
echo "--- engine log tail (OOM and preemption show up here, not in the client) ---"
grep -iE "out of memory|preempt|cache full|aborted" /root/bench_serve.log | tail -10 || true

# Free the card. The meter runs from the moment the pod starts, and leaving a 16 GB server resident
# after a benchmark is paying for nothing.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5
nvidia-smi --query-gpu=memory.used --format=csv,noheader

date -u
echo "===== BENCHMARK DONE ====="
exit $BENCH_EXIT
