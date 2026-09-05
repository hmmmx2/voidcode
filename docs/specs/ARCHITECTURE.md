# VoidCode AI v5.2 — Architecture Reference

> Complete technical reference for the entire project. Covers every layer: frontend, backend, LLM inference, training pipeline, database, and infrastructure. Written so any developer or AI assistant can fully understand the system.

---

## 1. System Overview

Full-stack VoidCode AIing platform that teaches programming through Socratic dialogue. A fine-tuned Qwen 2.5 7B model guides students with structured templates and debug markers — **never giving complete solutions**.

```
Browser → Next.js 16 (Windows :3000)
               ↓  REST + SSE
          FastAPI (WSL2 :8000)
               ├── vLLM AsyncLLMEngine  ← primary inference (USE_VLLM=true)
               │     └── AWQ W4A16 merged model on GPU (~5.26 GiB)
               ├── HuggingFace model.generate()  ← fallback (USE_VLLM=false)
               │     └── BnB NF4 + PEFT LoRA adapter on GPU
               ├── PostgreSQL 15  (Docker :5433)
               ├── Redis 7        (Docker :6380)
               └── Judge0 CE      (Docker :2358)
```

**Tech stack:**

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, Monaco Editor, Radix UI |
| Backend | FastAPI, Uvicorn, SQLAlchemy 2.0 async, Alembic |
| LLM Inference (primary) | vLLM 0.4+, AsyncLLMEngine, W4A16 quantization (compressed-tensors) |
| LLM Inference (fallback) | HuggingFace Transformers, BitsAndBytes NF4, PEFT, torch.compile + SDPA |
| LLM Training | PyTorch 2.2+, HuggingFace Transformers, PEFT, TRL SFTTrainer, BitsAndBytes, llmcompressor |
| Database | PostgreSQL 15 (asyncpg driver) |
| Cache | Redis 7 (aioredis) |
| Code Execution | Judge0 CE v1.13.1 |
| Package Manager | pnpm + Turborepo (monorepo) |

---

## 2. Monorepo Structure

```
voidcode_ai/
├── apps/
│   ├── web/                    # Next.js 16 frontend
│   └── api/                    # FastAPI backend + LLM inference
├── llm/                        # Training pipeline, data, model outputs
├── packages/shared/            # Shared TypeScript types
├── docker-compose.yml          # PostgreSQL, Redis, Judge0
├── start-tunnels.bat           # Cloudflare tunnel launcher
└── ARCHITECTURE.md             # This file
```

### Frontend (`apps/web/src/`)

```
apps/web/src/
├── app/
│   └── (workspace)/
│       ├── layout.tsx                   # Workspace shell
│       └── problems/[id]/page.tsx       # Problem workspace (dynamic route)
├── components/
│   ├── Layout/
│   │   ├── TopNavigation.tsx            # Logo, problem title, difficulty badge, user menu
│   │   └── ResizableLayout.tsx          # 3-column drag-to-resize panel container
│   ├── ProblemPanel/
│   │   ├── ProblemTabs.tsx              # Description / Submission History tabs
│   │   ├── ProblemDescription.tsx       # Markdown, examples, constraints
│   │   └── SubmissionHistory.tsx        # Last 15 submissions with status badges
│   ├── Editor/
│   │   ├── CodeToolbar.tsx              # Language selector, Run / Submit buttons
│   │   ├── MonacoWrapper.tsx            # Monaco editor (dynamic import, SSR-safe)
│   │   └── TestConsole.tsx              # stdout/stderr, test pass/fail output
│   └── VoidCodeAI/
│       ├── VoidCodeAIPanel.tsx             # SSE reader, session mgmt, auto-submit hook
│       ├── ChatMessage.tsx              # Markdown + mode-tag renderer
│       └── ThinkingBlock.tsx            # Collapsible chain-of-thought block
├── lib/
│   ├── api/
│   │   ├── problems.ts                  # GET /v1/problems, GET /v1/problems/{slug}
│   │   ├── judge0.ts                    # POST /v1/execute, POST /v1/submit
│   │   ├── submissions.ts               # GET /v1/submissions
│   │   └── chat.ts                      # Chat session CRUD
│   ├── tokens.ts                        # Design tokens
│   └── utils.ts                         # cn() and helpers
└── ui/
    ├── button.tsx
    ├── tabs.tsx
    └── tooltip.tsx
```

### Backend (`apps/api/`)

