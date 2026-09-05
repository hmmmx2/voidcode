# Phase 1–3 Completion Checklist (v5.3 Debug Quality Upgrade)

Status legend: ✅ Done · ⏳ Pending · ▶ Do this next

---

## Quick Summary — What Has Been Done vs. What Still Needs Doing

| Step | What | Status |
|------|------|--------|
| Phase 1 — Prompt update | `prompts.py` — new DEBUG methodology, Tone & Warmth, Multi-Turn sections | ✅ Live in container |
| Phase 2 — Dataset | `voidcode_training_data_v53.jsonl` — 1,850 examples generated and validated | ✅ Ready |
| Phase 2 — Validator | `train.py` `validate_example()` updated for Cat 4 + new Issue format | ✅ Done |
| Phase 3 — Eval suite | `evaluate_debug_quality.py` + `eval_debug_gold.jsonl` (20 scenarios) | ✅ Done |
| **Phase 2 — Training** | `train.py` retrain on v53 dataset | ⏳ **NOT done yet** |
| Post-training | Merge LoRA → AWQ quantize → rebuild Docker | ⏳ Blocked by training |
| Phase 3 — Baseline eval | Run eval BEFORE retrain to establish score | ▶ Do this now |

The live model is currently running from an AWQ snapshot built on **Feb 19** (trained on the old v52 dataset).
Phase 1 prompt changes are live — Phase 2 full effect requires the retrain below.

---

## Phase 1 — System Prompt (Already Live, No Action Needed)

**What changed**: `llm/scripts/prompts.py`
- `### DEBUG MODE` replaced with "Source-Code-First Analysis" (5-step methodology)
- Added `## Tone & Warmth` section
- Added `## Multi-Turn Debugging Sessions` section
- Rules line updated: accepts both old 🔴/🟢 format and new "Issue N — Line X" format

**Status**: ✅ Changes are baked into the running `voidcode-vllm-api` container.

**Optional smoke test** — paste this into the chat at `http://localhost:3000`:
```
Fix this code:
def twoSum(self, nums, target):
    seen = {}
    for i in range(len(nums)):
        complement = target - num[i]   # typo
        if complement in seen:
            return [seen[complement], i]
        seen[nums[i]] = i
    return []          # always returns empty
```
**Pass criteria**: AI responds with "I found **2 issues**", cites both lines by number,
explains WHY (not just echoes the error), ends with a guiding question.

---

## Phase 3 — Run Baseline Eval BEFORE Retraining

> Do this BEFORE `train.py` so you have a "before" score to compare against.

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai"

python llm/scripts/evaluate_debug_quality.py \
  --data llm/data/eval_debug_gold.jsonl \
  --output llm/data/eval_baseline_before_v53.json
```

This calls the live model at `http://localhost:8000` against the 20 gold regression scenarios
and scores 6 automated checks. Saves results to `eval_baseline_before_v53.json` for later comparison.

> If the API is not reachable, verify: `docker ps` shows `voidcode-vllm-api` as `(healthy)`.

---

## Phase 2 — Retrain on v53 Dataset

### Step 1 — Verify dataset is ready

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai\llm"
python -c "
import json
total = sum(1 for _ in open('data/voidcode_training_data_v53.jsonl', encoding='utf-8'))
print(f'Examples: {total}')   # expected: 1850
"
```

### Step 2 — Run training (~4–6 hours on RTX 5060 Ti)

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai\llm"
python scripts/train.py
```

**What it does**:
- Loads `data/voidcode_training_data_v53.jsonl` (1,850 examples)
- Fine-tunes Qwen2.5-7B-Instruct with QLoRA (4-bit NF4, r=64, 3 epochs)
- Outputs LoRA adapters to `outputs/final_model/`
- Checkpoints saved every 50 steps to `outputs/checkpoint-*/`

**Hardware**: Needs the RTX 5060 Ti with 16 GB VRAM. Close other GPU-heavy apps first.

**Monitor progress**:
```bash
# In a separate terminal — watch loss in real time
tail -f llm/logs/training_*.log
```

---

## Post-Training — Merge → Quantize → Rebuild Docker

Run these three steps in order after `train.py` finishes.

