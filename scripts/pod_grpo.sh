#!/bin/bash
# Run the GRPO loop on a RunPod A40.
#
# Moved here from the RTX 5060 Ti, where the same script averaged ~12% GPU: a 1.5B decoding four
# sequences is memory-bandwidth-bound and never saturated the card. The A40 has 46 GB and far more
# bandwidth, and it was already rented and sitting at 0%.
#
# Written as a file and scp'd, never composed inside an ssh command line. A heredoc containing
# $(...) was once expanded by the local shell before reaching the pod, and the script ran on the
# workstation instead.
#
# --group 16, not 8. The first A40 run used 6.4 GB of 46 GB, so the card was idling on a group that
# small. Sixteen completions per prompt also gives a better within-group baseline, which is the
# whole mechanism GRPO runs on -- advantages are standardised against the group, so a wider group
# is a less noisy estimate of what "better than average for this prompt" means.
#
# THREE RUNS, AND WHAT THEY ACTUALLY ESTABLISHED
#
#   lr     KL over 200 steps      eval mean_case_fraction
#   1e-6   0.0001, flat           0.1119 -> flat
#   2e-5   0.0442 -> 0.0958       0.1119 -> 0.0722
#   2e-6   ~3e-4, flat, no drift  0.1110 -> 0.0649
#
# The third row is the one that mattered, and not for its learning rate. At 2e-6 the policy
# **provably did not move** -- KL flat at ~3e-4 across 100 steps -- and the eval still fell 42%.
# A metric that swings 42% with no policy change cannot resolve the differences between these
# rows, so the "2e-5 degrades" reading taken from row two was not supported by its own evidence.
# All three learning rates were being compared against sampling noise.
#
# --eval-group 8 (was 4) and, more importantly, `evaluate()` now uses **common random numbers**:
# the same seed before every eval, so checkpoints are compared on identical draws instead of two
# independent doses of noise. It also reports `case_fraction_se` and a **greedy** (do_sample=False,
# deterministic) metric whose movement cannot be sampling noise at all. Fix the instrument first;
# tuning a hyperparameter against an unresolvable metric is fitting to variance.
#
# The step-0 baseline is re-measured under the new settings. Comparability to a noise-dominated
# baseline was never worth preserving.
#
# --lr 5e-6 sits between the flat 2e-6 and the moving 2e-5 -- but treat it as provisional. It is
# the first rate to be judged on an instrument that can actually see.
#
# What to read: KL in 0.001-0.01 means the policy is moving without being torn off its starting
# point. KL back at ~1e-4 means too low again. Eval falling below the 0.1119 baseline while KL
# rises means still too high, and the run should be cut rather than left to finish.

set -u
cd /root
export HF_HOME=/workspace/hf
export PATH=/usr/local/cuda/bin:$PATH
export PYTHONPATH=/root:${PYTHONPATH:-}

# Killing a parent leaves children holding the whole card, and the next run then dies at init
# complaining about memory -- which points nowhere near the cause. Kill by GPU occupancy, not name.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 5

rm -f /root/docs/grpo-run.json /root/grpo-train.log
mkdir -p /root/docs

# setsid so the run survives the ssh session closing. Progress goes to its own file rather than
# through a pipe: piping through `tail`/`grep` buffers everything until exit, which has now cost
# this project three separate runs' worth of visibility.
setsid nohup python3 -u scripts/train_grpo.py \
  --corpus data/deepcoder-band.json \
  --source data/deepcoder-sample.json \
  --eval-set data/catalogue.json \
  --model Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --signal any \
  --group 16 --steps 200 --eval-every 50 --eval-group 8 \
  --lr 5e-6 \
  --max-new 640 --grade-timeout 8 --max-cases 20 \
  --out /root/docs/grpo-run.json \
  > /root/grpo-train.log 2>&1 &

echo "launched pid $!"
sleep 30
echo "--- first 5 lines ---"
head -5 /root/grpo-train.log 2>/dev/null
echo "--- still alive? ---"
pgrep -f train_grpo.py >/dev/null && echo GRPO_RUNNING || echo GRPO_DIED