```
apps/api/
├── src/
│   ├── main.py                  # FastAPI app, lifespan, all LLM logic (1050+ lines)
│   ├── vllm_engine.py           # vLLM AsyncLLMEngine wrapper
│   ├── database.py              # Async SQLAlchemy engine + session factory
│   ├── redis_client.py          # Redis lifecycle (init_redis, close_redis)
│   ├── models/
│   │   ├── user.py              # User, UserPreferences ORM models
│   │   ├── problem.py           # Problem, TestCase, CodeTemplate ORM models
│   │   ├── submission.py        # Submission, TestCaseResult ORM models
│   │   └── chat.py              # ChatSession, ChatMessage ORM models
│   ├── routers/
│   │   ├── execution.py         # /v1/execute, /v1/submit, /v1/submissions
│   │   ├── problems.py          # /v1/problems, /v1/problems/{slug}
│   │   ├── chat.py              # /v1/chat/sessions/*
│   │   ├── auth.py              # Auth endpoints
│   │   ├── profile.py           # User profile endpoints
│   │   ├── notifications.py     # Notifications
│   │   ├── drafts.py            # Code draft auto-save
│   │   ├── dashboard.py         # Dashboard stats
│   │   └── courses.py           # Course management
│   └── services/
│       ├── judge0_client.py     # HTTP client for Judge0 CE
│       ├── chat_service.py      # Session + message DB operations
│       └── submission_service.py # Submission persistence + auto-prune
├── scripts/
│   ├── seed_problems.py         # Seeds 5 problems + test cases + 4 language templates each
│   ├── merge_lora.py            # Offline: merge LoRA into base model (one-time)
│   └── quantize_awq.py          # Offline: W4A16 quantize merged model for vLLM
├── alembic/                     # DB migration revisions
├── requirements.txt
└── .env.example
```

---

## 3. Frontend

### Components

| Component | Description |
|-----------|-------------|
| `TopNavigation` | Sticky bar: VoidCode logo, problem title, difficulty badge, user profile |
| `ResizableLayout` | 3-panel horizontal layout with drag handles: Problem \| Editor+Console \| VoidCode AI |
| `ProblemDescription` | Renders problem statement, I/O format, examples, constraints |
| `SubmissionHistory` | Last 15 submissions: status badge, runtime, passed/total test count |
| `CodeToolbar` | Language dropdown (Python/JS/C++/Java), Run and Submit buttons |
| `MonacoWrapper` | Monaco Editor with syntax highlighting; dynamic import to avoid Next.js SSR issues |
| `TestConsole` | Tabbed output: stdout, stderr, per-test-case pass/fail after execution |
| `VoidCodeAIPanel` | Full chat UI: SSE stream reader, session selector, message history, auto-submit hook |
| `ChatMessage` | Renders markdown, fenced code blocks, mode tags (`[EXPLAIN]`, `[TEMPLATE]`, `[GUIDE]`, `🔴`, `🟢`) |
| `ThinkingBlock` | Collapsible block for model's `<think>` chain-of-thought with token count badge |

### Key Features

- **3-panel workspace**: Problem | Monaco editor + test console | VoidCode AI (toggleable)
- **SSE streaming**: `ReadableStream` reader; first AI token visible in ~1 s
- **Code execution**: Run → `/v1/execute` (single test); Submit → `/v1/submit` (all tests)
- **Auto-submit**: After code submission, VoidCode AI automatically receives result for review
- **Problem context injection**: `buildProblemFocusedPrompt()` appends problem description + current code to each message so the model has full context
- **Thinking block**: Model `<think>...</think>` content is stripped from the main response and shown in a collapsible block
- **Chat sessions**: Per-problem, persisted to DB; sessions can be switched and deleted

### SSE Read Loop (`VoidCodeAIPanel.tsx`)

```typescript
const response = await fetch(`${API_BASE}/v1/chat/completions`, {
  method: "POST",
  headers: makeHeaders(userId),      // includes X-User-Id header
  body: JSON.stringify({ messages, stream: true, max_tokens: 8192 }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let sseBuffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  sseBuffer += decoder.decode(value, { stream: true });
  const events = sseBuffer.split("\n\n");
  sseBuffer = events.pop() ?? "";          // keep incomplete trailing event

  for (const event of events) {
    const raw = event.trim().slice(6);     // strip "data: "
    if (raw === "[DONE]") break;
    const parsed = JSON.parse(raw);

    if (parsed.type === "thinking") { /* → ThinkingBlock */ }
    if (parsed.type === "usage")    { /* → token counts  */ }
    // delta content → append to streamingContentRef, update message state
  }
}
```

