# VoidCode AI — LLM Architecture

> Complete technical reference for the LLM subsystem: model architecture, training pipeline, inference paths, mode detection, prompt engineering, and performance benchmarks.

---

## 1. Overview

The LLM subsystem is a **hybrid fine-tuning + prompt engineering** system built on Qwen 2.5 7B. Three modes use a fine-tuned model to produce strict structured output; two modes use the base model with prompt engineering for natural reasoning.

```
User Message
     │
     ▼
┌─────────────────────────────────────┐
│        detect_mode()                │  llm/scripts/prompts.py
│                                     │
│  Priority 0 → Problem Paste? ──────►│ TEACHING
│  Priority 1 → Code + Error? ───────►│ DEBUG
│  Priority 2 → Solve request? ──────►│ TEACHING
│  Priority 3 → Concept question? ───►│ EXPLAIN
│  Priority 4 → Short follow-up? ────►│ FOLLOWUP
│  Default   → Non-programming? ─────►│ GENERAL
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│       get_system_prompt()           │
│       get_generation_config()       │
└─────────────────────────────────────┘
     │
     ├─── TEACHING / DEBUG / FOLLOWUP ──► Fine-tuned AWQ model (LoRA baked in)
     │
     └─── EXPLAIN / GENERAL ───────────► Same AWQ model, different system prompt
                                         (base model behaviour retained via training data balance)
     │
     ▼
┌─────────────────────────────────────┐
│     vLLM AsyncLLMEngine             │  apps/api/src/vllm_engine.py
│     (USE_VLLM=true, WSL2)           │
│                                     │
│  OR                                 │
│                                     │
│     HuggingFace model.generate()    │  apps/api/src/main.py
│     (USE_VLLM=false, fallback)      │
└─────────────────────────────────────┘
     │
     ▼
  SSE Stream → Frontend
```

---

## 2. Base Model

| Property | Value |
|----------|-------|
| Model | Qwen/Qwen2.5-7B-Instruct |
| Architecture | Qwen2ForCausalLM (transformer decoder) |
| Parameters | ~7.6 billion |
| Hidden size | 3584 |
| Layers | 28 transformer blocks |
| Attention heads | 28 (query) / 4 (key-value, GQA) |
| Intermediate size | 18944 (SwiGLU FFN) |
| Max context | 32768 tokens (trained); 8192 (serving limit) |
| Vocab size | 152064 tokens |
| Activation | SiLU |
| Positional encoding | RoPE (rotary position embedding) |
| Pre-trained on | 18 trillion tokens (multilingual + code) |

Qwen 2.5 7B uses **Grouped Query Attention (GQA)** — 28 query heads share 4 KV heads, reducing KV cache memory significantly at long context lengths.

---

## 3. Fine-Tuning — QLoRA

### Why QLoRA

Full fine-tuning of a 7B model requires ~112 GB VRAM (fp32) or ~56 GB (bf16). QLoRA reduces this to ~8 GB by combining:
1. **4-bit NF4 quantization** of frozen base model weights (BitsAndBytes)
2. **LoRA adapters** on a small subset of weight matrices (trainable, bf16)

Only the LoRA adapter weights (~100 MB) are updated. The quantized base weights are frozen.

### LoRA Configuration

| Parameter | Value | Reason |
|-----------|-------|--------|
| Rank (`r`) | 16 | Sufficient expressiveness for format learning |
| Alpha (`lora_alpha`) | 32 | Effective learning rate scale = alpha/r = 2.0 |
| Dropout | 0.1 | Light regularisation, small dataset |
| Task type | CAUSAL_LM | Autoregressive text generation |
| Bias | none | Standard for LLM fine-tuning |

**Target modules** (7 weight matrices per layer × 28 layers = 196 adapter matrices):

| Module | Layer type | Why targeted |
|--------|-----------|-------------|
| `q_proj` | Attention query | Controls what the model attends to |
| `k_proj` | Attention key | Controls what is attended |
| `v_proj` | Attention value | Controls what information is retrieved |
| `o_proj` | Attention output | Projects multi-head output |
| `gate_proj` | FFN gate (SwiGLU) | Controls information flow in FFN |
| `up_proj` | FFN up projection | FFN expansion |
| `down_proj` | FFN down projection | FFN contraction |

All projection layers are targeted — this is the maximum coverage recommended for format-heavy fine-tuning tasks.

### Training Stack