### Step 3 — Merge LoRA adapter into base weights (~10–15 min)

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai"
python apps/api/scripts/merge_lora.py
```

- Input: `llm/outputs/final_model/` (LoRA adapter, ~160 MB)
- Output: `llm/outputs/merged_model/` (~14 GB fp16 safetensors)

### Step 4 — AWQ 4-bit quantization (~20–40 min)

```bash
python apps/api/scripts/quantize_awq.py
```

- Input: `llm/outputs/merged_model/`
- Output: `llm/outputs/awq_model/` (~4 GB — replaces the existing AWQ model)

### Step 5 — Rebuild and restart the backend Docker container

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai"

docker compose -f docker-compose.yml -f docker-compose.gpu.yml build vllm-api
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d vllm-api
```

**What this does**: Rebuilds the `voidcode-vllm-api` image with the new AWQ model and
updated `prompts.py`, then restarts the container. The old container is replaced.

**Wait for healthy status** (~5–8 min for model to load):
```bash
docker ps   # wait until voidcode-vllm-api shows (healthy)
```

---

## Do I Need to Restart the Frontend?

**No** — unless you changed frontend code.

The Next.js frontend (`apps/web`) talks to the backend API via HTTP. Restarting the
backend Docker container is sufficient. The frontend will automatically pick up the
new model responses on the next chat message.

If you do want to restart the frontend dev server:
```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai\apps\web"
npm run dev
```

---

## Phase 3 — Compare Eval Results After Retraining

Once the new model is live (Step 5 above), run the eval again with `--compare`:

```bash
cd "C:\Users\User\Documents\DUNE project\voidcode_ai"

python llm/scripts/evaluate_debug_quality.py \
  --data llm/data/eval_debug_gold.jsonl \
  --output llm/data/eval_after_v53.json \
  --compare llm/data/eval_baseline_before_v53.json
```

The `--compare` flag shows ▲/▼ deltas per check across all 20 scenarios:

```
Check                    Before   After   Delta
bug_count_accuracy        12/20   17/20   ▲ +5
no_duplicate_bugs         18/20   20/20   ▲ +2
source_code_citation      10/20   18/20   ▲ +8
no_answer_leakage         20/20   20/20     =
guiding_question          15/20   20/20   ▲ +5
positive_framing          11/20   17/20   ▲ +6
```

---

## Full Execution Order at a Glance

```
RIGHT NOW (30 min):
  1. [optional] Smoke test Phase 1 in the browser
  2. Run baseline eval → saves eval_baseline_before_v53.json

TRAINING SESSION (6–8h total, GPU required):
  3. Verify dataset: python -c "..." (1 min)
  4. python llm/scripts/train.py   (~4–6h)
  5. python apps/api/scripts/merge_lora.py   (~15 min)
  6. python apps/api/scripts/quantize_awq.py   (~30 min)
  7. docker compose build + up vllm-api   (rebuild ~2 min, load ~8 min)

AFTER DEPLOY:
  8. Run post-retrain eval + compare → measure improvement
  9. [optional] Smoke test browser again to confirm multi-bug detection
```

---

## File Reference

| File | Purpose | Status |
|------|---------|--------|
| `llm/scripts/prompts.py` | Live system prompt (all modes) | ✅ Phase 1 changes live |
| `llm/data/voidcode_training_data_v53.jsonl` | 1,850-example training set | ✅ Generated |
| `llm/scripts/train.py` | QLoRA fine-tuning script | ✅ Points to v53 data |
| `llm/scripts/evaluate_debug_quality.py` | Automated eval harness (6 checks) | ✅ Ready |
| `llm/data/eval_debug_gold.jsonl` | 20 gold regression scenarios | ✅ Ready |
| `apps/api/scripts/merge_lora.py` | Merges LoRA into base weights | ✅ Exists |
| `apps/api/scripts/quantize_awq.py` | AWQ 4-bit quantization for vLLM | ✅ Exists |
| `llm/outputs/final_model/` | LoRA adapter output (from train.py) | ⏳ Will be overwritten by retrain |
| `llm/outputs/merged_model/` | Merged fp16 model (from merge_lora.py) | ⏳ Will be overwritten |
| `llm/outputs/awq_model/` | Live AWQ model served by Docker | ⏳ Will be overwritten |