### API Clients (`lib/api/`)

| File | Endpoints |
|------|-----------|
| `problems.ts` | `GET /v1/problems`, `GET /v1/problems/{slug}` |
| `judge0.ts` | `POST /v1/execute`, `POST /v1/submit` |
| `submissions.ts` | `GET /v1/submissions?problem_id=&user_id=` |
| `chat.ts` | `POST/GET /v1/chat/sessions`, `GET/DELETE /v1/chat/sessions/{id}`, `POST /v1/chat/sessions/{id}/messages` |

---

## 4. Backend

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Reports status, GPU memory, DB/Redis/Judge0 connectivity |
| `/v1/chat/completions` | POST | LLM inference — SSE streaming (OpenAI-compatible) |
| `/v1/execute` | POST | Run code against one test case (Judge0 proxy) |
| `/v1/submit` | POST | Run against all test cases, persist submission |
| `/v1/submissions` | GET | Last 15 submissions for a problem + user |
| `/v1/problems` | GET | List published problems |
| `/v1/problems/{slug}` | GET | Full problem: description, test cases, templates |
| `/v1/chat/sessions` | POST | Create a chat session |
| `/v1/chat/sessions` | GET | List sessions for a user |
| `/v1/chat/sessions/{id}` | GET | Retrieve session with all messages |
| `/v1/chat/sessions/{id}` | DELETE | Delete session and messages |
| `/v1/chat/sessions/{id}/messages` | POST | Persist message (with AI metadata) |

**CORS:** Allows `localhost:3000`, `localhost:5173`, and regex for ngrok/trycloudflare tunnel URLs.

**Auth:** No mandatory auth in dev. User ID resolved from `X-User-Id` header; falls back to `DEFAULT_USER_ID` (anonymous user seeded at startup).

### Request / Response Models (Pydantic)

```python
ChatMessage:               { role: str, content: str }

ChatCompletionRequest:     {
  messages: list[ChatMessage],
  max_tokens: int = 4096,
  temperature: float | None = None,   # None → auto from get_generation_config()
  top_p: float = 0.9,
  stream: bool = True,
  repetition_penalty: float = 1.05,
  timeout: int = 180,
}

ThinkingMetadata:          { content, token_count, budget_used (%), budget_total: 2000 }

# Non-streaming response
ChatCompletionResponse:    {
  id, created, model, choices: [ChatCompletionChoice], usage
}

# Streaming response
StreamingResponse:  text/event-stream, media headers: Cache-Control: no-cache,
                    Connection: keep-alive, X-Accel-Buffering: no
```

### Lifespan Hook (`main.py`)

On startup:
1. Connect to PostgreSQL, seed anonymous user
2. Connect to Redis
3. If `USE_VLLM=true` → call `init_engine()` (vLLM path)
4. Else → load HF model with BnB NF4 + PEFT LoRA + SDPA + `torch.compile`, run warmup forward pass (5 tokens) to trigger JIT compilation before first user request

On shutdown: close Redis, close DB engine, `torch.cuda.empty_cache()`

---

## 5. LLM — 5-Mode Architecture

### Mode Detection (`llm/scripts/prompts.py → detect_mode()`)

Evaluated in priority order on every request:

| Priority | Mode | Triggers | Inference Path |
|----------|------|----------|----------------|
| 0 | TEACHING | Problem paste detected (2+ of: "Example:", "Constraints:", "Input/Output") | Fine-tuned |
| 1 | DEBUG | Code block + "fix" / "bug" / "error" / "doesn't work" | Fine-tuned |
| 2 | TEACHING | "how to solve", "implement", "write code for", "give me solution" | Fine-tuned |
| 3 | EXPLAIN | "what is", "explain", "how does X work" + programming context | Base model |
| 4 | FOLLOWUP | Short message, "O(n)?", "faster?", "is this right?" | Fine-tuned |
| 5 | GENERAL | Non-programming fallback | Base model |

### System Prompts

**`FINETUNED_SYSTEM_PROMPT`** — used for TEACHING, DEBUG, FOLLOWUP:
- Defines all 4 mode formats with examples
- Rules: "NEVER give complete solutions", "ALWAYS use templates with blanks"
- **Must be verbatim identical to the system prompt in training JSONL files.** Any divergence causes distribution shift and format collapse.

