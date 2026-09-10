#!/bin/bash
# Serve the 30B AWQ base with the seed-1 RL adapter, for the end-to-end tutor test.
#
# Port 8080 because that is what an ssh -L tunnel maps to the workstation, and what the API is
# pointed at. The adapter is served as a LoRA named `rl`, so asking for model "rl" gets the trained
# policy and "base" gets the untrained one -- which makes an A/B comparison a one-word change.
#
# Kill by GPU occupancy, never by process name: vLLM's EngineCore is a child, and killing the
# parent leaves it holding the card. The next start then fails complaining about
# gpu_memory_utilization, which points nowhere near the cause.
set -u
cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH

exec > /workspace/serve_rl.log 2>&1

echo "===== SERVING 30B + seed-1 RL adapter ====="
date -u
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader

for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

# The venv, not system python3: vllm lives in /workspace/vllmrl and the system interpreter has none.
# Getting this wrong cost a 900s readiness budget waiting for a server that could never start.
setsid nohup /workspace/vllmrl/bin/python -m vllm.entrypoints.openai.api_server \
  --model QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ \
  --served-model-name base \
  --enable-lora --max-lora-rank 32 --max-loras 1 \
  --lora-modules rl=/workspace/policy-30b-seed1 \
  --host 0.0.0.0 --port 8080 \
  --max-model-len 5120 --gpu-memory-utilization 0.85 \
  --trust-remote-code \
  > /root/serve_rl_engine.log 2>&1 &

echo "engine launched pid $!"

# Poll rather than sleep a guess: engine init varies with page-cache state, and a fixed sleep
# either wastes paid minutes or calls a slow start a failure.
for i in $(seq 1 90); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/v1/models 2>/dev/null | grep -q 200; then
    echo "SERVE_READY after ${i}0s"
    curl -s http://127.0.0.1:8080/v1/models
    echo
    exit 0
  fi
  sleep 10
done

echo "SERVE_FAILED - not ready after 900s"
tail -40 /root/serve_rl_engine.log
exit 1
