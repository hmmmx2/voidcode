# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VoidCode AI (v5.3) - A fine-tuning research initiative that trains Qwen 2.5 7B with QLoRA for Socratic teaching behavior in programming education. The model uses 5 response modes based on query type, plus an EMPATHY override for student distress.

## Commands

### Python Training Pipeline
```bash
# From project root (voidcode_ai/)

# Step 1: Patch existing training data to current system prompt
python llm/scripts/update_system_prompts.py

# Step 2: Generate new gap training examples (appends to v53)
python llm/scripts/generate_debug_examples_v53.py

# Step 3: Validate prompt alignment BEFORE training (exit 1 = do not train)
python llm/scripts/validate_prompt_match.py

# Step 4: Run training
python llm/scripts/train.py

# Step 5: Evaluate DEBUG mode quality
python llm/scripts/evaluate_debug_quality.py
python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose
python llm/scripts/evaluate_debug_quality.py --compare \
    llm/data/eval_results_baseline.json \
    llm/data/eval_results_post-retrain.json
```

### Backend API (Docker — primary)
```bash
# Production: Postgres, Redis, Judge0 + GPU vLLM API
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
docker logs -f voidcode-vllm-api   # wait for "Application startup complete."

# Development: live source mounts — edit .py files, then restart (no rebuild)
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu.yml \
  -f docker-compose.dev.yml \
  up -d
docker restart voidcode-vllm-api   # pick up code changes (~40 s warm start)

# Health check
curl http://localhost:8000/health
```

**The API's port is not settled, and the desktop app assumes one of the answers.** The container
above publishes **8000**, as does the root `package.json`'s `dev:api`; `platform/config.ts` falls
back to **8020** and `apps/api/tests/conftest.py` expects 8020. Nothing reconciles them, so an app
started against the container reports "VoidCode isn't set up in this build" until you say so:

```bash
cd desktop && cross-env VOIDCODE_API_URL=http://127.0.0.1:8000/v1 npm run dev
```

`/health` is reachable locally and **is not published**: `deploy/base/ingress.yaml` routes `/v1` and
nothing else, because `/health` names the backend, the model and the GPU's free memory.

### The product is the desktop app
```bash
cd desktop && npm ci && npm --prefix renderer ci
npm run dev           # Electron: the IDE, the problems, the tutor
```
The network surfaces are `/account`, `/account/credits` and `/research`, and they differ: the first
two need a session, while the research library is public and a session only adds the reader's own
ticks. All three are optional and none is touched at startup — a launch with no session makes no
request to our server at all, which `npm run smoke` counts against a loopback API and fails on.

### The website is a separate repository
**`voidcode-web`**, deployed on Vercel. Not in this tree, and not in the build: it is a Next 16 site
that describes the product, hands out the installer and publishes the legal documents. It has no
sign-in, no session, no database and makes no call to our API — the logged-in UI it used to carry is
the desktop app now.

Two things here are its inputs, and both are checked on both sides rather than trusted:

- **The legal documents.** `desktop/renderer/src/components/Legal/` is the ORIGINAL, because that is
  where a person clicks "I agree" and where registration records which version they accepted.
  `desktop/src/shared/legal.ts` commits a SHA-256 of each; `desktop/tests/legal-digest.test.ts`
  checks the text against it here, and the website checks its copy against the same number there.
- **The credit packs.** `contracts/credit-packs.json` is exported from
  `apps/api/src/services/credit_packs.py` by `scripts/export_credit_packs.py`. A page advertising a
  price the webhook does not charge is a false price published to the public.

Editing either means re-running the website's `scripts/sync-from-app.mjs <path-to-this-checkout>`.
Nothing here can tell you that you forgot — that is the residual cost of two repositories.

### Docker (Infrastructure only — no API)
```bash
docker compose up -d                                              # Postgres, Redis, Judge0 only
```

## Architecture