**`EXPLAIN_SYSTEM_PROMPT`** — used for EXPLAIN (base model, adapter disabled):
- Instructs to quote code first, explain naturally, no format tags
- Internal `<think>` reasoning allowed

**`NON_PROGRAMMING_SYSTEM_PROMPT`** — used for GENERAL:
- Covers Science, Math, Humanities; redirects coding questions to teaching format

### Response Formats

**TEACHING:**
```
[EXPLAIN]
2-3 sentences on the approach.

[TEMPLATE]
```python
def twoSum(nums, target):
    seen = ____          # Line 1
    for i, num in ____:  # Line 2
```

[GUIDE]
Line 1: What data structure gives O(1) lookup?
Line 2: How do we get both index and value?
```

**DEBUG:**
```
I found 2 issues in your code:

**Line 3**
```python
for i in range(len(num)):
```
🔴 **Problem:** Variable name typo — `num` instead of `nums`
🟢 **Think:** Check your function signature. What did you name the list?

Which one would you like to tackle first?
```

**EXPLAIN:** Code block first, then plain-English explanation. No format tags.

**FOLLOWUP:** 1–3 sentences. Builds on conversation context.

### Generation Config

| Mode | Temperature | max_new_tokens | Adapter |
|------|-------------|----------------|---------|
| TEACHING | 0.1 | 8192 | Enabled |
| DEBUG | 0.3 | 4096 | Enabled |
| FOLLOWUP | 0.5 | 4096 | Enabled |
| EXPLAIN | 0.6 | 4096 | **Disabled** |
| GENERAL | 0.7 | 4096 | **Disabled** |

For EXPLAIN and GENERAL, the LoRA adapter is disabled at inference time (`model.disable_adapter()`) so the base model handles the response without fine-tuning influence.

---

## 6. LLM Inference Paths

### Path A — vLLM (Primary, `USE_VLLM=true`, WSL2 only)

```
Request
  → detect_mode()
  → get_system_prompt() + inject at position 0
  → tokenizer.apply_chat_template() → prompt string
  → vllm_engine.generate_stream_vllm()
      → AsyncLLMEngine.generate(prompt, SamplingParams)
      → yields RequestOutput (cumulative text)
      → delta extracted via prev_text_len offset
      → <think> tag state machine strips chain-of-thought
      → emits SSE chunks (thinking / delta / usage / [DONE])
  → StreamingResponse (text/event-stream)
```

**Engine config (`AsyncEngineArgs`):**

| Parameter | Value |
|-----------|-------|
| `model` | `~/voidcode_models/awq_model` (WSL2 ext4) |
| `quantization` | `"compressed-tensors"` (llmcompressor W4A16 format) |
| `dtype` | `float16` (required for W4A16) |
| `gpu_memory_utilization` | `0.90` (~14.4 GiB on 16 GiB GPU) |
| `max_model_len` | `8192` |
| Cold start | ~60–90 s (CUDA graph capture + Dynamo compile, cached after) |
| Warm start | ~40 s |

The AWQ model has LoRA **already merged in**. No per-request LoRA injection. All modes use the same weights; the system prompt provides mode differentiation.

### Path B — HuggingFace Fallback (`USE_VLLM=false`, Windows-compatible)

```
Request
  → detect_mode() → get_system_prompt()
  → tokenizer() → input_ids + attention_mask → .to(model.device)
  → should_disable_adapter = mode in ['explain', 'general']
  → with model.disable_adapter() if should_disable_adapter:
        with torch.inference_mode():
            model.generate(**gen_kwargs)   # TextIteratorStreamer in background thread
  → generate_stream() yields SSE chunks (identical format to vLLM path)
```

**Model load stack:**
- `AutoModelForCausalLM.from_pretrained(BASE_MODEL_ID, quantization_config=bnb_config, attn_implementation="sdpa")`
- `BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=bfloat16)`
- `PeftModel.from_pretrained(model, ADAPTER_PATH)`
- `torch.compile(model, mode="default")` with `suppress_errors=True` (BnB Linear4bit layers fall back to eager; surrounding subgraphs compile)
- Warmup: 5-token greedy decode on startup to trigger JIT

### SSE Streaming Format (both paths — identical)