| Framework | Version | Role |
|-----------|---------|------|
| PyTorch | ≥ 2.2.0 | Tensor computation, CUDA backend |
| HuggingFace Transformers | ≥ 4.36.0 | Model loading, tokenizer, chat template |
| PEFT | ≥ 0.7.0 (0.18.1 used) | LoRA adapter injection via `get_peft_model()` |
| TRL | latest | `SFTTrainer` — supervised fine-tuning loop |
| BitsAndBytes | ≥ 0.41.0 | NF4 4-bit quantization during training |
| Accelerate | ≥ 0.25.0 | Device placement, mixed precision |
| Datasets | latest | JSONL data loading and tokenization |

### Training Configuration

| Hyperparameter | Value | Notes |
|----------------|-------|-------|
| Epochs | 1 | Small, curated dataset — 1 epoch avoids overfitting |
| Per-device batch size | 2 | Limited by NF4 VRAM budget |
| Gradient accumulation | 16 steps | Effective batch = 2 × 16 = **32** |
| Learning rate | 1e-4 | Standard for LoRA fine-tuning |
| LR scheduler | Cosine decay | Smooth decay from 1e-4 → ~0 |
| Warmup ratio | 0.05 | 5% of steps for LR warmup |
| Optimizer | AdamW (paged) | Paged version for 4-bit training stability |
| Precision | bf16 compute, NF4 storage | BitsAndBytes QLoRA setup |
| Max sequence length | 1024–2048 | Configured in `training_config.yaml` |
| Gradient checkpointing | Enabled | Trades compute for memory |

### Training Data

4 JSONL files, ~1,000 examples total. Each record:
```json
{
  "id": "teaching_two_sum_001",
  "mode": "teaching",
  "problem": "two_sum",
  "difficulty": "easy",
  "messages": [
    {"role": "system",    "content": "<FINETUNED_SYSTEM_PROMPT>"},
    {"role": "user",      "content": "How do I solve Two Sum?"},
    {"role": "assistant", "content": "[EXPLAIN]\n...\n[TEMPLATE]\n...\n[GUIDE]\n..."}
  ]
}
```

| Mode | File | Share | What the model learns |
|------|------|-------|----------------------|
| TEACHING | `llm/data/mode_teaching.jsonl` | 45% | Produce `[EXPLAIN]→[TEMPLATE]→[GUIDE]` with `____` blanks |
| DEBUG | `llm/data/mode_debug.jsonl` | 30% | Produce line-by-line `🔴 Problem / 🟢 Think` markers |
| EXPLAIN | `llm/data/mode_explain.jsonl` | 15% | Natural code explanation (reinforces base behaviour) |
| FOLLOWUP | `llm/data/mode_followup.jsonl` | 10% | Brief 1–3 sentence continuations |

> **Critical constraint**: The system prompt in every training record must be **verbatim identical** to `FINETUNED_SYSTEM_PROMPT` in `llm/scripts/prompts.py`. Any divergence at inference time causes distribution shift — the model produces garbled output (observed: 43-token garbage instead of full teaching template).

### Training Pipeline

```
llm/scripts/generate_diverse_dataset.py
    → llm/data/mode_teaching.jsonl   (45%)
    → llm/data/mode_debug.jsonl      (30%)
    → llm/data/mode_explain.jsonl    (15%)
    → llm/data/mode_followup.jsonl   (10%)

llm/scripts/validate_and_test.py   ← validates format, detects duplicates

llm/scripts/train.py
    Base: Qwen/Qwen2.5-7B-Instruct (NF4 4-bit, frozen)
        + PEFT LoRA (r=16, 7 modules, trainable)
        + TRL SFTTrainer (1 epoch, batch=32, lr=1e-4)
    → llm/outputs/final_model/      (~100 MB LoRA adapter weights)
```

---

## 4. Post-Training Model Preparation

### Step 1 — Merge LoRA (`apps/api/scripts/merge_lora.py`)

```
Qwen2.5-7B-Instruct (fp16, CPU)
    + PeftModel.from_pretrained(final_model/)
    → merge_and_unload()   ← mathematically folds LoRA into base weights
    → llm/outputs/merged_model/   (~14 GB fp16 safetensors)
```

`merge_and_unload()` computes: `W_merged = W_base + (B × A) × (alpha/r)` for each LoRA target layer, then discards the A/B matrices. The result is a standard Qwen2.5-7B with fine-tuned behaviour baked in — no adapter overhead at inference.

### Step 2 — Quantize (`apps/api/scripts/quantize_awq.py`)

