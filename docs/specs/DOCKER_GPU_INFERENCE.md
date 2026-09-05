# Docker GPU Inference — Implementation Prompt

> High-level implementation guide for containerising the VoidCode AI
> backend with GPU-accelerated vLLM inference. This document serves as a
> prompt/blueprint for setting up Docker GPU inference, whether on your
> local RTX 5060 Ti or on cloud GPUs for 150+ students.

---

## 1. Current Architecture (Before Docker)

```
Windows 11
├── Docker Desktop
│   ├── voidcode-postgres        (PostgreSQL 16)
│   ├── voidcode-redis           (Redis 7)
│   ├── voidcode-judge0          (Judge0 code sandbox)
│   └── voidcode-judge0-workers  (Judge0 workers)
│
├── Next.js frontend              (pnpm dev, port 3000)
│
└── WSL2 (Ubuntu)
    └── ~/vllm-env (virtualenv)
        └── uvicorn apps.api.src.main:app
            └── vLLM AsyncLLMEngine
                └── RTX 5060 Ti 16 GB (direct CUDA access)
                    └── Qwen 2.5 7B AWQ model (~5.26 GB)
```

**Problem:** The backend runs bare-metal in WSL2 with manual venv management.
Not reproducible, not portable, hard to deploy to cloud.

---

## 2. Target Architecture (With Docker)

```
Windows 11 / Cloud Server / Any Linux Host
└── Docker Compose
    ├── voidcode-postgres         (unchanged)
    ├── voidcode-redis            (unchanged)
    ├── voidcode-judge0           (unchanged)
    ├── voidcode-judge0-workers   (unchanged)
    │
    └── voidcode-vllm-api         ← NEW: GPU-enabled container
        ├── FastAPI backend (uvicorn)
        ├── vLLM AsyncLLMEngine
        ├── Qwen 2.5 7B AWQ model (mounted volume)
        └── NVIDIA GPU (passed through via Container Toolkit)
```

---

## 3. Prerequisites

### 3.1 NVIDIA Container Toolkit (Local GPU Only)

The NVIDIA Container Toolkit allows Docker containers to access your GPU.

```bash
# Inside WSL2:

# Add NVIDIA package repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# Install
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# Configure Docker runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify — should show your RTX 5060 Ti
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

### 3.2 Model Files

The AWQ model must be accessible to the container via a volume mount:

| Location | Path |
|----------|------|
| **Local (current position)** | `llm/outputs/awq_model/` |
| **Recommended (ext4, fast I/O)** | `~/voidcode_models/awq_model/` |
| **Inside container (mounted)** | `/models/awq_model/` |

---

## 4. GPU-Enabled Dockerfile

Replace the existing `apps/api/Dockerfile` with a GPU-aware version:

```dockerfile
# apps/api/Dockerfile.gpu
# ──────────────────────────────────────────────────────────────
# VoidCode AI — GPU-enabled Backend
# Base: NVIDIA CUDA 12.6 + Python 3.11
# Includes: vLLM, PyTorch (CUDA), FastAPI, all backend deps
# ──────────────────────────────────────────────────────────────

FROM nvidia/cuda:12.6.3-devel-ubuntu24.04 AS base

# Prevent interactive prompts during apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11 and system dependencies
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    build-essential \
    gcc \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.11 as default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

WORKDIR /app

# ── Install Python dependencies ──────────────────────────────
# Install vLLM (includes PyTorch with CUDA)
RUN pip install --no-cache-dir \
    vllm>=0.6.0 \
    uvloop

# Install backend dependencies
COPY apps/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# ── Copy application code ────────────────────────────────────
COPY apps/api/src/ ./apps/api/src/
COPY llm/scripts/prompts.py ./llm/scripts/prompts.py

# ── Environment defaults ─────────────────────────────────────
ENV USE_VLLM=true
ENV PYTHONPATH=/app
ENV HF_HOME=/tmp/hf_cache

# ── Expose port ──────────────────────────────────────────────
EXPOSE 8000