```
data: {"type":"thinking","content":"...","token_count":N,"budget_used":N,"budget_total":2000}
data: {"id":"...","created":N,"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
data: {"type":"usage","usage":{"prompt_tokens":N,"completion_tokens":N,"total_tokens":N}}
data: {"id":"...","created":N,"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

> `stream: false` returns HTTP 400 when `USE_VLLM=true`. Always use `stream: true`.

---

## 7. LLM Training Pipeline

### Frameworks

| Framework | Role |
|-----------|------|
| **PyTorch 2.2+** | Core tensor computation, CUDA backend, `torch.compile` |
| **HuggingFace Transformers** | `AutoModelForCausalLM`, `AutoTokenizer`, chat template formatting |
| **PEFT** | Injects LoRA adapters into 7 target linear layers; only ~0.5% of params trained |
| **TRL `SFTTrainer`** | Supervised fine-tuning loop: packing, gradient accumulation, logging |
| **BitsAndBytes** | NF4 4-bit quantization during training — reduces base model VRAM from ~28 GB (fp16) to ~8 GB |
| **llmcompressor** | Post-training W4A16 quantization of merged model for vLLM (`quantize_awq.py`) |
| **Alembic** | Database schema migrations (2 revisions) |

### Training Pipeline

```
Qwen/Qwen2.5-7B-Instruct (base, downloaded from HuggingFace Hub)
    + BitsAndBytes NF4 4-bit quantization    → ~8 GB VRAM during training
    + PEFT LoRA (r=16, alpha=32, 7 modules)  → injects trainable adapters
    → TRL SFTTrainer
        Dataset: llm/data/mode_{teaching,debug,explain,followup}.jsonl
        1 epoch, effective batch 32, lr 1e-4 cosine
    → llm/outputs/final_model/               (~100 MB, adapter weights only)

Offline post-processing (one-time):
    merge_lora.py
        PEFT merge_and_unload() → fp16 full weights
    → llm/outputs/merged_model/              (~14 GB)

    quantize_awq.py (llmcompressor W4A16)
    → llm/outputs/awq_model/                 (~5.26 GiB)
    → cp to ~/voidcode_models/awq_model     (WSL2 ext4, fast load)
```

### Model Specification

| Parameter | Value |
|-----------|-------|
| Base Model | Qwen/Qwen2.5-7B-Instruct |
| Fine-tuning Method | QLoRA (4-bit NF4, bfloat16 compute dtype) |
| LoRA rank / alpha | 16 / 32 |
| Target modules | q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj (7) |
| Training epochs | 1 |
| Effective batch size | 32 (2 × 16 gradient accumulation steps) |
| Learning rate | 1e-4 with cosine decay |
| Dataset size | ~1,000 examples across 4 modes |
| Adapter output | ~100 MB (LoRA weights only) |

### Training Data

| Mode | File | Share | Format |
|------|------|-------|--------|
| TEACHING | `llm/data/mode_teaching.jsonl` | 45% | `[EXPLAIN]→[TEMPLATE]→[GUIDE]` |
| DEBUG | `llm/data/mode_debug.jsonl` | 30% | `🔴 Problem / 🟢 Think` per line |
| EXPLAIN | `llm/data/mode_explain.jsonl` | 15% | Code block + natural explanation |
| FOLLOWUP | `llm/data/mode_followup.jsonl` | 10% | Brief 1–3 sentence answers |

Each JSONL record: `{ "id", "mode", "problem", "difficulty", "messages": [{"role","content"},...] }`

The system message in every training record **must match `FINETUNED_SYSTEM_PROMPT` verbatim** — any mismatch at inference time causes distribution shift and format collapse.

### Model Outputs

```
llm/outputs/
├── final_model/       # LoRA adapter only (~100 MB) — train.py output
├── merged_model/      # Base + LoRA merged, fp16 (~14 GB) — merge_lora.py output
└── awq_model/         # W4A16 quantized (~5.26 GiB) — quantize_awq.py output
                       # → copy to ~/voidcode_models/awq_model (WSL2 ext4)
```

---

## 8. Database

### PostgreSQL (port 5433)

**Connection:** `postgresql+asyncpg://alwin:alwin_dev@localhost:5433/alwin_tutor`
**Pool:** `pool_size=5`, `max_overflow=10`, `pool_pre_ping=True`

