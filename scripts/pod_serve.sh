#!/bin/bash
# P5: serve the policy over an OpenAI-compatible API on port 8080.
#
# This is the phase's original method, running where it actually can. D-011 records that vLLM
# cannot start under WSL2 (UVA is not exposed) and it has no native Windows support -- but the pod
# is Linux with real cards, so `vllm serve` is available here and the local substitute is not
# needed.
#
# Port 8080 is not arbitrary: the desktop app's `llamacpp` provider has that base URL hardcoded, so
# an endpoint there is picked up with zero code changes. Reached from the workstation through an
# SSH tunnel (-L 8080:localhost:8080), which makes the pod look like localhost to the app.

set -u
cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH

# vllm 0.26 pulls torch cu130 while the pod ships the CUDA 12.4 toolkit, so libnvrtc.so.13 lives
# only inside the nvidia pip packages. The driver does support CUDA 13; pointing the loader at it
# is the whole fix, and not knowing it cost a full run on the previous pod.
export LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}

# Kill by GPU occupancy, not process name: killing a parent leaves vLLM's EngineCore child holding
# the card, and the next start then fails complaining about gpu_memory_utilization, which points
# nowhere near the cause.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

rm -f /root/serve.log

setsid nohup python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --served-model-name qwen2.5-coder-1.5b-grpo \
  --host 0.0.0.0 --port 8080 \
  --dtype bfloat16 --max-model-len 4096 --gpu-memory-utilization 0.85 \
  > /root/serve.log 2>&1 &

echo "serve launched pid $!"

# Poll for readiness rather than sleeping a fixed guess: engine init varies with cache state, and a
# fixed sleep either wastes paid minutes or reports failure on a server that was merely slow.
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/v1/models 2>/dev/null | grep -q 200; then
    echo "SERVE_READY after ${i}0s"
    curl -s http://127.0.0.1:8080/v1/models
    exit 0
  fi
  sleep 10
done

echo "SERVE_FAILED - not ready after 600s"
tail -25 /root/serve.log
exit 1