# ── Health check ─────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# ── Start server ─────────────────────────────────────────────
CMD ["uvicorn", "apps.api.src.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--log-level", "info"]
```

> **Note:** The Docker image will be large (~8–12 GB) because it includes
> CUDA, PyTorch, and vLLM. This is normal for GPU inference containers.

---

## 5. Docker Compose — GPU Service

Add the vLLM API service to the existing `docker-compose.yml`, or create a
separate `docker-compose.gpu.yml` for GPU-specific services:

```yaml
# docker-compose.gpu.yml
# ──────────────────────────────────────────────────────────────
# VoidCode AI — GPU-Enabled Backend
#
# Usage:
#   docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
#
# This file extends the base docker-compose.yml with the GPU backend.
# ──────────────────────────────────────────────────────────────

services:
  vllm-api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile.gpu
    container_name: voidcode-vllm-api
    restart: unless-stopped

    # ── GPU Access ──────────────────────────────────────────
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1                 # Number of GPUs to use
              capabilities: [gpu]

    # ── Ports ───────────────────────────────────────────────
    ports:
      - "8000:8000"

    # ── Model Volume ────────────────────────────────────────
    # Mount the quantized model from host into the container
    volumes:
      - ./llm/outputs/awq_model:/models/awq_model:ro
      # Optional: mount .env file
      - ./apps/api/.env:/app/.env:ro

    # ── Environment Variables ───────────────────────────────
    environment:
      - USE_VLLM=true
      - MODEL_PATH=/models/awq_model
      - GPU_MEMORY_UTILIZATION=0.90
      - MAX_MODEL_LEN=8192
      - VLLM_QUANTIZATION=compressed-tensors
      # Database connection (same Docker network)
      - DATABASE_URL=postgresql+asyncpg://alwin:alwin_dev@postgres:5432/alwin_tutor
      - REDIS_URL=redis://redis:6379/0

    # ── Dependencies ────────────────────────────────────────
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

    # ── Resource Limits ─────────────────────────────────────
    shm_size: '2gb'            # Shared memory for PyTorch DataLoader
    ulimits:
      memlock:
        soft: -1
        hard: -1
```

---

## 6. Environment Variables

Create or update `.env` for Docker deployment:

```bash
# apps/api/.env.docker
# ──────────────────────────────────────────────────────────────

# ── vLLM Configuration ──
USE_VLLM=true
MODEL_PATH=/models/awq_model
GPU_MEMORY_UTILIZATION=0.90
MAX_MODEL_LEN=8192
VLLM_QUANTIZATION=compressed-tensors
VLLM_DTYPE=float16

# ── Database (Docker network hostnames) ──
DATABASE_URL=postgresql+asyncpg://alwin:alwin_dev@postgres:5432/alwin_tutor
REDIS_URL=redis://redis:6379/0

# ── Auth & Security ──
SECRET_KEY=<your-secret-key>
NEXTAUTH_SECRET=<your-nextauth-secret>

# ── Judge0 ──
JUDGE0_URL=http://judge0-server:2358
```

---

## 7. Build & Run Commands

### 7.1 Local GPU (Development)

```bash
# Build the GPU image (first time takes 10-15 minutes)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build vllm-api

# Start everything (infrastructure + GPU backend)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Check GPU is visible inside container
docker exec voidcode-vllm-api nvidia-smi

# View vLLM startup logs (wait for model to load, ~60-90 seconds)
docker logs -f voidcode-vllm-api

# Test the endpoint
curl http://localhost:8000/health

# Stop everything
docker compose -f docker-compose.yml -f docker-compose.gpu.yml down
```

### 7.2 Cloud Deployment (RunPod / AWS / GCP)

```bash
# Push image to container registry
docker tag voidcode-vllm-api:latest your-registry.com/voidcode-vllm-api:latest
docker push your-registry.com/voidcode-vllm-api:latest

