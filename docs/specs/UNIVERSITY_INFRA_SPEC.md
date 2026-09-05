# VoidCode AI v5.3 — Hardware Specification

**Project:** VoidCode AI v5.3
**Date:** March 2026

---

## 1. Development PC Specification

| Component | Spec |
|-----------|------|
| OS | Windows 11 Pro (Build 26200) |
| CPU | AMD Ryzen 5 8400F — 6 Cores / 12 Threads @ 4.2 GHz |
| RAM | 32 GB DDR5-4800 (2 × 16 GB Acer Predator) |
| GPU | NVIDIA RTX 5060 Ti — 16 GB GDDR7 |
| Storage | WD Green SN350 — 1 TB NVMe SSD |
| Motherboard | Gigabyte B650M GAMING WIFI (AMD AM5) |
| Virtualization | WSL2 + Ubuntu 22.04 LTS |

---

## 2. Minimum Requirements to Run This Project

### Running the VoidCode AI (Inference)

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| GPU VRAM | **12 GB** | 16 GB |
| System RAM | 16 GB | 32 GB |
| Storage | 50 GB free | 120 GB SSD |
| GPU | NVIDIA RTX 30 series or newer | NVIDIA RTX 40 series |
| OS | Windows 11 + WSL2 | Ubuntu 22.04 LTS |
| CUDA | 12.1+ | 12.6+ |

> **Why 12 GB minimum?** Inference alone uses 10.20 GB (5.26 GB model + 0.50 GB engine + 4.44 GB conversation cache). Anything below 12 GB cannot run the full vLLM inference stack.

### Training the Model (Fine-tuning)

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| GPU VRAM | **12 GB** | 16 GB |
| System RAM | 16 GB *(may crash)* | 32 GB |
| Storage | 80 GB free | 120 GB SSD |
| CUDA | 12.1+ | 12.6+ |
| Training time (1 epoch, 1,850 examples) | ~5–6 hours | ~4–5 hours |

> **Why 12 GB minimum?** Training peaks at ~9.52 GB VRAM. A 12 GB GPU leaves ~2.5 GB headroom for spikes. On 8 GB the training process will almost certainly crash at peak.

---

## 3. VRAM Usage on Dev PC

How the 16 GB GPU memory is used when the project is running.

### During Inference (serving students)

| What uses VRAM | Amount |
|----------------|-------:|
| AI model — compressed (AWQ W4A16) | 5.26 GB |
| vLLM engine overhead | 0.50 GB |
| Conversation cache (KV cache) | 8.64 GB |
| **Total used** | **14.40 GB** |
| Free / headroom | 1.60 GB |

### During Training (fine-tuning the model)

| What uses VRAM | Amount |
|----------------|-------:|
| AI model — 4-bit compressed (NF4) | 3.50 GB |
| LoRA adapter + optimizer states | 0.52 GB |
| Activations during forward pass | 2.50 GB |
| Temporary peak during backward pass | 2.00 GB |
| CUDA overhead | 1.00 GB |
| **Total peak** | **~9.52 GB** |
| Free / headroom | ~6.48 GB |

---

## 4. System RAM Usage on Dev PC

How the 32 GB system memory is used.

### While Running the VoidCode AI

| What uses RAM | Amount |
|---------------|-------:|
| Windows 11 | 4.00 GB |
| WSL2 (Linux environment) | 0.50 GB |
| Docker engine | 0.50 GB |
| Database (PostgreSQL) | 0.30 GB |
| Cache (Redis) | 0.10 GB |
| Code runner (Judge0) | 0.50 GB |
| AI backend (FastAPI + vLLM) | 2.70 GB |
| Website frontend (Next.js) | 0.80 GB |
| **Total used** | **~9.40 GB** |
| Free / headroom | ~22.60 GB |

### While Training the Model

| What uses RAM | Amount |
|---------------|-------:|
| Windows 11 | 4.00 GB |
| WSL2 (Linux environment) | 1.00 GB |
| Training script (Python) | 2.00 GB |
| Model load into RAM before GPU compression | 14.00 GB |
| Training dataset | 0.50 GB |
| Data pipeline | 0.50 GB |
| **Total peak** | **~22.00 GB** |
| Free / headroom | ~10.00 GB |

> The 14 GB spike happens because the full model must load into system RAM first, then get compressed onto the GPU. Once that's done, RAM usage drops back to ~8 GB. This is why 32 GB RAM is strongly recommended — 16 GB would barely survive this step.

---

## 5. University AI Lab Cluster

The lab runs multiple workstations, each hosting a full copy of the model. A load balancer splits student traffic evenly across machines. No single model is split across GPUs — each machine is self-contained.

```
        Students
           │
    ┌──────▼──────┐
    │ Load Balancer│
    └──────┬──────┘
     ┌─────┼─────┐
     ▼     ▼     ▼
  Node A  Node B  Node C  ...
  Full    Full    Full
  model   model   model
```

**Inference capacity scales with number of nodes:**

| Nodes | Concurrent Students |
|:-----:|:-------------------:|
| 1 | 5–10 |
| 2 | 10–20 |
| 4 | 20–40 |
| 8 | 40–80 |

**Distributed training across nodes (PyTorch DDP):**

When retraining, multiple machines process different chunks of data simultaneously and sync gradients over the LAN.

| Nodes | Training Time (1 epoch) |
|:-----:|:-----------------------:|
| 1 | ~5–6 hours |
| 2 | ~2.5–3 hours |
| 4 | ~1.5–2 hours |
| 8 | ~1 hour |
