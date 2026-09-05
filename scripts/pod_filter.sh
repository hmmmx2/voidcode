#!/bin/bash
# Run the corpus band filter on a RunPod A40.
#
# Written as a file and scp'd, never composed inside an ssh command line. Every shell-quoting
# failure in this project came from the latter: a heredoc containing $(...) was expanded by the
# local shell before reaching the pod, and the script ran on the workstation instead.

set -u
cd /root
export HF_HOME=/workspace/hf

# vllm pulls a cu130 torch; the pod ships the CUDA 12.4 toolkit, so libnvrtc.so.13 exists only
# inside the nvidia pip packages. The driver is 580.x and does support CUDA 13, so pointing the
# loader at it is the entire fix.
export LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}

# Killing the filter parent leaves vLLM's EngineCore child alive holding all 40 GB, and the next
# run then dies at engine init complaining about gpu_memory_utilization — which points nowhere
# near the cause. Kill by GPU occupancy, not by script name.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

rm -f /root/deepcoder-band.json

# Progress goes to its own file. Piping the run through `tail` buffers everything until exit,
# which once left two hours of grading with no visible progress at all.
python3 scripts/filter_corpus.py \
  --corpus data/deepcoder-sample.json \
  --group 8 --max-new 640 --grade-timeout 8 --util 0.85 --max-cases 20 \
  --out /root/deepcoder-band.json > /root/filter-progress.log 2>&1

# Gated on the artefact, not on reaching the last line. Two earlier runs printed a success marker
# while failing, and only the missing file gave them away.
if [ -f /root/deepcoder-band.json ]; then
  echo FILTER_OK
else
  echo FILTER_FAILED
  tail -20 /root/filter-progress.log
fi
