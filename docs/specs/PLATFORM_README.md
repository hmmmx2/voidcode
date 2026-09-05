# VoidCode AI

A full-stack VoidCode AIing platform that teaches programming through Socratic dialogue. A fine-tuned Qwen 2.5 7B model guides students with structured hints and debug markers — never giving complete solutions.

---

## Architecture

```
Browser (localhost:3000)
    │  REST + Server-Sent Events
    ▼
Next.js 16  ─────────────────────────────────────────────
    │  NEXT_PUBLIC_API_URL
    ▼
FastAPI  (localhost:8000)
    ├── vLLM AsyncLLMEngine          ← GPU inference (primary)
    │     └── Qwen 2.5 7B · W4A16 AWQ · ~5.3 GiB VRAM
    ├── HuggingFace model.generate() ← CPU/GPU fallback
    ├── PostgreSQL 15  (Docker :5433)
    ├── Redis 7        (Docker :6380)
    └── Judge0 CE      (Docker :2358) ← code execution sandbox
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, Monaco Editor |
| Backend | FastAPI, SQLAlchemy 2.0 async, Alembic, Uvicorn |
| LLM Inference | vLLM `AsyncLLMEngine`, W4A16 compressed-tensors (primary) |
| LLM Training | PyTorch, HuggingFace Transformers, PEFT, TRL, BitsAndBytes |
| Infrastructure | Docker Compose, NVIDIA Container Toolkit, Cloudflare Tunnels |

### LLM — 5-Mode Response System

Every message is classified in priority order and routed to the appropriate system prompt and generation config:

| Mode | Trigger | Response Format | Temp |
|------|---------|----------------|------|
| **TEACHING** | Problem paste or "how to solve / implement" | `[EXPLAIN] → [TEMPLATE with ____] → [GUIDE]` | 0.1 |
| **DEBUG** | Code block + error keywords | Line-by-line `🔴 Problem / 🟢 Think` markers | 0.3 |
| **FOLLOWUP** | Short follow-up or complexity question | 1–3 sentence answer | 0.5 |
| **EXPLAIN** | "what is / explain / how does" | Code block + plain-English explanation | 0.6 |
| **GENERAL** | Non-programming fallback | Conversational academic response | 0.7 |

The model was fine-tuned with QLoRA (r=16, ~1,000 examples) on Qwen 2.5 7B-Instruct, then merged and quantized to W4A16 for vLLM serving. Teaching, Debug, and Follow-up modes use the fine-tuned weights; Explain and General use the base model behaviour retained through training data balance.

---

## Prerequisites

| Requirement | Notes |
|------------|-------|
| Docker Desktop | WSL2 backend enabled |
| NVIDIA GPU ≥ 16 GB VRAM | RTX 5060 Ti or better |
| NVIDIA Container Toolkit | Install once in WSL2 (see below) |
| Node.js 20+ and pnpm | Frontend tooling |
| AWQ model | `~/voidcode_models/awq_model` in WSL2 ext4 |

**Install NVIDIA Container Toolkit (WSL2, one-time):**

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

---

## First-Time Setup

```bash
# 1. Install frontend dependencies
pnpm install

# 2. Create environment files
cp apps/api/.env.example apps/api/.env
cp apps/api/.env.docker.example apps/api/.env.docker   # fill in SECRET_KEY
echo 'NEXT_PUBLIC_API_URL=http://localhost:8000' > apps/web/.env.local

# 3. Start infrastructure (Postgres, Redis, Judge0)
docker compose up -d

# 4. Run database migrations and seed problems
cd apps/api
python -m alembic upgrade head
python -m scripts.seed_problems
cd ../..

# 5. Prepare the AWQ model (WSL2, one-time — skip if ~/voidcode_models/awq_model exists)
wsl
source ~/vllm-env/bin/activate
cd '/mnt/c/Users/User/Documents/DUNE project/voidcode_ai'
export PYTHONPATH="$(pwd)"
python3 -m apps.api.scripts.merge_lora       # ~10 min — merges LoRA into base weights
python3 -m apps.api.scripts.quantize_awq     # ~15 min — W4A16 quantization for vLLM
cp -r llm/outputs/awq_model ~/voidcode_models/awq_model

# 6. Build the GPU Docker image (first time ~15 min)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build vllm-api
```

---

## Daily Startup

### Production — immutable image

```bash
# Start all services (Postgres, Redis, Judge0, vLLM API)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Wait for the vLLM engine — cold start ~60–90 s, warm start ~40 s
docker logs -f voidcode-vllm-api

# Start the frontend (separate terminal)
cd apps/web && pnpm dev
# → http://localhost:3000
```

### Development — live source code mounts

```bash
# API source and prompts.py are mounted from the host — no image rebuild needed
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu.yml \
  -f docker-compose.dev.yml \
  up -d

docker logs -f voidcode-vllm-api   # wait for "Application startup complete."
cd apps/web && pnpm dev
```

**Edit → restart cycle:**
```bash
# After changing any .py file — ~40 s restart, no rebuild
docker restart voidcode-vllm-api
curl http://localhost:8000/health
```

### Health check

```bash
curl http://localhost:8000/health
# {"status":"healthy","model_loaded":true,"gpu_memory_used_gb":5.4,...}
```

### Stop

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml down       # keep data
docker compose -f docker-compose.yml -f docker-compose.gpu.yml down -v    # ⚠ wipes DB
```

---

## Share Externally (Cloudflare Tunnels)

Run `start-tunnels.bat` from Windows after both Docker and `pnpm dev` are running. Two tunnel URLs will appear — copy the **backend** URL into `apps/web/.env.local` as `NEXT_PUBLIC_API_URL`, then restart `pnpm dev` and share the **frontend** URL.

See [`TUNNEL_SETUP.md`](TUNNEL_SETUP.md) for named tunnel setup and OAuth redirect URI configuration.

---

## Documentation

| File | Contents |
|------|---------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full technical reference — all layers, endpoints, DB schema, inference paths |
| [`LLM_ARCHITECTURE.md`](LLM_ARCHITECTURE.md) | LLM deep dive — training, quantization, vLLM internals, SSE format |
| [`FUTURE_IMPLEMENTATION.md`](FUTURE_IMPLEMENTATION.md) | Roadmap — Unsloth, MLflow, DPO, speculative decoding, observability |
| [`ROADMAP_LLM_LEARNING.md`](ROADMAP_LLM_LEARNING.md) | Self-study guide — transformers → fine-tuning → deployment |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code instructions for this repository |