```
llm/
  scripts/
    prompts.py                    Mode detection, system prompts, generation configs
    train.py                      QLoRA fine-tuning (Qwen 2.5 7B, PEFT, TRL)
    update_system_prompts.py      Patch v52 → v53 system prompts in training data
    generate_debug_examples_v53.py  160 gap training examples (4 categories)
    validate_prompt_match.py      Safety: verify training data prompts match prompts.py
    evaluate_debug_quality.py     Phase 3 eval suite (6 checks + heuristic rubric)
  data/
    voidcode_training_data_v53.jsonl   Active training set (1,850 examples)
    mode_teaching.jsonl                 Teaching mode data (900 examples)
    mode_debug.jsonl                    Debug mode data (600 examples)
    mode_followup.jsonl                 Follow-up mode data (200 examples)
    mode_explain.jsonl                  Explain mode data — NOT merged into v53 (see note)
    eval_debug_gold.jsonl               Gold eval set (33 scenarios, 30 single-turn + 3 multi-turn)
  outputs/
    final_model/      LoRA adapter (~100 MB) — train.py output
    merged_model/     Base + LoRA merged fp16 (~14 GB) — merge_lora.py output
    awq_model/        W4A16 quantized (~5.26 GiB) — quantize_awq.py output

apps/
  api/src/
    main.py           FastAPI app, mode routing, HF fallback inference
    vllm_engine.py    vLLM AsyncLLMEngine wrapper + SSE streaming
  api/scripts/
    merge_lora.py     Merge LoRA into base weights (one-time, offline)
    quantize_awq.py   W4A16 quantize merged model for vLLM (one-time, offline)

desktop/              Electron app — THE PRODUCT (main + sandboxed Next renderer)
contracts/            What other repositories read: the credit packs the website prices from
```
The website (`voidcode-web`) and the two installer repositories (`voidcode-mac`,
`voidcode-windows`) are separate repositories; `release.yml`'s `distribute` job feeds the last two.

**Training Stack**: PyTorch + Transformers + PEFT + TRL + BitsAndBytes (4-bit NF4 quantization)
**Inference Stack (primary)**: vLLM + W4A16 AWQ model + PagedAttention (WSL2 only)
**Inference Stack (fallback)**: HuggingFace model.generate() + BnB NF4 + PEFT (Windows/WSL2)
**Desktop Stack**: Electron + electron-vite + Next.js static export + Monaco + Pyodide
**Website Stack**: not in this repository — see `voidcode-web`

## v5.3 Multi-Mode Response System

The model uses 5 modes plus an EMPATHY override, evaluated in this priority order:

### Mode Detection Priority (`llm/scripts/prompts.py → detect_mode()`)
1. **EMPATHY** - Student shows strong frustration/self-doubt (`detect_frustration()` override)
2. **TEACHING** - Problem paste detected (LeetCode/competitive programming format)
3. **DEBUG** - Code block + error/fix keywords
4. **TEACHING** - Explicit solve/implement keywords, or known problem names
5. **EXPLAIN** - Concept clarification questions + programming context
6. **FOLLOWUP** - Short continuations, yes/no, complexity questions
7. **GENERAL** - Non-programming fallback

### Response Formats

**TEACHING MODE**: `[EXPLAIN] → [TEMPLATE] → [GUIDE]`
```
[EXPLAIN]
Brief explanation of approach (2-3 sentences)

[TEMPLATE]
```python
def solution(args):
    result = ____          # Line 1
    for item in ____:      # Line 2
```

[GUIDE]
Line 1: What data structure should we use?
Line 2: What are we iterating over?
```

**DEBUG MODE**: Issue N — Line X format (natural language, no emoji markers)
```
I found 2 issues in your code.

**Issue 1 — Line 5**
```python
if nums[i] + nums[j] == :
```
Line 5 has == with nothing on the right side — Python raises a SyntaxError...
What value should go after ==?

**Issue 2 — Line 6**
```python
return []
```
Line 6 returns an empty list. Because the SyntaxError on line 5 prevents execution...
What two variables hold the positions of the matching numbers?

---
Let's fix Issue 1 first since the code cannot run at all until line 5 is valid.
What value should go after ==?
```

**EXPLAIN MODE**: Code block first, then plain-English explanation (base model, adapter disabled)
```
```python
for i in range(len(nums)):
```
This loops through all valid indices of the list `nums`...
```

**FOLLOW-UP MODE**: Brief, focused response (1-3 sentences)
```
Yes! Each hash map lookup is O(1), and you do one per element — so n × O(1) = O(n) total.
```

**EMPATHY MODE**: Warm emotional support before any technical content (base model, adapter disabled)
```
Hey, don't be hard on yourself — this kind of thing trips everyone up!
The fact that you're stuck means you're right at the edge of understanding it.
[Zoom in on ONE simple thing from the previous hint]
[One ultra-simple guiding question]
You're closer than you think!
```

## Training Data

### Active Training File
`llm/data/voidcode_training_data_v53.jsonl` — 1,850 examples

**Actual v5.3 Mode Distribution**:
- teaching: 48.6% (900 examples)
- debug:    40.5% (750 examples — increased from 30% to cover gap categories)
- followup: 10.8% (200 examples)
- explain:   0%   (see note below)

### EXPLAIN Mode Training Data Exclusion
`mode_explain.jsonl` (explain mode examples) is intentionally **not** merged into `voidcode_training_data_v53.jsonl`.