# Deploy on RunPod (example)
# 1. Upload AWQ model to cloud storage (S3/GCS/RunPod volume)
# 2. Create a GPU pod with the Docker image
# 3. Mount the model volume
# 4. Expose port 8000
```

---

## 8. Scaling to 150 Students (Data Parallel)

For production with many students, run multiple replicas behind a load
balancer:

```yaml
# docker-compose.prod.yml
# ──────────────────────────────────────────────────────────────
# Production: 3 GPU replicas behind Nginx load balancer
# Requires 3 GPUs (or 3 cloud GPU instances)
# ──────────────────────────────────────────────────────────────

services:
  # ── Load Balancer ──────────────────────────────────────────
  nginx:
    image: nginx:alpine
    container_name: voidcode-lb
    ports:
      - "8000:8000"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - vllm-api-1
      - vllm-api-2
      - vllm-api-3

  # ── GPU Replica 1 ──────────────────────────────────────────
  vllm-api-1:
    build:
      context: .
      dockerfile: apps/api/Dockerfile.gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['0']        # First GPU
              capabilities: [gpu]
    volumes:
      - ./llm/outputs/awq_model:/models/awq_model:ro
    environment:
      - USE_VLLM=true
      - MODEL_PATH=/models/awq_model

  # ── GPU Replica 2 ──────────────────────────────────────────
  vllm-api-2:
    build:
      context: .
      dockerfile: apps/api/Dockerfile.gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['1']        # Second GPU
              capabilities: [gpu]
    volumes:
      - ./llm/outputs/awq_model:/models/awq_model:ro
    environment:
      - USE_VLLM=true
      - MODEL_PATH=/models/awq_model

  # ── GPU Replica 3 ──────────────────────────────────────────
  vllm-api-3:
    build:
      context: .
      dockerfile: apps/api/Dockerfile.gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['2']        # Third GPU
              capabilities: [gpu]
    volumes:
      - ./llm/outputs/awq_model:/models/awq_model:ro
    environment:
      - USE_VLLM=true
      - MODEL_PATH=/models/awq_model
```

**Nginx load balancer config:**

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream vllm_backends {
        least_conn;                     # Route to least-busy backend
        server vllm-api-1:8000;
        server vllm-api-2:8000;
        server vllm-api-3:8000;
    }

    server {
        listen 8000;

        location / {
            proxy_pass http://vllm_backends;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;

            # SSE support (critical for streaming)
            proxy_set_header Connection '';
            proxy_buffering off;
            proxy_cache off;
            chunked_transfer_encoding on;
            proxy_read_timeout 300s;
        }
    }
}
```

---

## 9. Backend Code Changes Required

The FastAPI backend needs minor updates to read model path from environment
variables instead of hardcoded paths:

### 9.1 vLLM Engine Initialization

```python
# In apps/api/src/vllm_engine.py — update model path resolution

import os

MODEL_PATH = os.getenv("MODEL_PATH", "llm/outputs/awq_model")
GPU_MEMORY_UTIL = float(os.getenv("GPU_MEMORY_UTILIZATION", "0.90"))
MAX_MODEL_LEN = int(os.getenv("MAX_MODEL_LEN", "8192"))
QUANTIZATION = os.getenv("VLLM_QUANTIZATION", "compressed-tensors")

# Use these variables instead of hardcoded values in engine initialization
```

### 9.2 Health Check Endpoint

```python
# In apps/api/src/main.py — add health check

@app.get("/health")
async def health_check():
    """Health check for Docker and load balancer."""
    return {
        "status": "healthy",
        "model_loaded": vllm_engine.is_ready(),
        "gpu_available": torch.cuda.is_available()
    }
```

---

## 10. Implementation Checklist

### Phase 1: Local Docker GPU (Development)

- [ ] Install NVIDIA Container Toolkit in WSL2
- [ ] Verify `docker run --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi` works
- [ ] Create `Dockerfile.gpu` with CUDA base image
- [ ] Create `docker-compose.gpu.yml` with GPU device reservation
- [ ] Update `vllm_engine.py` to read config from environment variables
- [ ] Add `/health` endpoint to FastAPI
- [ ] Build and test the GPU container locally
- [ ] Verify SSE streaming works through Docker networking
- [ ] Verify database connectivity (Docker network hostnames)
- [ ] Update `.env` with Docker-specific database URLs
- [ ] Test end-to-end: frontend → Docker backend → vLLM → GPU → response