```
llm/outputs/merged_model/   (~14 GB fp16)
    → llmcompressor W4A16 GPTQ quantization
        group_size = 128
        w_bit = 4 (weights stored as int4)
        a_bit = 16 (activations remain fp16)
    → llm/outputs/awq_model/   (~5.26 GiB)
    → cp to ~/voidcode_models/awq_model   (WSL2 ext4, fast load)
```

**W4A16**: weights are 4-bit integers, activations are 16-bit floats. Dequantization happens on-the-fly during the matrix multiply. Net effect: 2.6× smaller model, ~10% accuracy loss (negligible for instruction-following tasks).

### Step 3 — Deploy

```
~/voidcode_models/awq_model/
    → vLLM AsyncLLMEngine (quantization="compressed-tensors")
    → GPU VRAM: ~5.26 GiB model weights + ~8 GiB KV cache = ~13.5 GiB
```

---

## 5. Inference Architecture

### Path A — vLLM (Primary, `USE_VLLM=true`)

Used in daily operation. Requires WSL2 + GPU.

```
POST /v1/chat/completions
    │
    ▼
prepare_messages_hybrid()          main.py
    → detect_mode(user_message)    prompts.py  → "teaching" / "debug" / ...
    → get_system_prompt(mode)      prompts.py  → inject at messages[0]
    → get_generation_config(mode)  prompts.py  → temperature, max_tokens
    │
    ▼
tokenizer.apply_chat_template()    → formatted prompt string
    │
    ▼
generate_stream_vllm()             vllm_engine.py
    │
    ▼
vLLM AsyncLLMEngine
    → PagedAttention KV cache      (non-contiguous memory blocks)
    → Continuous batching          (new requests fill gaps mid-generation)
    → CUDA graphs                  (pre-captured kernel launch sequences)
    → W4A16 dequantize-on-the-fly  (compressed-tensors kernel)
    │
    ▼
RequestOutput (cumulative text)
    → extract delta via prev_text_len offset
    → <think> tag state machine    (strip CoT, emit as separate event)
    │
    ▼
SSE stream → StreamingResponse → Frontend
```

**vLLM engine configuration** (`AsyncEngineArgs`):

| Parameter | Value | Effect |
|-----------|-------|--------|
| `quantization` | `"compressed-tensors"` | Reads W4A16 config from `config.json` |
| `dtype` | `float16` | Required for W4A16 (bfloat16 incompatible) |
| `gpu_memory_utilization` | `0.90` | ~14.4 GiB reserved on 16 GiB GPU |
| `max_model_len` | `8192` | Max prompt + completion tokens |
| `enable_lora` | NOT set | LoRA already merged — no runtime injection |

**Why vLLM is faster than HuggingFace:**

| Feature | vLLM | HuggingFace |
|---------|------|-------------|
| KV cache | PagedAttention (non-contiguous blocks, no fragmentation) | Contiguous pre-allocated tensors |
| Batching | Continuous — new requests fill mid-batch gaps | Static batch, must wait for batch to complete |
| Kernels | Fused CUDA kernels (Triton), CUDA graphs | Eager PyTorch ops |
| Overhead | Async generator, minimal Python overhead | TextIteratorStreamer thread + GIL |
| Throughput | ~80–120 tok/s (RTX 5060 Ti) | ~10–20 tok/s |

### Path B — HuggingFace Fallback (`USE_VLLM=false`)

Used on native Windows or when WSL2 is unavailable.

```
POST /v1/chat/completions
    │
    ▼
prepare_messages_hybrid() → detect_mode() → get_system_prompt()
    │
    ▼
tokenizer() → input_ids + attention_mask → .to(model.device)
    │
    ▼
should_disable_adapter = mode in ['explain', 'general']
with model.disable_adapter() if should_disable_adapter:
    with torch.inference_mode():
        model.generate(
            **gen_kwargs,
            streamer=TextIteratorStreamer    ← background thread
        )
    │
    ▼
generate_stream() yields SSE chunks (identical format to vLLM path)
```

**HF model load stack:**
```python
BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                   bnb_4bit_compute_dtype=bfloat16, bnb_4bit_use_double_quant=True)

AutoModelForCausalLM.from_pretrained(
    BASE_MODEL_ID,
    quantization_config=bnb_config,
    device_map="auto",
    torch_dtype=bfloat16,
    attn_implementation="sdpa",      # Scaled Dot Product Attention (fused kernel)
)
PeftModel.from_pretrained(model, ADAPTER_PATH)   # applies LoRA at runtime
model.eval()
torch.compile(model, mode="default")             # Triton JIT (WSL2 only)
```