| Table | Key Columns |
|-------|-------------|
| `users` | `id` (UUID), `email` (unique), `name`, `role` (student/instructor/admin), `password_hash` (nullable), `is_active`, `profile_photo_url`, `timezone` |
| `user_preferences` | `user_id` (1-to-1 FK), `theme`, `preferred_language`, `font_size` |
| `problems` | `id`, `slug` (unique), `title`, `difficulty`, `description`, `examples`, `constraints`, `hints` (JSON), `order_index`, `is_published`, `course_id` (FK nullable) |
| `test_cases` | `id`, `problem_id` (FK), `label`, `inputs` (JSON), `stdin`, `expected_output`, `order_index`, `is_hidden` |
| `code_templates` | `id`, `problem_id` (FK), `language`, `judge0_language_id`, `template_code`, `driver_code`; unique on `(problem_id, language)` |
| `submissions` | `id`, `user_id` (FK), `problem_id` (FK), `source_code`, `language`, `judge0_language_id`, `status`, `passed_tests`, `total_tests`, `overall_runtime_ms`, `overall_memory_kb`; indexed on `(user_id, problem_id, created_at)` |
| `test_case_results` | `id`, `submission_id` (FK), `test_case_id` (FK), `passed`, `stdout`, `stderr`, `compile_output`, `status_id`, `status_description`, `runtime_ms`, `memory_kb`, `expected_output`, `actual_output` |
| `chat_sessions` | `id`, `user_id` (FK), `problem_id` (FK nullable), `title`, `is_active`; indexed on `(user_id, created_at)` |
| `chat_messages` | `id`, `session_id` (FK), `role` (user/assistant/system), `content`, `detected_mode`, `thinking_content`, `thinking_token_count`, `thinking_budget_used`, `prompt_tokens`, `completion_tokens`; indexed on `(session_id, created_at)` |

**Rules:**
- Submissions auto-pruned to 15 most recent per `(user_id, problem_id)` pair
- Anonymous user seeded at startup (`DEFAULT_USER_ID`) — used when `X-User-Id` header is absent
- Seed data: 5 LeetCode-style problems, each with 3 test cases and 4 language templates (Python, JavaScript, C++, Java)

### Redis (port 6380)

Used for chat session caching to reduce DB reads on repeated access.

| Key Pattern | TTL | Content |
|-------------|-----|---------|
| `chat:session:{session_id}` | 5–10 min | Full session + messages JSON |
| `chat:sessions:user:{user_id}` | 5 min | Session list for a user |

Cache invalidated on any message write. Managed by `redis_client.py` using `aioredis`.

---

## 9. Infrastructure (Docker Compose)

| Service | Host Port | Image | Purpose |
|---------|-----------|-------|---------|
| `voidcode-postgres` | 5433 | postgres:16-alpine | Application database |
| `voidcode-redis` | 6380 | redis:7-alpine | Chat session cache |
| `voidcode-judge0` | 2358 | judge0/judge0:1.13.1 | Code execution API |
| `voidcode-judge0-workers` | internal | judge0/judge0:1.13.1 | Execution sandbox workers |
| `voidcode-judge0-postgres` | internal | postgres | Judge0 internal DB |
| `voidcode-judge0-redis` | internal | redis | Judge0 internal queue |

`privileged: true` on Judge0 container is required for sandbox isolation — do not remove.

---

## 10. Environment Variables

**`apps/api/.env`:**

```env
DATABASE_URL=postgresql+asyncpg://alwin:alwin_dev@localhost:5433/alwin_tutor
DATABASE_URL_SYNC=postgresql://alwin:alwin_dev@localhost:5433/alwin_tutor
REDIS_URL=redis://localhost:6380/0
JUDGE0_BASE_URL=http://localhost:2358
BASE_MODEL_ID=Qwen/Qwen2.5-7B-Instruct
ADAPTER_PATH=../../llm/outputs/final_model
USE_VLLM=false          # true → vLLM path (WSL2 + AWQ model required)
```

**`apps/web/.env.local`:**

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
# Replace with Cloudflare tunnel URL when sharing externally
```

---

## 11. Setup & Daily Startup

### Prerequisites

Docker Desktop, Node.js 20+, pnpm, Python 3.12 (in WSL2), CUDA 12.1+ drivers, NVIDIA GPU 16 GB+

For the Docker GPU path, also requires **NVIDIA Container Toolkit** in WSL2:

```bash
# Inside WSL2 — install once, then restart Docker
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify — should print your RTX 5060 Ti
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

---

### First-Time Setup