### Phase 2: Cloud Readiness Preparation (No Cloud Account Required)

> **Goal:** Make the codebase portable and cloud-ready so that when a cloud
> provider or university GPU cluster is decided on, deployment is plug-and-play.
> None of these steps require a cloud account, GPU hardware, or spending money.

**Codebase portability:**
- [ ] Ensure all hardcoded paths are replaced with environment variables
- [ ] Ensure `MODEL_PATH`, `DATABASE_URL`, `REDIS_URL` can be overridden via env
- [ ] Verify the Docker image runs identically on a clean Linux VM (not just WSL2)
- [ ] Create `.env.docker.example` with all required variables documented
- [ ] Add `BACKEND_URL` env var to frontend so it can point to any backend URL

**Model packaging:**
- [ ] Document exact model export steps (merge LoRA → quantise → verify)
- [ ] Create a `scripts/export_model.sh` that automates merge + quantise
- [ ] Test that the AWQ model loads correctly from a Docker volume mount
- [ ] Document model file sizes and checksums for integrity verification

**Multi-replica readiness:**
- [ ] Create `docker-compose.prod.yml` with multi-replica template (Section 8)
- [ ] Create `nginx.conf` with SSE-compatible load balancer config (Section 8)
- [ ] Test the Nginx + single replica setup locally to verify SSE streaming
- [ ] Add a `/health` endpoint that the load balancer can poll

**Documentation for future deployment team:**
- [ ] Document cloud provider comparison table (RunPod vs Modal vs AWS vs GCP vs university HPC)
- [ ] Document VRAM / RAM requirements per student count (see earlier estimates)
- [ ] Document estimated cost per provider at 30 / 100 / 150 student scale
- [ ] Write a deployment runbook: step-by-step instructions for whoever deploys
- [ ] Document how to update the model in production (rolling update strategy)

**Security preparation:**
- [ ] Ensure no secrets are baked into the Docker image
- [ ] All secrets passed via environment variables or mounted `.env` file
- [ ] Document which ports need to be exposed (8000) and which must NOT be
- [ ] Add rate limiting / concurrency limiter to FastAPI (protect against overload)

### Phase 3: CI/CD (Automation)

- [ ] GitHub Actions workflow to build GPU image on model update
- [ ] Automated deployment to cloud on merge to main
- [ ] Model versioning (tag Docker images with model version)
- [ ] Rollback strategy (keep previous image)

---

## 11. Cost Estimates

| Scenario | Infrastructure | Monthly Cost |
|----------|---------------|:---:|
| Development (local) | Your RTX 5060 Ti + Docker | **$0** (electricity only) |
| Pilot (30 students, 4 hrs/week) | 1× RunPod A10G | **~$18/month** |
| Production (150 students, 8 hrs/week) | 3× RunPod A10G | **~$106/month** |
| Scale to zero (off-hours) | Serverless (Modal) | **~$40–80/month** |
| University HPC | Existing cluster | **$0** (already paid for) |

---

## 12. File Structure After Implementation

```
voidcode_ai/
├── docker-compose.yml               # Existing: Postgres, Redis, Judge0
├── docker-compose.gpu.yml            # NEW: GPU backend service
├── docker-compose.prod.yml           # NEW: Multi-replica production
├── nginx.conf                        # NEW: Load balancer config
├── apps/
│   ├── api/
│   │   ├── Dockerfile                # Existing: CPU-only (kept as fallback)
│   │   ├── Dockerfile.gpu            # NEW: CUDA + vLLM + PyTorch
│   │   ├── .env                      # Existing: local env vars
│   │   ├── .env.docker               # NEW: Docker-specific env vars
│   │   └── src/
│   │       ├── main.py               # MODIFIED: add /health endpoint
│   │       └── vllm_engine.py        # MODIFIED: env var configuration
│   └── web/                          # Unchanged
└── llm/
    └── outputs/
        └── awq_model/                # Mounted as volume into container
```