**HF WSL2 cache resolution:** When running in WSL2 without internet, `from_pretrained("Qwen/Qwen2.5-7B-Instruct")` times out trying to reach HuggingFace Hub. `main.py` resolves the local snapshot path directly from `/mnt/c/Users/User/.cache/huggingface/hub` to skip the network check entirely.

---

## 6. Mode Detection

### Priority Order (`detect_mode()`)

```python
Priority 0:  detect_problem_paste()
             # 2+ LeetCode indicators (Example:, Constraints:, Input:, Output:)
             # OR 2+ competitive programming indicators
             # OR math notation + competitive keywords
             # → forces "teaching" (prevents students pasting problems for answers)

Priority 1:  has_code_block AND debug_keywords
             # debug_keywords = fix, debug, error, bug, doesn't work, broken, fail
             # → "debug"

Priority 2:  teaching_keywords OR known_problems
             # teaching_keywords = how to solve, implement, write code, algorithm for
             # known_problems = two sum, binary search, BFS, DFS, sliding window, ...
             # → "teaching"

Priority 3:  explain_keywords AND is_programming_related
             # explain_keywords = what is, explain, how does, difference between
             # → "explain"  (routes to base model, adapter disabled in HF path)

Priority 4:  followup_patterns OR complexity_terms
             # short message, starts with "so/and/but/why", or O(n) complexity question
             # → "followup"

Default:     is_programming_related → "explain"
             else                   → "general"
```

### System Prompt Routing

```
mode          system_prompt                 adapter (HF path)
──────────────────────────────────────────────────────────────
teaching    → FINETUNED_SYSTEM_PROMPT      ENABLED
debug       → FINETUNED_SYSTEM_PROMPT      ENABLED
followup    → FINETUNED_SYSTEM_PROMPT      ENABLED
explain     → EXPLAIN_SYSTEM_PROMPT        DISABLED (base model)
general     → NON_PROGRAMMING_PROMPT       DISABLED (base model)
```

In the vLLM path, there is no adapter to enable/disable — the merged model is used for all modes. Mode differentiation is 100% driven by the injected system prompt.

### Generation Config Per Mode

| Mode | Temp | max_tokens | top_p | rep_penalty | Rationale |
|------|------|------------|-------|-------------|-----------|
| TEACHING | 0.1 | 8192 | 0.9 | 1.05 | Near-deterministic — enforces exact `[EXPLAIN]→[TEMPLATE]→[GUIDE]` structure |
| DEBUG | 0.3 | 4096 | 0.9 | 1.05 | Low variation — errors should be identified consistently |
| FOLLOWUP | 0.5 | 4096 | 0.9 | 1.05 | Balanced — brief answers with some naturalness |
| EXPLAIN | 0.6 | 4096 | 0.9 | 1.05 | Higher creativity — natural concept explanations |
| GENERAL | 0.7 | 4096 | 0.9 | 1.05 | Most natural — conversational academic responses |

---

## 7. Response Formats

### TEACHING MODE

**`[EXPLAIN]`** — 2–3 sentence approach description:

> We can use a hash map to track values we've seen and their indices. A complement approach avoids nested loops.

**`[TEMPLATE]`** — Code scaffold with `____` blanks and `# Line N` comments:

```python
def twoSum(nums, target):
    seen = ____                    # Line 1
    for i, num in ____:            # Line 2
        complement = ____          # Line 3
        if complement in ____:     # Line 4
            return ____            # Line 5
        ____                       # Line 6
```

**`[GUIDE]`** — Line-by-line guiding questions:

> Line 1: What data structure gives O(1) average lookup?
> Line 2: How do we iterate with both index and value?
> Line 3: What value would pair with `num` to reach `target`?

---

### DEBUG MODE

> I found 2 issues in your code:

**Line 3**

```python
for i in range(len(num)):
```

🔴 **Problem:** Variable name typo — `num` instead of `nums`
🟢 **Think:** Check your function signature. What did you name the list parameter?

**Line 6**

```python
return [i, j]
```

🔴 **Problem:** `j` is not defined in this scope
🟢 **Think:** Where do you get the second index from?

> Which one would you like to tackle first?

---

### EXPLAIN MODE

```python
for i in range(len(nums)):
```

> This iterates through all valid indices of `nums`. `range(len(nums))` produces 0, 1, 2, ... up to (but not including) the length of the list. Each iteration, `i` holds the current index, which you can use to access `nums[i]`.

---

### FOLLOWUP MODE

> Yes! Each hash map lookup is O(1), and you do one per element, so n elements × O(1) = O(n) total. Space complexity is also O(n) in the worst case.