```bash
# 1. Install frontend dependencies
pnpm install

# 2. Create env files
cp apps/api/.env.example apps/api/.env
cp apps/api/.env.docker.example apps/api/.env.docker   # fill in SECRET_KEY etc.
echo 'NEXT_PUBLIC_API_URL=http://localhost:8000' > apps/web/.env.local

# 3. Start infrastructure (Postgres, Redis, Judge0)
docker compose up -d

# 4. Initialize database
cd apps/api
python -m alembic upgrade head
python -m scripts.seed_problems
cd ../..

# 5. Prepare AWQ model (WSL2, one-time — skip if ~/voidcode_models/awq_model exists)
wsl
source ~/vllm-env/bin/activate
cd '/mnt/c/Users/User/Documents/DUNE project/voidcode_ai'
export PYTHONPATH="$(pwd)"
python3 -m apps.api.scripts.merge_lora       # ~10 min on CPU
python3 -m apps.api.scripts.quantize_awq     # ~15 min on GPU
cp -r llm/outputs/awq_model ~/voidcode_models/awq_model

# 6. (Docker GPU only) Build the GPU image — first time takes ~15 min
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build vllm-api
```

---

### Daily Startup

Two compose stacks depending on what you're doing. Both start in **one terminal on Windows** — no WSL2 session required.

#### Production / Demo (immutable image)

```bash
# Terminal 1 — Postgres, Redis, Judge0, GPU-accelerated FastAPI/vLLM backend
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Tail backend logs — wait for "Application startup complete."
# Cold start ~60–90 s (CUDA graph capture) | Warm start ~40 s
docker logs -f voidcode-vllm-api
```

#### Development (live source code mounts)

```bash
# Terminal 1 — same services, but src/ and prompts.py are mounted from the host
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu.yml \
  -f docker-compose.dev.yml \
  up -d

docker logs -f voidcode-vllm-api   # wait for "Application startup complete."
```

**Inner dev loop** — edit any `.py` file on the host, then:
```bash
docker restart voidcode-vllm-api   # ~40 s warm start (CUDA graphs cached)
curl http://localhost:8000/health    # confirm ready
```

`docker-compose.dev.yml` mounts `apps/api/src/` and `llm/scripts/prompts.py`
directly from the host so changes are live without rebuilding the image.

#### Frontend (both modes)

```bash
# Terminal 2
cd apps/web && pnpm dev
# http://localhost:3000
```

---

### Health Check

```bash
curl http://localhost:8000/health
# {
#   "status": "healthy",
#   "model_loaded": true,          ← true for both vLLM and HF paths
#   "gpu_memory_used_gb": 5.4,
#   "database_connected": true,
#   "redis_connected": true,
#   "judge0_available": true
# }

# Docker GPU: verify GPU is visible inside the container
docker exec voidcode-vllm-api nvidia-smi
```

`model_loaded` is reported correctly for both inference backends:
- `USE_VLLM=true` → queries `vllm_engine.get_engine()` (returns `True` once the engine singleton is initialised)
- `USE_VLLM=false` → checks `model is not None` (HuggingFace path)

---

### Stopping

```bash
# Stop all containers, keep database volumes
docker compose -f docker-compose.yml -f docker-compose.gpu.yml down

# ⚠ Also destroy database volumes (deletes all data)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml down -v
```

GPU memory is released automatically when the container stops. If a stale vLLM
process is still holding VRAM after an unexpected crash:
```bash
# From WSL2 — find and kill the orphaned process
nvidia-smi --query-compute-apps=pid --format=csv,noheader | xargs kill -9
```

### Share Externally (Cloudflare Tunnels)

The app uses **two** free Cloudflare quick tunnels to expose the frontend and
backend over public HTTPS URLs. With the Docker GPU backend, **both tunnels now
run on Windows** — the backend is a Docker container bound to `localhost:8000`
which Windows `cloudflared` can reach directly (unlike the old WSL2 uvicorn process).