**Reason**: EXPLAIN mode uses the base model with the LoRA adapter **disabled** at inference time (`model.disable_adapter()`). The model's pre-training on 18T tokens already produces natural, high-quality concept explanations — fine-tuning on structured examples would degrade this natural behaviour. The EXPLAIN training examples exist for format documentation but are excluded from the training run.

**Effect on training**: Training on `voidcode_training_data_v53.jsonl` does not touch EXPLAIN mode behaviour. This is correct and intentional.

### JSONL Format
```json
{
  "id": "teaching_two_sum_001",
  "mode": "teaching",
  "problem": "two_sum",
  "difficulty": "easy",
  "messages": [
    {"role": "system", "content": "<FINETUNED_SYSTEM_PROMPT verbatim>"},
    {"role": "user",   "content": "How do I solve Two Sum?"},
    {"role": "assistant", "content": "[EXPLAIN]...[TEMPLATE]...[GUIDE]..."}
  ]
}
```

### Critical Constraint — System Prompt Must Match Verbatim
The system message in every training record **must be verbatim identical** to `FINETUNED_SYSTEM_PROMPT` in `llm/scripts/prompts.py`. Any divergence at inference time causes **distribution shift** — the model produces garbled or malformed output (observed: 43-token garbage instead of structured response).

**Safety net**: Always run `validate_prompt_match.py` before training. It exits with code 1 and blocks training if any mismatch is found. If it fails, run `update_system_prompts.py` to re-patch the training data, then re-validate.

### Validation Requirements by Mode
- **TEACHING**: `[EXPLAIN]` before `[TEMPLATE]` before `[GUIDE]`, blanks `____`, question in guide
- **DEBUG**: Issue N — Line X format, no 🔴/🟢 markers, ends with guiding question
- **EXPLAIN**: Code block first (```), plain English explanation, no format tags
- **FOLLOW-UP**: Content only, no special tags, 1-3 sentences

## Model Configuration (v5.3)

- **Base Model**: Qwen/Qwen2.5-7B-Instruct
- **Method**: QLoRA (4-bit NF4 quantization, bfloat16 compute)
- **LoRA**: rank=16, alpha=32, targets all 7 attention and MLP projection layers
- **Training**: 1 epoch, effective batch=32 (2×16 grad accumulation), lr=1e-4 cosine decay
- **Sequence Length**: 1024 (default), 1536 (balanced), 2048 (high-end)
- **Output**: LoRA adapters only (~100 MB), not merged weights

## Configuration Profiles

**Profile A (Balanced - 16GB VRAM)**:
```yaml
max_seq_length: 1536
per_device_train_batch_size: 2
gradient_accumulation_steps: 16
```

**Profile B (Memory-Safe - if OOM)**:
```yaml
max_seq_length: 1024
per_device_train_batch_size: 1
gradient_accumulation_steps: 32
```

## Inference Modes

| Mode | Adapter | System Prompt |
|------|---------|---------------|
| TEACHING | Enabled | FINETUNED_SYSTEM_PROMPT |
| DEBUG | Enabled | FINETUNED_SYSTEM_PROMPT |
| FOLLOWUP | Enabled | FINETUNED_SYSTEM_PROMPT |
| EXPLAIN | **Disabled** | EXPLAIN_SYSTEM_PROMPT |
| GENERAL | **Disabled** | NON_PROGRAMMING_SYSTEM_PROMPT |
| EMPATHY | **Disabled** | EMPATHY_SYSTEM_PROMPT |

In the vLLM path, LoRA is pre-merged — adapter enable/disable has no effect. All mode differentiation is via system prompt injection.

## Eval Suite

```bash
# Run full eval against live API
python llm/scripts/evaluate_debug_quality.py

# With heuristic rubric scores (1-5 per dimension, no LLM needed)
python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose

# Compare before/after a prompt or retrain change
python llm/scripts/evaluate_debug_quality.py --compare \
    llm/data/eval_results_baseline.json \
    llm/data/eval_results_post-retrain.json
```

Gold eval set: `llm/data/eval_debug_gold.jsonl`
- 30 single-turn scenarios (syntax, logic, multi-bug, masked, mostly-correct, tree/graph)
- 3 multi-turn scenarios (confusion, frustration/empathy, partial-answer)
- 6 automated checks: BugCnt, NoDupe, SrcCit, NoLeak, GuidQ, PosFrm

## Hardware Requirements

- NVIDIA GPU with 16GB+ VRAM (RTX 5060 Ti or better)
- 16GB+ system RAM
- 30GB free storage
- CUDA 12.1+, PyTorch 2.1+
- WSL2 required for vLLM inference path