---

## 8. SSE Streaming

Both inference paths emit **identical SSE event sequences**:

```
Event 1 (optional):  thinking block
data: {"type":"thinking","content":"<chain of thought>",
       "token_count":142,"budget_used":7.1,"budget_total":2000}

Events 2..N:  token delta chunks
data: {"id":"chatcmpl-1234","created":1708123456,
       "choices":[{"delta":{"content":"[EXPLAIN]\n"},"finish_reason":null}]}

Event N+1:  usage stats
data: {"type":"usage","usage":{"prompt_tokens":142,"completion_tokens":487,"total_tokens":629}}

Event N+2:  finish signal
data: {"id":"chatcmpl-1234","created":1708123456,
       "choices":[{"delta":{},"finish_reason":"stop"}]}

Terminal:
data: [DONE]
```

**`<think>` tag stripping state machine** (identical in both paths):

```
content_buffer accumulates vLLM/HF output chunks
    │
    ├── "<think>" detected → inside_think = True
    │       emit any text before <think> as delta
    │       accumulate into thinking_buffer (hidden from user)
    │
    ├── "</think>" detected → think_done = True
    │       extract thinking content
    │       emit thinking SSE event (→ ThinkingBlock in frontend)
    │       continue with text after </think>
    │
    └── normal text → emit as delta chunk
```

---

## 9. Inference Architecture Comparison

### 9.1 Full Stack Comparison Table

| Dimension | Training | HF Fallback (`USE_VLLM=false`) | vLLM Primary (`USE_VLLM=true`) |
|-----------|----------|-------------------------------|-------------------------------|
| **Base LLM** | Qwen/Qwen2.5-7B-Instruct | Qwen/Qwen2.5-7B-Instruct | Qwen/Qwen2.5-7B-Instruct (merged+quantized) |
| **Model architecture** | Qwen2ForCausalLM | Qwen2ForCausalLM | Qwen2ForCausalLM |
| **Parameters** | 7.62B | 7.62B | 7.62B (same weights, quantized) |
| **Hidden layers** | 28 | 28 | 28 |
| **Attention heads** | 28Q / 4KV (GQA) | 28Q / 4KV (GQA) | 28Q / 4KV (GQA) |
| **Hidden size** | 3584 | 3584 | 3584 |
| **FFN intermediate** | 18944 (SwiGLU) | 18944 (SwiGLU) | 18944 (SwiGLU) |
| **Quantization method** | NF4 4-bit (BitsAndBytes) | NF4 4-bit (BitsAndBytes) | W4A16 GPTQ (llmcompressor / compressed-tensors) |
| **Quant format** | NormalFloat4, double-quant | NormalFloat4, double-quant | `pack-quantized`, int4 symmetric, group_size=128 |
| **Quant target** | All Linear layers | All Linear layers | All Linear layers **except `lm_head`** |
| **Quantization calibration** | N/A (BnB runtime quant) | N/A (BnB runtime quant) | Static minmax observer, 10 programming-domain calibration samples |
| **Compute dtype** | bfloat16 | bfloat16 | float16 (W4A16 requires fp16) |
| **Weight dtype** | int4 (NF4) + bf16 compute | int4 (NF4) + bf16 compute | int4 (symmetric) + fp16 compute |
| **Activation dtype** | bfloat16 | bfloat16 | float16 |
| **LoRA adapter** | Injected trainable (r=16, α=32) | Loaded via PEFT at runtime | **Pre-merged into weights** (merge_and_unload) |
| **LoRA at inference** | N/A (training) | `model.disable_adapter()` for EXPLAIN/GENERAL | Not applicable — baked into AWQ weights |
| **LoRA target modules** | q/k/v/o/gate/up/down_proj (7) | q/k/v/o/gate/up/down_proj (7) | Already merged |
| **Adapter overhead** | Trainable params only | Runtime GEMM overhead per layer | Zero (merged) |
| **Attention kernel** | Eager (training) | SDPA (`scaled_dot_product_attention`) | PagedAttention (vLLM custom CUDA kernel) |
| **KV cache strategy** | N/A | Contiguous pre-allocated tensor | Paged blocks (non-contiguous, no fragmentation) |
| **KV cache size** | N/A | Fixed per sequence | Dynamic — up to ~8 GiB on 16 GiB GPU |
| **Batching** | Gradient accumulation | Static batch (1 request at a time) | Continuous batching (new requests interleave mid-generation) |
| **Inference engine** | TRL SFTTrainer | HuggingFace `model.generate()` | vLLM `AsyncLLMEngine` |
| **Streaming method** | N/A | `TextIteratorStreamer` (background thread) | `AsyncGenerator` (native async) |
| **Compilation** | N/A | `torch.compile(mode="default")` + Triton JIT | CUDA graphs (pre-captured kernel launch sequences) |
| **CUDA graph capture** | N/A | Partial (compiled subgraphs only) | Full — all decode steps pre-captured |
| **Triton kernels** | N/A | Yes (torch.compile, WSL2 only) | Yes (Punica LoRA GEMM, flash-attn-equivalent) |
| **Python overhead** | N/A | High — GIL, streamer thread, eager dispatch | Low — async generator, batched engine loop |
| **Model file on disk** | N/A (downloads base) | `llm/outputs/final_model/` (LoRA, ~100 MB) + HF base cache | `~/voidcode_models/awq_model/` (~5.26 GiB) |
| **Model load source** | HuggingFace Hub / local cache | `/mnt/c/.cache/huggingface/hub` (local, no network) | `~/voidcode_models/awq_model` (WSL2 ext4, ~1 GB/s) |
| **Load speed** | ~5–10 min (first download) | ~30–60 s (HF + PEFT + compile warmup) | ~40–90 s (CUDA graph capture, cached after first run) |
| **VRAM — model weights** | ~8 GB | ~8 GB | ~5.26 GiB |
| **VRAM — KV cache** | N/A | ~1–3 GB (per active sequence) | ~8 GiB (pooled, all active sequences) |
| **VRAM — total** | ~8 GB | ~9–11 GB | ~13.5 GiB (90% of 16 GiB) |
| **System RAM (WSL2)** | N/A | ~3–4 GB | ~3–5 GB (vLLM engine metadata) |
| **Throughput** | N/A | ~10–20 tok/s | ~80–120 tok/s |
| **OS requirement** | Windows or WSL2 | Windows native or WSL2 | **WSL2 / Linux only** |
| **Internet required** | Yes (first download) | No (local cache) | No (local model) |
| **`stream: false` support** | N/A | ✅ Yes | ❌ HTTP 400 — always use `stream: true` |
| **Use case** | One-time fine-tuning | Fallback / Windows dev | **Daily production use** |