> **Prerequisite:** `cloudflared` installed on Windows
> ([download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
> WSL2 `cloudflared` is no longer needed for the backend tunnel.

#### Step 1 — Start the tunnels

Make sure Docker Compose (GPU stack) and the frontend (`pnpm dev`) are running, then:

```bash
start-tunnels.bat
```

Two new windows appear:
| Window | Runs in | Tunnels to |
|--------|---------|------------|
| **Backend (8000)** | Windows (`cloudflared`) | `http://127.0.0.1:8000` |
| **Frontend (3000)** | Windows (`cloudflared`) | `http://127.0.0.1:3000` |

Each window prints a public URL like `https://xxxx-yyyy.trycloudflare.com`.

#### Step 2 — Update `apps/web/.env.local`

Copy both tunnel URLs into `.env.local`:

```env
NEXT_PUBLIC_API_URL=https://<backend-tunnel>.trycloudflare.com
AUTH_URL=https://<frontend-tunnel>.trycloudflare.com
```

Then **restart the frontend** (`Ctrl+C` → `pnpm dev`) so Next.js picks up the
new values.

#### Step 3 — Update Google OAuth Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) →
   **APIs & Services** → **Credentials**
2. Click the OAuth 2.0 Client ID
3. Under **Authorized JavaScript origins**, add:
   - `https://<frontend-tunnel>.trycloudflare.com`
4. Under **Authorized redirect URIs**, add:
   - `https://<frontend-tunnel>.trycloudflare.com/api/auth/callback/google`
5. Click **Save**

#### Step 4 — Update Microsoft (Azure AD) OAuth

1. Go to [portal.azure.com](https://portal.azure.com/) →
   **Microsoft Entra ID** → **App registrations**
2. Click the app registration
3. Go to **Authentication** → **Platform configurations** → **Web**
4. Under **Redirect URIs**, add:
   - `https://<frontend-tunnel>.trycloudflare.com/api/auth/callback/microsoft-entra-id`
5. Click **Save**

#### Step 5 — Test & Share

1. Open the **frontend** tunnel URL in an **incognito window**
2. Sign in with Google or Microsoft to verify OAuth works
3. Share the **frontend** tunnel URL with users

> **Note:** Free quick tunnels generate **random URLs** each time. You will
> need to repeat Steps 2–4 whenever you restart the tunnels. For stable URLs,
> set up a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
> with a fixed subdomain.

---

## 12. Request Flow — End to End

**Example: User asks "How do I solve Two Sum?"**

```
1. VoidCodeAIPanel.tsx
   isProblemRelated() → true
   buildProblemFocusedPrompt() → appends problem description + current code
   POST /v1/chat/completions { messages, stream: true, temperature: 0.1 }

2. main.py — /v1/chat/completions
   prepare_messages_hybrid(request.messages)
   detect_mode("How do I solve Two Sum?") → "teaching"
   get_system_prompt("teaching") → FINETUNED_SYSTEM_PROMPT
   inject system message at index 0
   tokenizer.apply_chat_template() → prompt string

3. vllm_engine.py (USE_VLLM=true)
   AsyncLLMEngine.generate(prompt, SamplingParams(temp=0.1, max_tokens=8192))
   yields RequestOutput → extract delta → emit SSE chunks

4. SSE events → VoidCodeAIPanel SSE reader
   data: {"choices":[{"delta":{"content":"[EXPLAIN]\n"}}]}
   data: {"choices":[{"delta":{"content":"We can use a hash map..."}}]}
   ...
   data: {"type":"usage","usage":{...}}
   data: [DONE]

5. setMessages() → ChatMessage renders [EXPLAIN]/[TEMPLATE]/[GUIDE] tags
   persistMessage() → POST /v1/chat/sessions/{id}/messages → DB
```

---

## 13. Known Issues & Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| TEACHING/DEBUG format collapse | `FINETUNED_SYSTEM_PROMPT` diverged from training-time system prompt | Must match verbatim — `llm/scripts/prompts.py` |
| vLLM repetition loops | LoRA re-applied on model that already has LoRA merged in | Never use `LoRARequest` when model was produced via `merge_and_unload()` |
| GPU memory stuck after Ctrl+C | vLLM EngineCore subprocess holds GPU independently of parent | `nvidia-smi` → find PID → `kill -9` |
| Slow model load | `/mnt/c/` 9P filesystem ~30 MB/s | Copy AWQ model to `~/voidcode_models/` (ext4 ~1 GB/s) |
| `stream: false` → HTTP 400 | vLLM path only supports streaming | Always use `stream: true` with `USE_VLLM=true` |
| `gcc` / `python3.12-dev` missing | vLLM Triton JIT needs system compiler | `sudo apt-get install -y gcc build-essential python3.12-dev` |
| CUDA graphs cold start (~85 s) | First run compiles and captures CUDA graphs | Cached in `~/.cache/vllm/torch_compile_cache/` — ~40 s on subsequent starts |
| `torch.compile` no-op on Windows | Triton has no Windows wheels | Run `uvicorn` inside WSL2 |
| `alembic` command not found | Not on PATH | Use `python -m alembic` |
| Judge0 sandbox fails | Missing `privileged: true` in Docker Compose | Already set — do not remove |
| Cloudflare tunnel IPv6 timeout | Edge connectivity | `start-tunnels.bat` uses `--edge-ip-version 4 --protocol quic` |