---

### 9.2 Quantization Deep Dive

#### NF4 (HF Fallback path)

NormalFloat4 is a data type designed specifically for normally-distributed neural network weights. It places quantization levels at positions that minimise expected quantisation error under a normal distribution — unlike standard int4 which uses uniform levels.

```
NF4 value map (symmetric around 0):
[-1.0, -0.6962, -0.5252, -0.3949, -0.2844, -0.1848, -0.0911, 0.0,
  0.0796, 0.1609, 0.2461, 0.3379, 0.4407, 0.5626, 0.7230, 1.0]

Double quantization: quantizes the quantization scales themselves
→ further reduces memory by ~0.37 bits/param
→ total: ~4.37 bits/param effective
```

BitsAndBytes applies NF4 per-column (no group structure). Dequantization happens at compute time: weights are unpacked to bf16 just before the matrix multiply, then discarded.

#### W4A16 GPTQ (vLLM path, `config.json`)

```
Format:      pack-quantized (int4 packed into int32 tensors, 8 weights per int32)
Strategy:    group (group_size = 128 columns share one scale/zero-point pair)
Symmetric:   true (zero-point = 0, halves storage vs asymmetric)
actorder:    static (weight columns sorted by activation variance at calibration)
Observer:    minmax (calibration range = [min_weight, max_weight] per group)
lm_head:     excluded (kept in fp16 — output logits need full precision)
Version:     compressed-tensors 0.13.0
```

W4A16 means: **weights stored as int4, activations remain float16**. The dequantization kernel (Triton, via vLLM's compressed-tensors backend) runs:

```
W_fp16 = scale[group] × W_int4      (vectorised, fused with GEMM)
output  = activation_fp16 @ W_fp16.T
```

Group size 128 means every 128 consecutive weight values share one fp16 scale. Smaller groups → better accuracy, larger memory overhead for scales.

---

### 9.3 Attention Mechanism Comparison

| Aspect | SDPA (HF path) | PagedAttention (vLLM) |
|--------|---------------|----------------------|
| **Implementation** | `torch.nn.functional.scaled_dot_product_attention` | vLLM custom CUDA kernel |
| **Memory layout** | Contiguous QKV tensors, full N×N score matrix avoided via fused kernel | Non-contiguous paged blocks (block_size=16 tokens per block) |
| **KV cache growth** | Pre-allocated per sequence → fragmentation at variable lengths | Allocated on demand in fixed blocks → no fragmentation, no waste |
| **Multi-sequence** | Sequences padded to same length → wasted compute | Each sequence uses exactly its own blocks, no padding |
| **Compatibility** | Compatible with BitsAndBytes 4-bit (operates on bf16 activations post-dequant) | Compatible with W4A16 (activations already fp16) |
| **Flash Attention 2** | ❌ Incompatible with BnB (FA2 patches pre-dequant attention kernel) | ✅ vLLM uses FA2-equivalent fused kernels internally |
| **Memory saving** | ~30–40% vs naive attention (no N×N materialisation) | ~50–60% vs contiguous KV (no fragmentation + paging) |
| **CUDA graph support** | Partial (compile subgraphs) | Full (entire decode step captured) |

---

### 9.4 vLLM Engine Internals

```
vLLM AsyncLLMEngine
│
├── Scheduler
│     Continuous batching: at every decoding step, the scheduler
│     checks for new requests. If a new request fits in available
│     KV cache blocks, it joins the running batch immediately
│     (no waiting for current batch to finish)
│
├── BlockManager (PagedAttention)
│     Physical blocks: fixed-size GPU memory chunks (16 tokens each)
│     Virtual blocks: per-sequence logical view
│     On eviction: blocks swapped to CPU or beam-search candidates copied
│
├── Model executor
│     CUDA graphs: decode steps (batch=1) captured once at warm start
│     Replay: subsequent steps replay the captured graph → zero kernel launch overhead
│     Prefill steps: run eagerly (variable length, cannot be graphed)
│
├── W4A16 dequant (compressed-tensors backend)
│     Triton kernel: dequantize int4 → fp16 + GEMM fused
│     Group size 128: 1 scale per 128 weights, loaded from GPU memory
│
└── Async generator interface
      engine.generate() → async for req_output in ...
      Each yield: RequestOutput with outputs[0].text = FULL text so far
      Our code: new_text = full_text[prev_text_len:]  → delta for SSE
```

---

### 9.5 Model Artifact Chain

```
Stage              File/Location                    Size     Format
──────────────────────────────────────────────────────────────────────────────
Base model         HF Hub cache                     ~14 GB   safetensors fp16
                   /mnt/c/.cache/huggingface/hub

LoRA adapter       llm/outputs/final_model/         ~100 MB  safetensors bf16
                   adapter_model.safetensors                 (only A/B matrices)
                   adapter_config.json                       (r=16, α=32, 7 mods)

Merged model       llm/outputs/merged_model/        ~14 GB   safetensors fp16
                   model.safetensors                         (base + LoRA fused)

AWQ model          llm/outputs/awq_model/           ~5.26 GB compressed-tensors
                   *.safetensors                             int4 packed
                   config.json                               (quantization_config)
                   tokenizer.json + tokenizer_config.json

Deployed model     ~/voidcode_models/awq_model/    ~5.26 GB ext4 (WSL2 native)
(vLLM loads this)  → vLLM reads via mmap                    ~1 GB/s load speed
```

**Why copy to `~/voidcode_models/`?**
`/mnt/c/` (9P filesystem bridge) reads at ~30 MB/s → loading 5.26 GB takes ~3 minutes.
WSL2 native ext4 reads at ~1 GB/s → loads in ~6 seconds.

---

## 10. Performance Comparison

### vLLM vs HuggingFace

| Metric | HuggingFace (`USE_VLLM=false`) | vLLM (`USE_VLLM=true`) | Improvement |
|--------|-------------------------------|------------------------|-------------|
| Throughput | ~10–20 tok/s | ~80–120 tok/s | **5–8×** |
| Time to first token | ~1–2 s (streaming) | < 1 s | ~2× |
| TEACHING response (1500 tok) | ~90–120 s | ~15–25 s | **5–6×** |
| DEBUG response (300 tok) | ~15–30 s | ~3–5 s | **5–6×** |
| FOLLOWUP response (80 tok) | ~4–8 s | < 1 s | **5–8×** |
| GPU VRAM (model) | ~8 GB | ~5.26 GB | 1.5× less |
| Cold start | ~30–60 s (torch.compile JIT) | ~60–90 s (CUDA graphs) | HF faster first start |
| Warm start | ~30 s | ~40 s | Similar |
| OS requirement | Windows or WSL2 | WSL2 / Linux only | — |

### Quantization Impact

| Model | Size | Quality loss | VRAM |
|-------|------|-------------|------|
| Merged fp16 | ~14 GB | None (reference) | ~14 GB |
| NF4 4-bit (BnB, HF path) | ~4.5 GB | < 1% | ~8 GB (+ activations) |
| W4A16 (llmcompressor, vLLM) | ~5.26 GB | < 1% | ~5.26 GB (+ KV cache) |

W4A16 uses slightly more storage than NF4 but loads faster and integrates natively with vLLM's kernel path.

### Hardware Requirements

| Component | Minimum | Used (RTX 5060 Ti) |
|-----------|---------|---------------------|
| GPU VRAM | 12 GB | 16 GB |
| System RAM (WSL2) | 6 GB | 6 GB (`.wslconfig` cap) |
| Storage | 20 GB free | ~20 GB for all model artifacts |
| CUDA | 12.1+ | 12.x |

---

## 11. Key Architectural Decisions

### Why Hybrid (Fine-tune + Prompt Engineering)?

TEACHING and DEBUG modes require **rigid structural output** — specific tags in specific positions, blanks in code templates, emoji markers per line. The base model Qwen 2.5 7B produces this inconsistently without fine-tuning. EXPLAIN and GENERAL require **natural reasoning** where the base model already excels — fine-tuning on structured examples would degrade these modes.

| Mode | Why fine-tuned? | Why base model? |
|------|----------------|----------------|
| TEACHING | Needs `[EXPLAIN]→[TEMPLATE]→[GUIDE]` reliably | — |
| DEBUG | Needs `🔴/🟢` per-line markers reliably | — |
| FOLLOWUP | Needs brief consistent answers | — |
| EXPLAIN | — | Base model naturally explains concepts well |
| GENERAL | — | Base model handles open-domain topics well |

### Why Merge LoRA Before Quantizing?

vLLM supports LoRA injection at inference time via `LoRARequest`. However, W4A16 quantization changes the weight distributions — quantizing with LoRA still separate, then applying LoRA at runtime causes numerical mismatch between the calibrated quantization scales and the adapter. Merging first ensures the AWQ quantization is calibrated on the **final effective weights**.

Additionally, per-request LoRA injection adds engine overhead (separate GEMM kernels). Pre-merging eliminates this overhead entirely.

### Why vLLM over TGI or Ollama?

| Engine | PagedAttention | Continuous batching | W4A16 native | Async Python API |
|--------|---------------|--------------------|--------------|-----------------:|
| vLLM | ✅ | ✅ | ✅ | ✅ |
| TGI | ✅ | ✅ | ⚠️ partial | ❌ (HTTP only) |
| Ollama | ❌ | ❌ | ✅ | ❌ |
| llama.cpp | ❌ | ❌ | ✅ (GGUF) | ❌ |

vLLM is the only engine with native `compressed-tensors` W4A16 support (via llmcompressor) + async Python API (required for FastAPI `StreamingResponse`).

---

## 12. File Reference

| File | Role |
|------|------|
| `llm/scripts/train.py` | QLoRA fine-tuning loop |
| `llm/scripts/generate_diverse_dataset.py` | Training data generation |
| `llm/scripts/validate_and_test.py` | Data format validation + duplicate detection |
| `llm/scripts/prompts.py` | Mode detection, system prompts, generation configs |
| `llm/data/mode_teaching.jsonl` | Teaching mode training data (45%) |
| `llm/data/mode_debug.jsonl` | Debug mode training data (30%) |
| `llm/data/mode_explain.jsonl` | Explain mode training data (15%) |
| `llm/data/mode_followup.jsonl` | Follow-up mode training data (10%) |
| `llm/outputs/final_model/` | LoRA adapter output (~100 MB) |
| `llm/outputs/merged_model/` | Base + LoRA merged fp16 (~14 GB) |
| `llm/outputs/awq_model/` | W4A16 quantized for vLLM (~5.26 GiB) |
| `llm/outputs/final_model/adapter_config.json` | LoRA config (r=16, alpha=32, 7 modules) |
| `llm/outputs/awq_model/config.json` | Qwen2ForCausalLM + compressed-tensors config |
| `apps/api/scripts/merge_lora.py` | Merges LoRA into base weights (one-time) |
| `apps/api/scripts/quantize_awq.py` | W4A16 quantizes merged model (one-time) |
| `apps/api/src/vllm_engine.py` | vLLM AsyncLLMEngine wrapper + SSE streaming |
| `apps/api/src/main.py` | FastAPI app, HF model loading, mode routing, lifespan |
