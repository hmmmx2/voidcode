#!/usr/bin/env python3
"""
VoidCode AI - FastAPI Inference Server (v5.2 - Hybrid Architecture)

ARCHITECTURE:
- FINE-TUNED: TEACHING, DEBUG, FOLLOWUP (custom formats via LoRA)
- PROMPT-ENGINEERED: EXPLAIN (base model + optimized prompt)

This hybrid approach:
1. Uses fine-tuning only for behaviors requiring custom formats
2. Leverages base model strength for natural explanations
3. Automatically detects mode from user query
4. Applies mode-specific generation parameters

Usage:
    python serve_v52.py
    python serve_v52.py --port 8000
"""

import argparse
import asyncio
import contextvars
import json
import logging
import os
import re
import sys
import time
import uuid
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path
from threading import Thread
from typing import Any

# torch / transformers are only available in the HF and vLLM paths.
# The SGLang path runs in a CPU-only container — guard all heavy imports.
try:
    import torch
    import torch._dynamo  # P2: needed to set suppress_errors before torch.compile
    _TORCH_AVAILABLE = True
except ImportError:
    torch = None  # type: ignore[assignment]
    _TORCH_AVAILABLE = False

try:
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        TextIteratorStreamer,
    )
    _TRANSFORMERS_AVAILABLE = True
except ImportError:
    _TRANSFORMERS_AVAILABLE = False

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# peft is only needed in the HF path (USE_VLLM=false).
# In the vLLM/Docker path, LoRA is already merged into the AWQ weights at
# quantisation time, so peft is never imported and does not need to be installed.
# Import is deferred to load_model() to keep the vLLM container dependency-free.
from . import config, identity, knowledge_cache, metering, multimodal, ratelimit
from .database import AsyncSessionLocal
from .services import gpu_sweep_service, gpu_wallet_service
from .schemas.chat import MessageContent
from .routers.auth import router as auth_router
from .routers.chat import router as chat_router
from .routers.dashboard import router as dashboard_router
from .routers.drafts import router as drafts_router
from .routers.execution import router as execution_router
from .routers.interviews import router as interviews_router
from .routers.notifications import router as notifications_router
from .routers.papers import router as papers_router
from .routers.problems import router as problems_router
from .routers.profile import router as profile_router
from .routers.recommendations import router as recommendations_router

# Add llm/scripts directory to path for prompts module
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
LLM_DIR = PROJECT_ROOT / "llm"
sys.path.insert(0, str(LLM_DIR / "scripts"))

# E402 is correct here and the import still has to stay: `prompts` lives in llm/scripts, which
# only becomes importable after the sys.path.insert immediately above.
from prompts import (  # noqa: E402
    DEBUG_LOCALISE_SCHEMA,
    PE_DEBUG_HINT_PROMPT,
    PE_DEBUG_LOCALISE_PROMPT,
    detect_frustration,
    detect_mode,
    get_generation_config,
    get_system_prompt,
    looks_like_debug_submission,
    strip_thinking_tags,
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- Configuration ---
BASE_MODEL_ID = os.getenv("BASE_MODEL_ID", "Qwen/Qwen2.5-7B-Instruct")
DEFAULT_ADAPTER_PATH = str(LLM_DIR / "outputs" / "final_model")
ADAPTER_PATH = os.getenv("ADAPTER_PATH", DEFAULT_ADAPTER_PATH)

# P4: vLLM feature flag — set USE_VLLM=true in environment to activate.
# Requires: AWQ-quantized model at llm/outputs/awq_model/ (run merge_lora.py
# then quantize_awq.py offline first). Must run in WSL2/Linux — vLLM has no
# native Windows support. When false, HuggingFace model.generate() is used.
USE_VLLM = os.getenv("USE_VLLM", "false").lower() == "true"

# SGLang feature flag — set USE_SGLANG=true to delegate inference to a
# separate sglang-server container via OpenAI-compatible HTTP API.
# Benefits: RadixAttention caches system-prompt KV, ~3-4x faster per-request
# after warmup; no GPU/torch deps in this container.
USE_SGLANG = os.getenv("USE_SGLANG", "false").lower() == "true"
SGLANG_BASE_URL = os.getenv("SGLANG_BASE_URL", "http://sglang-server:30000/v1")
SGLANG_MODEL_NAME = os.getenv("SGLANG_MODEL_NAME", "default")

# Client timeout for SGLang calls. MUST exceed the longest generation any mode can ask for, or the
# request is cut off mid-answer and the learner sees an error on exactly the questions that needed
# the most explanation.
#
# The old value was 120s, which was never long enough for this config:
#   teaching  max_new_tokens=8192   debug/explain/general  4096
# Measured on the local RTX 5060 Ti serving Qwen3.5-9B fp8: 18.6 tok/s, so 8192 tokens is ~440s and
# 4096 is ~220s. 120s truncates every mode except followup (1024) and empathy (512).
#
# This is not only a slow-hardware problem. At a datacentre-class ~80 tok/s an 8192-token teaching
# answer still takes ~102s, so 120s left no margin for prefill on long code context either. The
# thinking phase makes it worse: those tokens are spent before the visible answer begins.
SGLANG_TIMEOUT_SECONDS = float(os.getenv("SGLANG_TIMEOUT_SECONDS", "900"))

# ── Concurrency limiter ──────────────────────────────────────────────────────
# Limits concurrent LLM inference requests to prevent OOM / queue overload.
# SGLang (USE_SGLANG=true): default 16 — SGLang handles batching internally;
#   this limits the FastAPI queue depth only.
# vLLM  (USE_VLLM=true) : default 8  — vLLM batches internally; guards endpoint queue.
# HF    (USE_VLLM=false): default 2  — model.generate() runs in a thread; > 2
#   concurrent requests risk GPU OOM on 16 GB VRAM.
# Override via MAX_CONCURRENT_REQUESTS env var (e.g. in docker-compose.sglang.yml).
_MAX_CONCURRENT_REQUESTS = int(
    os.getenv("MAX_CONCURRENT_REQUESTS", "16" if USE_SGLANG else ("8" if USE_VLLM else "2"))
)
_inference_semaphore = asyncio.Semaphore(_MAX_CONCURRENT_REQUESTS)

# Global model references
# HF path:     model + tokenizer loaded in-process
# vLLM path:   vllm_engine module manages the engine; tokenizer loaded here
# SGLang path: _sglang_client (AsyncOpenAI) — no model/tokenizer in this process
model = None
tokenizer = None
_sglang_client = None  # openai.AsyncOpenAI pointing at sglang-server
executor = ThreadPoolExecutor(max_workers=2)


def load_model(adapter_path: str):
    """Load the fine-tuned model with LoRA adapter."""
    global model, tokenizer

    logger.info("=" * 60)
    logger.info("VOIDCODE AI v5.2 - HYBRID ARCHITECTURE")
    logger.info("=" * 60)
    logger.info("Fine-tuned modes: TEACHING, DEBUG, FOLLOWUP")
    logger.info("Prompt-engineered mode: EXPLAIN")

    # Verify adapter exists
    if not os.path.exists(adapter_path):
        raise FileNotFoundError(f"LoRA adapter not found at: {adapter_path}")

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. GPU required.")

    gpu_name = torch.cuda.get_device_name(0)
    gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1e9
    logger.info(f"GPU: {gpu_name} ({gpu_memory:.1f} GB)")

    # 4-bit quantization config
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    # ── P3: Select best available attention implementation ─────────────────
    # Flash Attention 2 is EXCLUDED — incompatible with BitsAndBytes 4-bit:
    # BnB wraps q/k/v projections in Linear4bit; FA2 requires patching the raw
    # attention kernel before dequantization, which BnB's dispatch path blocks.
    # HuggingFace raises ValueError if both load_in_4bit=True and FA2 are set.
    #
    # SDPA (Scaled Dot Product Attention) IS compatible: it fuses the softmax
    # on bf16 activations AFTER BnB dequantization. PyTorch 2.0+ built-in,
    # no extra install. ~15–25% speedup for long sequences (teaching mode).
    _attn_impl = "eager"   # safe fallback
    if hasattr(torch.nn.functional, "scaled_dot_product_attention"):
        _attn_impl = "sdpa"
        logger.info("Attention implementation: SDPA (BnB 4-bit compatible, PyTorch >= 2.0)")
    else:
        logger.info("Attention implementation: eager (SDPA requires PyTorch >= 2.0)")

    # ── Resolve model source ──────────────────────────────────────────────────
    # When running in WSL2 without internet access, using the HuggingFace repo ID
    # ("Qwen/Qwen2.5-7B-Instruct") causes transformers to attempt a network HEAD
    # request before falling back to cache — timing out after 7+ minutes of retries.
    # To skip the network check entirely, resolve the local snapshot path directly
    # from the HF hub cache. Falls back to the repo ID (online download) if not found.
    #
    # Search order:
    #   1. Windows HF cache via WSL2 path (/mnt/c/Users/<user>/.cache/huggingface)
    #      — has full model shards (4 × safetensors) at ~30 MB/s read speed
    #   2. Linux HF cache (~/.cache/huggingface) — may only have metadata symlinks
    #   3. Repo ID fallback (requires internet)
    _model_source = BASE_MODEL_ID
    try:
        import glob as _glob

        from huggingface_hub import try_to_load_from_cache

        def _has_model_weights(directory: str) -> bool:
            """Return True if the directory has at least one model weight shard."""
            return bool(_glob.glob(os.path.join(directory, "*.safetensors")) or
                        _glob.glob(os.path.join(directory, "*.bin")))

        # Candidate cache directories to search (in priority order)
        _cache_candidates = [
            # Windows cache accessible from WSL2 — has full shards
            "/mnt/c/Users/User/.cache/huggingface/hub",
            # Linux HF cache (may only have metadata)
            None,  # None = default (~/.cache/huggingface/hub)
        ]

        for _cache_dir in _cache_candidates:
            try:
                _kwargs = {"cache_dir": _cache_dir} if _cache_dir else {}
                _cached = try_to_load_from_cache(BASE_MODEL_ID, "config.json", **_kwargs)
                if _cached and not isinstance(_cached, type(None)):
                    _snapshot_dir = os.path.dirname(_cached)
                    if os.path.isdir(_snapshot_dir) and _has_model_weights(_snapshot_dir):
                        _model_source = _snapshot_dir
                        logger.info(f"Using local HF cache: {_model_source}")
                        break
            except Exception:
                continue
    except Exception:
        pass  # huggingface_hub not available or cache lookup failed — use repo ID

    logger.info(f"Loading base model: {_model_source}")
    try:
        model = AutoModelForCausalLM.from_pretrained(
            _model_source,
            quantization_config=bnb_config,
            device_map="auto",
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
            attn_implementation=_attn_impl,
        )
        logger.info(f"Base model loaded with attn_implementation='{_attn_impl}'")
    except Exception as _attn_err:
        logger.warning(f"attn_implementation='{_attn_impl}' rejected: {_attn_err}")
        logger.warning("Retrying with eager attention (no VRAM leak — failed before weight allocation)")
        model = AutoModelForCausalLM.from_pretrained(
            _model_source,
            quantization_config=bnb_config,
            device_map="auto",
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        )
        logger.info("Base model loaded with eager attention (fallback)")

    logger.info("Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(
        _model_source,
        trust_remote_code=True,
        padding_side="left",
    )

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        tokenizer.pad_token_id = tokenizer.eos_token_id

    logger.info(f"Loading LoRA adapter: {adapter_path}")
    from peft import PeftModel  # HF path only — not installed in the vLLM container
    model = PeftModel.from_pretrained(model, adapter_path)
    model.eval()
    model.config.use_cache = True

    # ── P2: torch.compile ─────────────────────────────────────────────────
    # Applied AFTER PeftModel wrapping so LoRA layers are included.
    # mode="default": safe for BnB 4-bit. "reduce-overhead" requires static
    # shapes + CUDA graphs, which clash with BnB's dynamic dequantization
    # dispatch — use "default" instead.
    # suppress_errors=True: Dynamo falls back to eager for BnB Linear4bit
    # layers (custom CUDA ops, not traceable by fx) while still compiling the
    # surrounding pure-PyTorch subgraphs (attention softmax, residual adds,
    # RMSNorm, positional embeddings).
    #
    # NOTE: Triton (required for kernel codegen) has no native Windows support.
    # Run uvicorn inside WSL2 for full speedup. The try/except makes this a
    # safe no-op on native Windows — falls back to eager automatically.
    torch._dynamo.config.suppress_errors = True
    try:
        model = torch.compile(model, mode="default")
        logger.info("torch.compile applied (mode=default) — Triton JIT on first forward pass")
    except Exception as _compile_err:
        logger.warning(f"torch.compile unavailable (WSL2 required for Triton): {_compile_err}")
        logger.info("Continuing with eager execution (no performance impact on Windows host)")

    torch.cuda.empty_cache()

    logger.info("=" * 60)
    logger.info("MODEL LOADED SUCCESSFULLY")
    logger.info("=" * 60)

    return model, tokenizer


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage model + database + redis lifecycle."""
    global model, tokenizer

    # 0. Refuse to start a misconfigured production process.
    #
    # FIRST, before the database, Redis or the model — the point is to fail in the first second
    # with a named variable rather than at 3 a.m. on the first password reset. This call is what
    # `config.py` exists for and it had never been made, so every guardrail in it was inert: empty
    # ALLOWED_ORIGINS, empty INTERNAL_API_SECRET, reset links still pointing at localhost, and a
    # rate-limit pepper still set to the shipped default all passed silently.
    #
    # Deliberately NOT caught. A ConfigError here must stop the process; falling back to a
    # development default in production is exactly how this drifts back.
    config.assert_production_config()

    # 1. Initialize database connection pool + seed default user
    from .database import AsyncSessionLocal, engine
    logger.info("Initializing database connection...")
    try:
        async with engine.begin() as conn:
            from sqlalchemy import text
            await conn.execute(text("SELECT 1"))
        logger.info("Database connection OK")

        # Seed anonymous default user for chat history
        from .models.user import User
        from .services.chat_service import DEFAULT_USER_ID
        async with AsyncSessionLocal() as session:
            existing = await session.get(User, DEFAULT_USER_ID)
            if not existing:
                session.add(User(
                    id=DEFAULT_USER_ID,
                    email="anonymous@voidcode.local",
                    name="Anonymous Student",
                    role="student",
                ))
                await session.commit()
                logger.info("Seeded default anonymous user")

            # Seed the primary developer account — DEVELOPMENT ONLY.
            #
            # This ran unconditionally, so a production deployment would create a real personal
            # account on every boot, with no password and no way for anyone to have asked for it.
            # A convenience for local work is not a convenience on a public host.
            if not config.IS_PRODUCTION:
                from sqlalchemy import select as sa_select
                alwin_result = await session.execute(
                    sa_select(User).where(User.email == "alwintay.edu@gmail.com")
                )
                if not alwin_result.scalar_one_or_none():
                    session.add(User(
                        email="alwintay.edu@gmail.com",
                        name="Alwin Tay",
                        role="student",
                        is_active=True,
                    ))
                    await session.commit()
                    logger.info("Seeded Alwin Tay user (development only)")
    except Exception as e:
        logger.warning(f"Database not available: {e}")
        logger.warning("Continuing without database — some features will be limited")

    # 2. Initialize Redis
    from .redis_client import close_redis, init_redis
    logger.info("Initializing Redis connection...")
    try:
        await init_redis()
        logger.info("Redis connection OK")
    except Exception as e:
        logger.warning(f"Redis not available: {e}")
        logger.warning("Continuing without Redis — caching will be disabled")

    # 3. Load LLM model (HF path) OR initialise vLLM/SGLang engine
    if USE_SGLANG:
        # ── SGLang path: connect to sglang-server via OpenAI-compatible API ──
        # No model weights loaded here — all inference delegated over HTTP.
        # RadixAttention on sglang-server caches shared system prompt KV.
        import httpx as _httpx
        import openai as _openai
        global _sglang_client
        logger.info(f"USE_SGLANG=true — connecting to SGLang at {SGLANG_BASE_URL}")
        _sglang_client = _openai.AsyncOpenAI(
            base_url=SGLANG_BASE_URL,
            api_key="none",  # SGLang does not require authentication
            timeout=SGLANG_TIMEOUT_SECONDS,
        )
        # Wait for SGLang server to be ready (model load + CUDA kernel compile
        # takes ~60-120s on cold start — we poll every 10s for up to 5 minutes)
        # `/v1/models` is exposed by BOTH SGLang and Ollama's OpenAI-compatible endpoint, whereas
        # `/health` is SGLang-only (Ollama 404s it and this poll would burn its full 5-minute
        # budget every boot). Readiness = the OpenAI surface answers.
        health_url = SGLANG_BASE_URL.rstrip("/") + "/models"
        logger.info(f"Waiting for SGLang server at {health_url}...")
        for attempt in range(30):
            try:
                async with _httpx.AsyncClient() as hc:
                    r = await hc.get(health_url, timeout=5.0)
                    if r.status_code == 200:
                        logger.info("SGLang server is ready ✓")
                        break
            except Exception:
                pass
            if attempt < 29:
                logger.info(f"SGLang not ready yet ({attempt + 1}/30) — retrying in 10s...")
                await asyncio.sleep(10)
        else:
            logger.warning("SGLang health check timed out — proceeding anyway")

        # ── RadixAttention KV-cache warmup ──────────────────────────────────
        # Fire one minimal request per mode so SGLang pre-computes the KV for
        # each system-prompt prefix.  All real student requests that share the
        # same prefix then skip the expensive ~2800-token prefill entirely.
        # Without this, the first student in each mode pays the full prefill
        # cost; with it, every request after startup gets the 3-4x speedup.
        logger.info("Priming SGLang RadixAttention KV cache (6 modes)...")
        for _wm in ("teaching", "debug", "followup", "explain", "general", "empathy"):
            try:
                await _sglang_client.chat.completions.create(
                    model=SGLANG_MODEL_NAME,
                    messages=[
                        {"role": "system", "content": get_system_prompt(_wm, pe_mode=True)},
                        {"role": "user",   "content": "hi"},
                    ],
                    max_tokens=1,
                    temperature=0.0,
                    stream=False,
                    extra_body={
                        "chat_template_kwargs": {"enable_thinking": False},
                        "top_k": 1,
                        "min_p": 0.0,
                    },
                )
                logger.info(f"  KV cache primed ✓ {_wm}")
            except Exception as _wup_err:
                logger.warning(f"  KV cache warmup failed for {_wm}: {_wup_err}")
        logger.info("SGLang RadixAttention warmup complete — all mode prefixes cached")

    elif USE_VLLM:
        # P4: vLLM AsyncLLMEngine — PagedAttention + continuous batching
        # Requires AWQ-quantized model at llm/outputs/awq_model/
        # Must run in WSL2/Linux; set USE_VLLM=true in environment
        from .vllm_engine import init_engine as _init_vllm_engine
        logger.info("USE_VLLM=true — starting vLLM AsyncLLMEngine (HF path inactive)")
        await _init_vllm_engine()
        # Tokenizer still needed for prompt formatting (apply_chat_template).
        # Prefer loading from the AWQ model directory (which bundles tokenizer files)
        # to avoid a slow HuggingFace Hub network HEAD request inside Docker.
        from pathlib import Path as _Path

        from transformers import AutoTokenizer as _AutoTokenizer

        from .vllm_engine import AWQ_MODEL_PATH as _awq_model_path
        _tok_source = _awq_model_path if _Path(_awq_model_path).is_dir() else BASE_MODEL_ID
        logger.info(f"Loading tokenizer from: {_tok_source}")
        tokenizer = _AutoTokenizer.from_pretrained(_tok_source, trust_remote_code=True)
        logger.info("vLLM engine ready")
    else:
        adapter_path = getattr(app.state, 'adapter_path', ADAPTER_PATH)
        model, tokenizer = load_model(adapter_path)

    # ── P2 Warmup: trigger torch.compile JIT before first user request ────
    # torch.compile performs its actual Triton kernel compilation on the first
    # forward pass (JIT). Without this warmup, the very first user request
    # would incur a 30–60 s compile penalty. The warmup runs 5 tokens of
    # greedy decoding — fast enough to complete in ~2–3 s at server startup.
    if not USE_VLLM and not USE_SGLANG:
        logger.info("Running model warmup (torch.compile JIT trigger)...")
        try:
            _warmup_msgs = [
                {"role": "system", "content": "You are a tutor."},
                {"role": "user",   "content": "Hi"},
            ]
            _warmup_prompt = tokenizer.apply_chat_template(
                _warmup_msgs, tokenize=False, add_generation_prompt=True
            )
            _warmup_inputs = tokenizer(
                _warmup_prompt, return_tensors="pt"
            ).to(model.device)
            with torch.inference_mode():
                model.generate(
                    **_warmup_inputs,
                    max_new_tokens=5,
                    do_sample=False,
                    use_cache=True,
                )
            del _warmup_inputs
            torch.cuda.empty_cache()
            logger.info("Model warmup complete — first user request will not be penalised")
        except Exception as _warmup_err:
            logger.warning(f"Model warmup failed (non-fatal): {_warmup_err}")

    # V2: snapshot the knowledge corpus for grounded modes. Never fatal — a corpus that fails to
    # load costs citations, not availability, and `_ground()` degrades to the ungrounded
    # instruction. It logs a warning when it loads ZERO documents, because an empty corpus and a
    # broken one are indistinguishable at the answer and need different fixes.
    try:
        from .database import AsyncSessionLocal

        await knowledge_cache.load(AsyncSessionLocal)
    except Exception as _corpus_err:
        logger.warning(f"knowledge corpus load skipped (non-fatal): {_corpus_err}")

    # The recovery sweep, only when metering is on. It is the sole backstop for a hold whose
    # request died between releasing its permit and settling — which is what happens on every
    # deploy that lands mid-request — so the metering path is allowed to fail loudly because this
    # exists.
    _sweep_task = None
    if config.GPU_METERING_ENABLED:
        _sweep_task = asyncio.create_task(
            gpu_sweep_service.sweep_loop(
                interval_seconds=config.GPU_SWEEP_INTERVAL_SECONDS,
                max_age_seconds=config.GPU_SWEEP_MAX_AGE_SECONDS,
            )
        )
        logger.info("gpu reservation sweep started")

    yield

    # Shutdown
    logger.info("Shutting down...")

    # Settles first, then the sweep, then everything else. An in-flight settle finishing now is one
    # the sweep does not have to void later, and `terminationGracePeriodSeconds` is 60, so the
    # five-second wait is affordable.
    if config.GPU_METERING_ENABLED:
        try:
            await metering.drain(timeout=5.0)
        except Exception:
            logger.exception("gpu settle drain failed at shutdown; the sweep will recover")
    if _sweep_task is not None:
        _sweep_task.cancel()
        try:
            await _sweep_task
        except asyncio.CancelledError:
            pass

    executor.shutdown(wait=False)

    # Close Redis
    try:
        await close_redis()
    except Exception:
        pass

    # Close database engine
    try:
        await engine.dispose()
    except Exception:
        pass

    if _TORCH_AVAILABLE and torch.cuda.is_available():
        torch.cuda.empty_cache()


# --- FastAPI App ---
app = FastAPI(
    title="VoidCode AI API",
    description="Hybrid Architecture: Fine-tuning + Prompt Engineering (v5.2)",
    version="5.2",
    lifespan=lifespan,
)

# Read allowed origins from env, falling back to localhost defaults
# CORS comes from `config.cors_settings()`, which differs by APP_ENV.
#
# This used to be an inline block that hardcoded the tunnel regex with NO environment branch, so
# every deployment — including production — granted a credentialed cross-origin allowance to any
# `*.trycloudflare.com`, `*.ngrok*` or `*.loca.lt` host. Anyone can stand up a free cloudflared
# tunnel in thirty seconds. `config.py:110-114` had described that exact combination as dangerous
# and `cors_settings()` had been written to fix it; the function was simply never called, because
# nothing in the app imported `config` at all.
app.add_middleware(CORSMiddleware, **config.cors_settings())

# --- Routers ---
app.include_router(execution_router)
app.include_router(chat_router)
app.include_router(problems_router)
app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(notifications_router)
app.include_router(drafts_router)
app.include_router(dashboard_router)
app.include_router(interviews_router)
app.include_router(papers_router)
app.include_router(recommendations_router)


# --- Pydantic Models ---
class ChatMessage(BaseModel):
    role: str
    #: V3: `MessageContent`, not `str`. This annotation is what makes the vision guard in
    #: `create_chat_completion` reachable at all. While it was `str`, FastAPI rejected an image
    #: request with a 422 "Input should be a valid string" during body validation -- BEFORE
    #: `multimodal.assert_can_accept` ran -- so the 415 with its actionable message was dead code,
    #: and setting VISION_ENABLED=true on a multimodal deployment still could not pass an image.
    #: The unit tests did not catch it because they exercise `assert_can_accept` directly and
    #: `SaveMessageRequest` (the history schema, already widened); neither goes through this model.
    content: MessageContent


class ChatCompletionRequest(BaseModel):
    model: str | None = "voidcode-ai-v5.2"
    messages: list[ChatMessage]
    max_tokens: int | None = Field(default=4096, ge=1, le=8192)
    temperature: float | None = Field(default=None)  # Auto-detect based on mode
    top_p: float | None = Field(default=0.9, ge=0.0, le=1.0)
    stream: bool | None = False
    repetition_penalty: float | None = Field(default=1.05, ge=1.0, le=2.0)
    timeout: int | None = Field(default=180, ge=10, le=600)
    #: Emit the private stage A diagnosis as a `{"type": "diagnosis"}` SSE frame.
    #: OFF by default and never set by the web client, so a learner never receives it -- the whole
    #: value of stage A is that its output is not part of the conversation. The eval harness sets it
    #: because `bug_localisation` has to be scored on the diagnostic surface: stage B's hint
    #: deliberately contains no line numbers, so scoring localisation there measures the hint format
    #: rather than whether the tutor found the bug.
    include_diagnosis: bool | None = False
    #: Eval-harness only. Debug withholds its reasoning from learners; the harness still needs it in
    #: order to SCORE it, or suppressing the leak would silently retire the disclosure gate.
    include_reasoning: bool | None = False


class ThinkingMetadata(BaseModel):
    content: str | None = None
    token_count: int = 0
    budget_used: float = 0.0  # Percentage of budget used
    budget_total: int = 2000  # Maximum thinking token budget


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"
    thinking: ThinkingMetadata | None = None  # Hidden reasoning metadata


class StreamChoice(BaseModel):
    index: int = 0
    delta: dict[str, Any]
    finish_reason: str | None = None


class Usage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str = "voidcode-ai-v5.2"
    choices: list[ChatCompletionChoice]
    usage: Usage


class ChatCompletionStreamResponse(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    created: int
    model: str = "voidcode-ai-v5.2"
    choices: list[StreamChoice]


# --- Core Logic ---
THINKING_TOKEN_BUDGET = 2000       # HF path: manual thinking token cap
SGLANG_THINKING_BUDGET = 8192      # SGLang path: Qwen3.5-9B max thinking tokens


#: Markers that a message carried code, checked on the RAW message before `_extract_user_intent`
#: removes them. `[SOURCE CODE` and `[TEST CASE DETAILS` are what the frontend emits; a fence is
#: what a learner pasting into the chat box produces directly.
_CODE_CONTEXT_MARKERS = ("[source code", "[test case details", "```")


def _has_code_context(raw_message: str) -> bool:
    """Did this message arrive with code attached, whatever the student typed alongside it?

    One bit, deliberately. `_extract_user_intent` exists to stop the code's CONTENTS biasing mode
    detection, and that stays true — this reports only that a submission happened, which is a fact
    about the request rather than a keyword inside it.
    """
    lowered = (raw_message or "").lower()
    return any(marker in lowered for marker in _CODE_CONTEXT_MARKERS)


def decide_mode(latest_user_message: str, n_user_messages: int) -> tuple[str, str]:
    """The complete routing decision, as a pure function. Returns (mode, user_intent).

    WHY THIS IS A FUNCTION AND NOT SIX LINES IN THE HANDLER
    ----------------------------------------------------------
    It used to be six lines in the handler, and that is exactly why it had **zero tests** while
    every mode's PROMPT had a gold set. Routing is upstream of all of them: if this returns the
    wrong mode, the right prompt is never used and every per-mode number measures something the
    learner never received. A regression here is invisible to the entire eval suite.

    The behaviour is unchanged from the inline version, deliberately — this is an extraction, not a
    fix. `tests/test_routing.py` now measures it, and records three defects it found:

      * **`empathy` cannot fire on a first message.** The `n_user_messages > 1` gate means a learner
        whose opening line is "I give up, I'm terrible at this" is routed by keyword instead. That
        gate exists so the model has prior context to reference, which is a real reason; it is
        pinned here so the trade-off is a decision rather than a surprise.
      * **`detect_frustration` misses 6 of 9 plainly distressed phrasings** — "I feel so dumb",
        "should I just quit?", "I don't think I'm ever going to get this". Its list has "im dumb"
        and "i quit" but not these.
      * **the code-context signal is thrown away.** `_extract_user_intent` strips the
        `[SOURCE CODE]` block so its contents cannot bias keyword matching toward debug — a sound
        aim — but that also erases *the fact that code was attached at all*. Restoring only that
        bit moves debug routing from 12/51 to 20/51 on the gold labels.
    """
    user_intent = _extract_user_intent(latest_user_message)
    # Read the code-context flag from the ORIGINAL message, before extraction removed the block.
    # The contents still never reach detect_mode — only the one bit saying a submission happened.
    mode = detect_mode(user_intent, has_code_context=_has_code_context(latest_user_message))

    # DETERMINISTIC OVERRIDE: code attached AND a stated failure symptom is a debug submission,
    # whatever the keyword classifier concluded. It had 100% precision and 29/51 recall -- too
    # strict rather than confused -- and all 22 misroutes fell through to the sink, which returns
    # `explain` because attaching code makes `is_programming_related` true.
    #
    # Measured on the 75 gold scenarios: hybrid 70/75 against the classifier's 53/75, debug recall
    # 29/51 -> 46/51, with ZERO false positives, so the four modes already at 100% are unaffected.
    # A rule is preferred to a better prompt here because it cannot regress under a model change.
    #
    # Reads the RAW message: the code blocks are what carries the signal, and `_extract_user_intent`
    # has already removed them from `user_intent`.
    if looks_like_debug_submission(latest_user_message):
        mode = "debug"

    # detect_mode() has no access to history. A very short message that looks off-topic, several
    # turns into a session, is a continuation rather than a new question.
    if mode == "general" and n_user_messages > 2 and len(user_intent.strip()) < 30:
        mode = "followup"

    # Empathy overrides every other mode: even if a code block made detect_mode say 'debug', a
    # message that is a cry for help is not a code submission. Checked against the raw intent, not
    # the enriched block, which would hide the signal behind its code and "error" keywords.
    #
    # THE `n_user_messages > 1` GATE IS GONE. It existed because EMPATHY_SYSTEM_PROMPT Step 3 tells
    # the model to look back at the previous assistant message, which does not exist on turn one —
    # a real constraint, not an arbitrary one. The consequence was that a learner whose OPENING
    # line was "I give up, I'm terrible at this" got a keyword-routed reply at the worst possible
    # moment. `EMPATHY_FIRST_TURN_PROMPT` removes the dependency, so the gate is no longer paying
    # for anything; the caller passes `first_turn` to `get_system_prompt` instead.
    if detect_frustration(user_intent):
        mode = "empathy"

    return mode, user_intent


def _extract_user_intent(enriched_message: str) -> str:
    """
    Extract just the student's raw words from a frontend-enriched message.

    The frontend (VoidCodeAIPanel.tsx) builds a rich context block before calling
    the LLM, wrapping the student's actual words inside a [USER REQUEST] header:

        [USER REQUEST]
        idk okay, im dumb

        [PROBLEM DESCRIPTION]
        ...

        [SOURCE CODE (python) — 15 lines total]
        ```python
        ...

    When detect_mode() or detect_frustration() are called on the FULL enriched
    message, the code block and "error" keywords in the context sections bias
    mode detection toward 'debug' regardless of what the student actually said.

    This function strips everything after the first section-header boundary,
    returning only the text under [USER REQUEST] (or the full message if the
    header is absent — e.g., messages sent by the plain /v1/chat/completions
    client without the frontend enrichment).
    """
    if "[USER REQUEST]" not in enriched_message:
        return enriched_message  # plain message — no enrichment

    lines = enriched_message.split("\n")
    user_lines: list[str] = []
    in_user_section = False

    for line in lines:
        stripped = line.strip()
        if stripped == "[USER REQUEST]":
            in_user_section = True
            continue
        if in_user_section:
            # Any subsequent [SECTION HEADER] ends the user block
            if stripped.startswith("[") and stripped.endswith("]") and len(stripped) > 2:
                break
            user_lines.append(line)

    extracted = "\n".join(user_lines).strip()
    return extracted if extracted else enriched_message


# ── V2 retrieval grounding ──────────────────────────────────────────────────
#
# Modes that make factual claims about things which change. `debug` and `followup` reason about
# the learner's own code; `general` and `empathy` are not factual. Grounding those would spend
# context and invite irrelevant citations without reducing any risk.
GROUNDED_MODES = ("explain", "teaching")

#: Modes where grounding is actively unwanted rather than merely unhelpful.
#:
#: DECOUPLED FROM ROUTING. Grounding used to be gated on the ROUTED mode, so a misroute silently
#: cost retrieval as well as the prompt — an `explain` question landing in `debug` lost its sources
#: with nothing in the output to say so. Grounding is the only intervention replicated as a win
#: across independent runs, so losing it to a routing accident is the most expensive part of a
#: misroute.
#:
#: Now the question is asked the other way round: ground everything EXCEPT where it would hurt.
#: `empathy` is the one clear exclusion — a learner saying "I give up, I'm terrible at this" must
#: not receive citations, and its 512-token budget has no room for retrieved context anyway.
#: `general` is excluded for the same budget reason at 300 thinking tokens.
#:
#: Everything else — including `debug` and `followup`, which were previously excluded — now grounds.
#: Whether that HELPS those modes is a separate question and is measured per mode; a null result
#: there is a result, and the point of this change is that a misroute can no longer remove
#: retrieval by accident.
UNGROUNDED_MODES = ("empathy", "general")


def _should_ground(mode: str) -> bool:
    """Grounding is decided by whether it would harm this mode, not by whether routing succeeded."""
    return mode not in UNGROUNDED_MODES


#: A code submission needs room to be answered properly no matter which mode it lands in.
#: `followup` allows 1024 and `empathy` 512, so a debug submission misrouted to either was TRUNCATED
#: — a second penalty on top of getting the wrong prompt. Sized to `debug`'s own 4096 because that
#: is the budget a code submission was always going to need.
_SUBMISSION_TOKEN_FLOOR = 4096


def token_budget(mode: str, raw_message: str, requested: int | None) -> int:
    """Tokens for this reply, floored by the REQUEST SHAPE rather than decided by the route.

    DECOUPLED FROM ROUTING, for the same reason grounding was. A misroute used to cost three things
    at once: the prompt, retrieval, and the token budget. It now costs only the prompt.

    The floor applies when the learner actually submitted code — a fact about the request, checked on
    the raw message before `_extract_user_intent` strips the blocks. It can only ever RAISE a budget
    toward what a submission needs; a short conversational turn keeps its small allowance, so this
    does not hand every request 4096 tokens.

    The mode's own configured budget still wins when it is larger, which is what keeps `teaching`
    at 8192.
    """
    configured = int(get_generation_config(mode).get("max_new_tokens", 4096))
    if _has_code_context(raw_message):
        configured = max(configured, _SUBMISSION_TOKEN_FLOOR)
    return min(requested, configured) if requested else configured


def _ground(system_prompt: str, query: str) -> str:
    """Append retrieved material, or the no-source instruction, to the system prompt.

    Fails OPEN, deliberately. If the corpus is unreachable or no embedder is configured, the tutor
    answers ungrounded rather than erroring — a degraded answer beats a 500, and the ungrounded
    instruction still tells the model to flag time-sensitive claims. The failure is logged because
    silently serving ungrounded answers from a broken corpus is exactly how V2 stops working
    without anyone noticing.
    """
    try:
        from features.retrieval import ground_prompt, retrieve

        embedder = _get_embedder()
        if embedder is None:
            # No embedder configured yet — the model choice is still open. Ungrounded, but the
            # instruction still makes the tutor hedge on anything time-sensitive.
            return ground_prompt(system_prompt, [])

        hits = retrieve(embedder(query), _iter_knowledge_documents())
        return ground_prompt(system_prompt, hits)
    except Exception as exc:  # grounding must never break a conversation
        logger.warning("retrieval grounding unavailable, answering ungrounded: %s", exc)
        try:
            from features.retrieval import ground_prompt

            return ground_prompt(system_prompt, [])
        except Exception:
            return system_prompt


def _get_embedder():
    """Ollama's nomic-embed-text: 768 dimensions, local, no API key, already installed.

    Chosen over a hosted embedder for one reason that matters more than quality here — the corpus
    is small and the tutor is latency-sensitive, and a network round trip per query buys nothing
    when the whole corpus fits comfortably in memory. Verified against the running model rather
    than assumed: 768 dims, matching DEFAULT_EMBEDDING_DIM.

    Returns None when Ollama is unreachable, which makes the caller fall through to the ungrounded
    path rather than failing the conversation. Swapping models later means re-embedding the corpus
    and nothing else; embedding_dim is stored per row so a half-migrated corpus is detected rather
    than silently returning meaningless neighbours.
    """
    import httpx

    base = os.getenv("EMBEDDING_BASE_URL", "http://127.0.0.1:11434")
    model = os.getenv("EMBEDDING_MODEL", "nomic-embed-text")

    def embed(text: str) -> list[float]:
        response = httpx.post(
            f"{base}/api/embeddings",
            json={"model": model, "prompt": text},
            # Short, deliberately. This sits in the request path of a chat turn: an embedder that
            # hangs must degrade to an ungrounded answer, not stall the conversation behind it.
            timeout=10.0,
        )
        response.raise_for_status()
        return response.json()["embedding"]

    try:
        # One probe at startup of the call rather than trusting configuration. An unreachable
        # embedder that is only discovered mid-query turns into a failed turn; discovered here it
        # is a logged fallback.
        embed("probe")
    except Exception as exc:
        logger.warning("embedder unavailable at %s (%s); answering ungrounded", base, exc)
        return None
    return embed


def _iter_knowledge_documents():
    """Documents to rank, from the startup snapshot in `knowledge_cache`.

    This returned a hardcoded `[]` until V2. Everything around it — ranking, prompt composition,
    mode gating, fail-open — was written and tested; this one line was what kept the corpus
    unreachable, so expanding it would have changed nothing.

    Synchronous by necessity: `_ground()` is sync and the database is `AsyncSession`. The corpus is
    snapshotted at startup instead, which also removes a database round trip from the hot path of
    the most latency-sensitive endpoint. See `knowledge_cache` for the staleness trade.
    """
    return knowledge_cache.documents()


def prepare_messages_hybrid(messages: list[ChatMessage]) -> tuple[list[dict], str]:
    """
    Prepare messages with the appropriate system prompt based on detected mode.

    v5.2 Hybrid Architecture:
    - Detect mode from user query
    - Use EXPLAIN_SYSTEM_PROMPT for explain mode (programming concepts)
    - Use FINETUNED_SYSTEM_PROMPT for teaching/debug/followup modes
    - Use NON_PROGRAMMING_SYSTEM_PROMPT for general questions
    """
    # Get the latest user message for mode detection.
    # text_of() because content may be a multimodal PARTS LIST, not a string (V3). Everything below
    # this line — _extract_user_intent, detect_mode, detect_frustration, the retrieval query — is
    # string-only. Handing them a list raises, or stringifies a Pydantic object into the embedding
    # query. The parts survive separately, in messages_dict via to_wire().
    user_messages = [msg for msg in messages if msg.role == "user"]
    latest_user_message = multimodal.text_of(user_messages[-1].content) if user_messages else ""

    # ── Extract raw user intent from frontend-enriched messages ─────────────
    # The frontend wraps the student's words in a [USER REQUEST] header and
    # appends [SOURCE CODE], [TEST CASE DETAILS], etc.  Calling detect_mode()
    # on the full enriched string always returns 'debug' (code block + "error"
    # keywords from test output) regardless of what the student actually typed.
    # _extract_user_intent() returns only the student's actual words so mode
    # detection and frustration detection work correctly.
    # One pure function, so the routing decision can be tested without a server. It had zero
    # tests while every mode's prompt had a gold set -- and routing is upstream of all of them.
    mode, user_intent = decide_mode(latest_user_message, len(user_messages))
    logger.info(f"[route] mode={mode} intent={user_intent[:60]!r} "
                f"turns={len(user_messages)}")

    # Select appropriate system prompt using centralized function.
    # pe_mode=True when SGLang is active → use dedicated PE prompts per mode
    # pe_mode=False for HF / vLLM → use legacy combined FINETUNED_SYSTEM_PROMPT
    # first_turn matters only for empathy, whose normal Step 3 references the previous assistant
    # message. This is what replaced the turn gate in decide_mode.
    system_prompt = get_system_prompt(mode, pe_mode=USE_SGLANG,
                                      first_turn=len(user_messages) <= 1)

    # ── V2: ground the prompt in retrieved reference material ───────────────
    #
    # Only for modes that make factual claims. `explain` and `teaching` state how attention
    # variants, quantization schemes and kernel guidance work — all of which change, and all of
    # which a learner preparing for an interview cannot check. `debug` and `followup` reason about
    # the learner's own code, and `general`/`empathy` are not factual at all; grounding them would
    # spend context and invite irrelevant citations without reducing any risk.
    #
    # `ground_prompt` handles the empty case deliberately: when nothing is retrieved it instructs
    # the model to answer but flag time-sensitive claims, rather than leaving it silently
    # answering from weights. That is why this is not wrapped in `if hits`.
    if _should_ground(mode):
        system_prompt = _ground(system_prompt, user_intent)

    # Build message list. to_wire() serialises multimodal parts to plain dicts (V3) — a Pydantic
    # ImagePart reaching the serving client would be coerced by str() into literal prompt text like
    # "ImagePart(type='image_url'...)", which looks like a working request and sends garbage.
    messages_dict = [{"role": msg.role, "content": multimodal.to_wire(msg.content)}
                     for msg in messages]

    # Handle system message
    has_system = any(msg["role"] == "system" for msg in messages_dict)
    if has_system:
        for msg in messages_dict:
            if msg["role"] == "system":
                msg["content"] = system_prompt
                break
    else:
        messages_dict.insert(0, {"role": "system", "content": system_prompt})

    return messages_dict, mode


def generate_response(
    messages: list[dict],
    mode: str,
    max_tokens: int,
    temperature: float | None,
    top_p: float,
    repetition_penalty: float,
) -> tuple[str, int, int, dict | None]:
    """Generate response with mode-specific parameters.

    Returns:
        tuple: (cleaned_response, prompt_tokens, completion_tokens, thinking_metadata)
    """

    # Get mode-specific config
    gen_config = get_generation_config(mode)

    # Use provided temperature or mode default
    actual_temp = temperature if temperature is not None else gen_config['temperature']
    actual_max_tokens = min(max_tokens, gen_config['max_new_tokens'])

    # Apply chat template
    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    # Tokenize
    inputs = tokenizer(
        prompt,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=8192,
        return_attention_mask=True,
    ).to(model.device)

    prompt_length = inputs["input_ids"].shape[1]

    # Build EOS token list
    eos_token_ids = [tokenizer.eos_token_id]
    if hasattr(tokenizer, 'additional_special_tokens_ids'):
        eos_token_ids.extend(tokenizer.additional_special_tokens_ids)
    eos_token_ids = [t for t in eos_token_ids if t is not None]

    # Generate
    gen_kwargs = {
        "input_ids": inputs["input_ids"],
        "attention_mask": inputs["attention_mask"],
        "max_new_tokens": actual_max_tokens,
        "temperature": actual_temp if actual_temp > 0 else 1.0,
        "top_p": top_p,
        "repetition_penalty": repetition_penalty,
        "do_sample": actual_temp > 0,
        "pad_token_id": tokenizer.pad_token_id,
        "eos_token_id": eos_token_ids,
        "use_cache": True,
    }

    # Define whether to disable adapter based on mode.
    # EXPLAIN, GENERAL, and EMPATHY modes use the Base Model (no LoRA).
    # The LoRA was trained on structured teaching/debug/followup formats; the
    # base Qwen 2.5 7B Instruct model handles empathetic conversation better
    # without the LoRA overlay which would push it toward 🔴/🟢 format output.
    should_disable_adapter = mode in ['explain', 'general', 'empathy']

    # Use nullcontext if we maintain the adapter, otherwise use disable_adapter()
    adapter_context = model.disable_adapter() if should_disable_adapter else nullcontext()

    with adapter_context:
        with torch.inference_mode():
            outputs = model.generate(**gen_kwargs)

    # Extract generated tokens
    new_tokens = outputs[0][prompt_length:]
    response_text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    completion_length = len(new_tokens)

    # Strip <think> tags (Chain-of-Thought reasoning)
    cleaned_response, thinking_content = strip_thinking_tags(response_text)

    # Calculate thinking token usage
    thinking_metadata = None
    if thinking_content:
        thinking_tokens = len(tokenizer.encode(thinking_content))
        thinking_metadata = {
            "content": thinking_content,
            "token_count": thinking_tokens,
            "budget_used": round(100 * thinking_tokens / THINKING_TOKEN_BUDGET, 1),
            "budget_total": THINKING_TOKEN_BUDGET,
        }
        logger.info(f"Thinking: {thinking_tokens} tokens ({thinking_metadata['budget_used']}% of budget)")

    if _TORCH_AVAILABLE and torch.cuda.is_available():
        torch.cuda.empty_cache()

    return cleaned_response.strip(), prompt_length, completion_length, thinking_metadata


async def generate_stream(
    messages: list[dict],
    mode: str,
    max_tokens: int,
    temperature: float | None,
    top_p: float,
    repetition_penalty: float,
    request_id: str,
) -> AsyncGenerator[str, None]:
    """Generate streaming response."""

    gen_config = get_generation_config(mode)
    actual_temp = temperature if temperature is not None else gen_config['temperature']
    actual_max_tokens = min(max_tokens, gen_config['max_new_tokens'])

    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    inputs = tokenizer(
        prompt,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=8192,
        return_attention_mask=True,
    ).to(model.device)

    # Track prompt tokens for usage reporting
    prompt_tokens = inputs["input_ids"].shape[1]

    streamer = TextIteratorStreamer(
        tokenizer,
        skip_prompt=True,
        skip_special_tokens=True,
        timeout=60.0,
    )

    eos_token_ids = [tokenizer.eos_token_id]
    if hasattr(tokenizer, 'additional_special_tokens_ids'):
        eos_token_ids.extend(tokenizer.additional_special_tokens_ids)
    eos_token_ids = [t for t in eos_token_ids if t is not None]

    gen_kwargs = {
        "input_ids": inputs["input_ids"],
        "attention_mask": inputs["attention_mask"],
        "max_new_tokens": actual_max_tokens,
        "temperature": actual_temp if actual_temp > 0 else 1.0,
        "top_p": top_p,
        "repetition_penalty": repetition_penalty,
        "do_sample": actual_temp > 0,
        "pad_token_id": tokenizer.pad_token_id,
        "eos_token_id": eos_token_ids,
        "streamer": streamer,
        "use_cache": True,
    }

    # Define whether to disable adapter.
    # EXPLAIN, GENERAL, and EMPATHY modes use the Base Model (no LoRA).
    should_disable_adapter = mode in ['explain', 'general', 'empathy']
    adapter_context = model.disable_adapter() if should_disable_adapter else nullcontext()

    def generate_in_thread():
        with adapter_context:
            with torch.inference_mode():
                model.generate(**gen_kwargs)

    thread = Thread(target=generate_in_thread)
    thread.start()

    created = int(time.time())

    try:
        buffer = ""
        thinking_buffer = ""
        inside_think = False
        think_complete = False
        thinking_sent = False
        all_generated_content = []  # Track all content for token counting

        for text in streamer:
            if text:
                buffer += text
                all_generated_content.append(text)  # Track for token counting

                # Handle <think> tag stripping for streaming
                if not think_complete:
                    # Check if we're entering a think block
                    if '<think>' in buffer and not inside_think:
                        inside_think = True
                        # Send any content before <think>
                        before_think = buffer.split('<think>')[0]
                        if before_think.strip():
                            chunk = ChatCompletionStreamResponse(
                                id=request_id,
                                created=created,
                                choices=[StreamChoice(delta={"content": before_think}, finish_reason=None)]
                            )
                            yield f"data: {chunk.model_dump_json()}\n\n"
                            await asyncio.sleep(0)
                        buffer = '<think>' + buffer.split('<think>', 1)[1]

                    # Collect thinking content
                    if inside_think:
                        thinking_buffer = buffer

                    # Check if think block is complete
                    if inside_think and '</think>' in buffer:
                        inside_think = False
                        think_complete = True

                        # Extract thinking content (without tags)
                        think_match = buffer.split('<think>')[1].split('</think>')[0]
                        thinking_buffer = think_match.strip()

                        # Calculate thinking tokens and send metadata event
                        if thinking_buffer and not thinking_sent:
                            thinking_tokens = len(tokenizer.encode(thinking_buffer))
                            budget_used = round(100 * thinking_tokens / THINKING_TOKEN_BUDGET, 1)

                            # Send thinking metadata as special event
                            thinking_event = {
                                "type": "thinking",
                                "content": thinking_buffer,
                                "token_count": thinking_tokens,
                                "budget_used": budget_used,
                                "budget_total": THINKING_TOKEN_BUDGET,
                            }
                            yield f"data: {json.dumps(thinking_event)}\n\n"
                            await asyncio.sleep(0)
                            thinking_sent = True

                        # Extract content after </think>
                        after_think = buffer.split('</think>', 1)[1]
                        buffer = after_think

                    # If still inside think, don't send main content
                    if inside_think:
                        continue

                # Send buffered content
                if buffer and think_complete:
                    chunk = ChatCompletionStreamResponse(
                        id=request_id,
                        created=created,
                        choices=[StreamChoice(delta={"content": buffer}, finish_reason=None)]
                    )
                    yield f"data: {chunk.model_dump_json()}\n\n"
                    await asyncio.sleep(0)
                    buffer = ""
                elif not inside_think and buffer and '<think>' not in buffer:
                    # No think tags at all, stream normally
                    chunk = ChatCompletionStreamResponse(
                        id=request_id,
                        created=created,
                        choices=[StreamChoice(delta={"content": buffer}, finish_reason=None)]
                    )
                    yield f"data: {chunk.model_dump_json()}\n\n"
                    await asyncio.sleep(0)
                    buffer = ""

        # Send any remaining buffer
        if buffer and not inside_think:
            chunk = ChatCompletionStreamResponse(
                id=request_id,
                created=created,
                choices=[StreamChoice(delta={"content": buffer}, finish_reason=None)]
            )
            yield f"data: {chunk.model_dump_json()}\n\n"
            await asyncio.sleep(0)

        # Calculate and send token usage
        full_response = "".join(all_generated_content)
        completion_tokens = len(tokenizer.encode(full_response, add_special_tokens=False))
        usage_event = {
            "type": "usage",
            "usage": {
                "prompt_tokens": int(prompt_tokens),
                "completion_tokens": int(completion_tokens),
                "total_tokens": int(prompt_tokens + completion_tokens),
            }
        }
        logger.info(f"Usage: {usage_event['usage']}")
        yield f"data: {json.dumps(usage_event)}\n\n"
        await asyncio.sleep(0)

        final_chunk = ChatCompletionStreamResponse(
            id=request_id,
            created=created,
            choices=[StreamChoice(delta={}, finish_reason="stop")]
        )
        yield f"data: {final_chunk.model_dump_json()}\n\n"
        yield "data: [DONE]\n\n"

    except Exception as e:
        logger.error(f"Streaming error: {e}")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"

    finally:
        thread.join(timeout=5.0)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


# --- SGLang Streaming ---

#: Two-stage debug: localise privately (stage A), then hint from the location alone (stage B).
#: Off by default so it can be A/B'd against the single-stage path on one server.
USE_TWO_STAGE_DEBUG = os.getenv("USE_TWO_STAGE_DEBUG", "false").lower() == "true"


async def _localise_bugs(user_message: str, request_id: str = "-") -> list[dict] | None:
    """STAGE A. Find the bugs. Never shown to the learner.

    Exists because a prompt cannot stop a model reasoning its way to the fix. Rewriting
    `PE_DEBUG_PROMPT` moved the visible opening from level 2 to level 1 (0.204 -> 0.750 outside the
    noise floor) and left the reasoning untouched at level 4 in ~76% of responses, with the prompt
    explicitly forbidding it. Finding a bug and working out its fix are the same act, so the only
    way stage B's reasoning cannot contain the remedy is for the remedy never to reach stage B.

    Structure is enforced with `response_format: json_schema` rather than requested in prose: a
    malformed stage A degrades the whole path to "a hint with no location", which is worse than not
    splitting at all. Thinking is disabled here -- this stage's reasoning is discarded either way,
    and it is pure latency on a path that now costs two calls.

    Returns None on any failure, and the caller falls back to single-stage. Availability beats
    architecture: a learner waiting on a 500 is worse than a learner getting a level-2 opener.
    """
    if _sglang_client is None:
        return None
    try:
        completion = await _sglang_client.chat.completions.create(
            model=SGLANG_MODEL_NAME,
            messages=[{"role": "system", "content": PE_DEBUG_LOCALISE_PROMPT},
                      {"role": "user", "content": user_message}],
            max_tokens=512,
            temperature=0.0,
            response_format={"type": "json_schema",
                             "json_schema": {"name": "debug_issues",
                                             "schema": DEBUG_LOCALISE_SCHEMA}},
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        issues = json.loads(completion.choices[0].message.content or "{}").get("issues") or []
        logger.info(f"[{request_id}] stage A located {len(issues)} issue(s)")
        return issues
    except Exception as exc:
        logger.warning(f"[{request_id}] stage A failed, falling back to single-stage: {exc}")
        return None


def _hint_system_prompt(issues: list[dict]) -> str:
    """STAGE B's system prompt: the hint rules plus location and symptom, and NOTHING ELSE.

    What is deliberately absent is the fix. Stage B is never told the remedy, so it has nothing to
    leak -- which is the whole mechanism. It IS told the line number, because it must describe the
    right region; its rules forbid repeating that number to the student.
    """
    lines = [PE_DEBUG_HINT_PROMPT, "", "## Located issues (private -- never repeat the line numbers)"]
    for i, issue in enumerate(issues, 1):
        lines.append(f"{i}. line {issue.get('line')}: {issue.get('symptom', '')}")
    return "\n".join(lines)


#: Modes whose reasoning is NOT sent to the client.
#:
#: In `debug`, 69% of responses have the complete corrected solution in the reasoning, and the
#: ThinkingBlock publishes it one click away behind a panel labelled "Thinking Process". That
#: defeats the product's premise: a learner who finds it will use it every time, and VoidCode
#: becomes a slower route to an answer than any general chatbot.
#:
#: Suppressed SERVER-SIDE rather than hidden in the UI, deliberately. Hiding the panel leaves the
#: text in the payload, reachable by copy, export or devtools; not emitting it means the browser
#: never receives it at all.
#:
#: `teaching` and `explain` keep their reasoning: modelling expert thinking is the point there, and
#: no withholding promise applies to them.
#:
#: THIS IS AN INTERIM. It stops the leak reaching the learner; it does not stop the model producing
#: a solution in its scratchpad. The disclosure gate stays RED until the two-stage split lands, and
#: the eval scores the PAYLOAD rather than the render precisely so this change cannot flatter it.
THINKING_WITHHELD_MODES = ("debug",)


#: Set per-request by the eval harness only. Withholding reasoning from the learner must not also
#: blind the measurement: if the harness cannot see the reasoning it cannot score it, the disclosure
#: gate quietly stops being evaluated, and the number improves because the evidence disappeared.
#: That is the "score the payload, not the render" rule applied to the payload itself.
#: Never set by the web client, so a learner is unaffected.
_reasoning_visible_to_caller: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "reasoning_visible_to_caller", default=False)


def _thinking_frame(mode: str, content: str, token_count: int) -> str | None:
    """The SSE thinking frame for this mode, or None when the mode withholds its reasoning."""
    if mode in THINKING_WITHHELD_MODES and not _reasoning_visible_to_caller.get():
        return None
    budget_pct = round(100 * token_count / SGLANG_THINKING_BUDGET, 1)
    return "data: " + json.dumps({
        "type": "thinking", "content": content, "token_count": token_count,
        "budget_used": budget_pct, "budget_total": SGLANG_THINKING_BUDGET,
    }) + "\n\n"


def _sglang_extra_body(*, top_k: int, min_p: float, enable_thinking: bool,
                       thinking_budget_tokens: int) -> dict:
    """The `extra_body` both SGLang paths must send. One function because they diverged.

    The streaming path built this correctly and the non-streaming path hardcoded
    `{"enable_thinking": True}` with no budget at all. So every per-mode thinking control was
    streaming-only: `empathy` and `followup` set `enable_thinking: False` precisely because,
    unbounded, the model spends 2000+ tokens on reasoning before `</think>` -- against ceilings of
    512 and 1024 tokens. Non-streaming re-enabled it for them, uncapped.

    Two copies of a payload that must agree is how that happened; there is now one.
    """
    think: dict = {"enable_thinking": enable_thinking}
    if enable_thinking and thinking_budget_tokens > 0:
        think["thinking_budget_tokens"] = thinking_budget_tokens
    return {"chat_template_kwargs": think, "top_k": top_k, "min_p": min_p}


async def generate_stream_sglang(
    messages: list,
    mode: str,
    max_new_tokens: int,
    temperature: float,
    top_p: float,
    request_id: str,
    top_k: int = 20,
    min_p: float = 0.0,
    presence_penalty: float = 0.0,
    thinking_budget_tokens: int = 512,
    enable_thinking: bool = True,
) -> AsyncGenerator[str, None]:
    """Stream tokens from the SGLang server via OpenAI-compatible API.

    SGLang's RadixAttention caches the shared system-prompt KV across all
    concurrent requests — the expensive prefill is computed once and reused,
    reducing per-request latency by ~3-4x after warmup.

    Qwen3.5-9B thinking mode (enable_thinking=True):
    - Model generates <think>…</think> chain-of-thought before the answer.
    - SGLang exposes thinking via delta.reasoning_content (Path A, preferred)
      or as inline <think>…</think> tokens inside delta.content (Path B fallback).
    - Either way we buffer ALL thinking server-side and emit it as a single
        {"type": "thinking", "content": "...", "token_count": N, ...}
      event BEFORE the first content token.  The frontend ThinkingBlock
      component consumes this event; regular delta chunks follow normally.
    - Warmup requests keep enable_thinking=False (1-token warmup would trigger
      thousands of thinking tokens and stall startup).
    """
    created = int(time.time())
    full_response = ""

    # Thinking state
    thinking_buffer: str = ""   # accumulates thinking content
    # When enable_thinking=False, mark as already emitted to skip Path A/B entirely
    thinking_emitted: bool = not enable_thinking
    path_a_used: bool = False   # True if SGLang sent reasoning_content (Path A)

    extra_body: dict = _sglang_extra_body(
        top_k=top_k, min_p=min_p,
        enable_thinking=enable_thinking, thinking_budget_tokens=thinking_budget_tokens,
    )

    try:
        response = await _sglang_client.chat.completions.create(
            model=SGLANG_MODEL_NAME,
            messages=messages,
            max_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            presence_penalty=presence_penalty,
            stream=True,
            stream_options={"include_usage": True},
            extra_body=extra_body,
        )

        prompt_tokens = 0
        completion_tokens = 0

        async for chunk in response:
            # Token usage arrives in the final chunk
            if hasattr(chunk, "usage") and chunk.usage:
                prompt_tokens = chunk.usage.prompt_tokens or 0
                completion_tokens = chunk.usage.completion_tokens or completion_tokens

            if not chunk.choices:
                continue

            delta = chunk.choices[0].delta
            if not delta:
                continue

            # ── Path A: SGLang exposes thinking via reasoning_content ────────
            # Newer SGLang versions separate thinking from content in the delta.
            # `reasoning` (no _content) is the same field under Ollama's OpenAI-compatible
            # endpoint, which qwen3 uses for its <think> phase — accepted here so the demo/dev
            # path can stream a visible thinking block without a code fork.
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if reasoning:
                thinking_buffer += reasoning
                path_a_used = True
                continue  # don't emit yet — flush once we get real content

            token: str = delta.content or ""
            if not token:
                continue

            # ── Flush pending Path-A thinking buffer before first content ────
            # Only fires if Path A actually produced reasoning_content tokens.
            # Path B (Qwen3.5-9B plain-text thinking) uses a separate code path
            # below and must NOT trigger this flush.
            if path_a_used and thinking_buffer and not thinking_emitted:
                clean = thinking_buffer.strip()
                # Character-based token estimation (~4 chars/token for English).
                # More accurate than word count; avoids importing a tokenizer in
                # the CPU-only FastAPI container.
                thinking_token_count = max(1, len(clean) // 4)
                _frame = _thinking_frame(mode, clean, thinking_token_count)
                if _frame:
                    yield _frame
                thinking_emitted = True
                thinking_buffer = ""

            # ── Path B: Qwen3.5-9B outputs thinking as plain text ending with </think> ──
            # The model does NOT use an opening <think> tag. Instead every response
            # starts immediately with thinking content (e.g. "Thinking Process:\n\n...")
            # and uses a bare </think> closing tag as the separator before the answer.
            # Format:  "Thinking Process:\n\n...\n</think>\n\nActual answer here."
            if not thinking_emitted:
                thinking_buffer += token
                if "</think>" in thinking_buffer:
                    # Split: everything before </think> is thinking, rest is response
                    think_part, after = thinking_buffer.split("</think>", 1)
                    clean = re.sub(r"</?think>", "", think_part).strip()
                    thinking_token_count = max(1, len(clean) // 4)
                    _frame = _thinking_frame(mode, clean, thinking_token_count)
                    if _frame:
                        yield _frame
                    thinking_emitted = True
                    thinking_buffer = ""
                    # Emit any real content that arrived in the same chunk as </think>
                    if after.strip():
                        full_response += after
                        completion_tokens += 1
                        stream_chunk = {
                            "id": request_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "choices": [{"delta": {"content": after}, "index": 0, "finish_reason": None}],
                        }
                        yield f"data: {json.dumps(stream_chunk)}\n\n"
                continue  # buffer all tokens until </think> found

            # ── Regular content token ────────────────────────────────────────
            full_response += token
            completion_tokens += 1
            stream_chunk = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "choices": [{"delta": {"content": token}, "index": 0, "finish_reason": None}],
            }
            yield f"data: {json.dumps(stream_chunk)}\n\n"

        # Edge case: stream ended with content still in thinking_buffer (no </think> found)
        if thinking_buffer and not thinking_emitted:
            clean = re.sub(r"</?think>", "", thinking_buffer).strip()
            if path_a_used:
                # Path A: genuine reasoning_content that never got flushed — emit as thinking
                thinking_token_count = max(1, len(clean) // 4)
                _frame = _thinking_frame(mode, clean, thinking_token_count)
                if _frame:
                    yield _frame
            else:
                # Path B: model hit max_tokens without outputting </think> — the buffer IS
                # the actual response (model skipped its thinking format).  Emit as content.
                if clean:
                    full_response += clean
                    completion_tokens += len(clean.split())
                    stream_chunk = {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "choices": [{"delta": {"content": clean}, "index": 0, "finish_reason": None}],
                    }
                    yield f"data: {json.dumps(stream_chunk)}\n\n"

        # Send usage event (matches HF/vLLM path format)
        usage_event = {
            "type": "usage",
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "mode": mode,
        }
        yield f"data: {json.dumps(usage_event)}\n\n"
        yield "data: [DONE]\n\n"

        logger.info(
            f"[{request_id}] SGLang {mode.upper()} | "
            f"{prompt_tokens}+{completion_tokens} tokens | "
            f"thinking={'yes' if thinking_emitted else 'no'}"
        )

    except Exception as e:
        logger.error(f"[{request_id}] SGLang streaming error: {e}")
        error_event = {"error": {"message": str(e), "type": "sglang_error"}}
        yield f"data: {json.dumps(error_event)}\n\n"
        yield "data: [DONE]\n\n"


# --- Helpers ---

def _is_model_ready() -> bool:
    """Return True if the LLM inference backend is initialised and ready."""
    if USE_SGLANG:
        return _sglang_client is not None
    if USE_VLLM:
        try:
            from .vllm_engine import get_engine
            get_engine()
            return True
        except Exception:
            return False
    return model is not None


async def _semaphore_wrapped(
    gen: AsyncGenerator[str, None],
    meter: "metering.Meter | None" = None,
) -> AsyncGenerator[str, None]:
    """Hold the inference semaphore for the full lifetime of an SSE stream.

    The semaphore must already be acquired before calling this function; it is
    released in the finally block once the generator is exhausted or the client
    disconnects.  This ensures the concurrency limit is enforced end-to-end, not
    just at request intake.

    `meter` extends that lifetime to credit: the billable interval and the permit-held interval are
    deliberately the same interval, so this `finally` is both the release and the settle. The
    argument is added HERE rather than by wrapping this generator in another one -- see the comment
    on the stage-A header below for the API that died silently after 20-60 requests when a discarded
    wrapper's `finally` never ran. One layer, one `finally`, one invariant.

    `finish()` schedules and returns; it never awaits. During a client disconnect this `finally`
    runs while the task is being cancelled, and awaiting database I/O there risks swallowing the
    `CancelledError` or hanging the close.
    """
    try:
        async for chunk in gen:
            yield chunk
    finally:
        _release_slot(meter, consumed=True)


async def _begin_metering(
    caller: "identity.Caller", *, request_id: str
) -> "metering.Meter | None":
    """Refuse an identity that cannot be charged, then take a hold. None when not enforcing.

    WHY BOTH CHECKS, AND WHY `verified` ALONE IS NOT ENOUGH.

    `resolve_caller` returns `Caller(ANONYMOUS_USER_ID, verified=True)` when the header is missing or
    malformed -- anonymous is "verified" because there is no id to forge. So `caller.verified` alone
    passes every unauthenticated visitor straight through to a wallet lookup. Both conditions are
    needed, and `Caller.is_anonymous` exists for exactly this.

    Anonymous is refused rather than given a free tier because that UUID is a single shared identity
    handed to every caller who presents no header: a wallet on it would be one bank account for the
    whole internet, drained by the first abuser. A free tier, if one is wanted, has to be per-IP or
    per-device with its own quota, not a wallet.

    `verified` is refused here even though `INTERNAL_AUTH_ENFORCE` still defaults False globally.
    That flag governs a two-phase rollout for read paths; this is a write path that spends money, and
    `identity.py` says in as many words that such a path may want to refuse on this basis. The web
    client's proxy already signs every request, so the only callers this turns away are the ones
    bypassing it -- which is the population that must be turned away.
    """
    if not config.GPU_BILLING_ENFORCE:
        # Shadow mode: measure only. Metering an unusable identity would mean creating wallets for
        # anonymous callers, so there is nothing to measure until an identity can be charged.
        if caller.is_anonymous or not caller.verified:
            return None
    else:
        if caller.is_anonymous:
            raise HTTPException(status_code=401, detail="Sign in to use the tutor.")
        if not caller.verified:
            raise HTTPException(status_code=401, detail="This request could not be authenticated.")

    backend = "sglang" if USE_SGLANG else ("vllm" if USE_VLLM else "hf")
    try:
        async with AsyncSessionLocal() as db:
            return await metering.begin(
                db,
                caller.user_id,
                request_id=request_id,
                kind="chat",
                backend=backend,
                max_slot_seconds=config.GPU_MAX_SLOT_SECONDS,
                floor_micro=config.GPU_FLOOR_MICRO,
            )
    except gpu_wallet_service.InsufficientCredit as exc:
        if not config.GPU_BILLING_ENFORCE:
            logger.info("[%s] would refuse (402) but billing is not enforced: %s", request_id, exc)
            return None
        raise HTTPException(
            status_code=402,
            detail={
                "error": "insufficient_credit",
                "message": str(exc),
                "required_micro": exc.required_micro,
                "available_micro": exc.available_micro,
            },
        ) from exc
    except gpu_wallet_service.NoWallet:
        if not config.GPU_BILLING_ENFORCE:
            return None
        raise HTTPException(
            status_code=402,
            detail={"error": "no_wallet", "message": "This account has no GPU credit yet."},
        ) from None


def _release_slot(meter: "metering.Meter | None", *, consumed: bool) -> None:
    """Release the permit and finish the meter, together, at every site that does either.

    Collapsing the five bare `release()` calls into one helper is what makes the invariant
    checkable: `test_gpu_metering.py` asserts that every `_inference_semaphore.release()` in this
    file is inside this function. A sixth release site added later without a settle would leave a
    reservation held forever, and the learner's credit with it.

    `consumed=False` means the request never reached the model -- a failed prompt build, or a
    configuration refusal -- so the hold is released without a charge.
    """
    _inference_semaphore.release()
    if meter is not None:
        meter.finish(consumed=consumed)


# --- API Endpoints ---
@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "VoidCode AI API v5.2 - Hybrid Architecture"}


@app.get("/metrics")
async def metrics():
    """Prometheus scrape endpoint. Spec §6.2 — there was none.

    Deliberately NOT behind the identity dependency. A scraper is not a user, it has no session, and
    requiring one would mean either giving Prometheus a credential or giving up on scraping. The
    protection is network-level: in Kubernetes this port is reachable only from inside the namespace,
    and the deployment does not expose it through the ingress.
    """
    from fastapi import Response

    from . import metrics as metrics_module

    # Read the live counter out of identity.py rather than mirroring it. Two counters for one fact
    # drift, and the one on the dashboard would be the one nobody updated.
    metrics_module.set_enforcement(config.INTERNAL_AUTH_ENFORCE)
    body, content_type = metrics_module.render()
    return Response(content=body, media_type=content_type)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    from .database import AsyncSessionLocal
    from .redis_client import get_redis
    from .services.judge0_client import judge0_client

    gpu_memory_used = 0
    gpu_memory_total = 0

    if _TORCH_AVAILABLE and torch.cuda.is_available():
        gpu_memory_used = torch.cuda.memory_allocated() / 1e9
        gpu_memory_total = torch.cuda.get_device_properties(0).total_memory / 1e9

    judge0_available = await judge0_client.health_check()

    # Database health check
    db_connected = False
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            await session.execute(text("SELECT 1"))
            db_connected = True
    except Exception:
        pass

    # Redis health check
    redis_connected = False
    try:
        redis = get_redis()
        await redis.ping()
        redis_connected = True
    except Exception:
        pass

    # Overall status: healthy if core services work, degraded if DB/Redis down
    all_services_up = db_connected and redis_connected and judge0_available
    status = "healthy" if all_services_up else "degraded"

    # Architecture label and mode classification depend on active inference backend
    if USE_SGLANG:
        arch_label = "prompt-engineered"
        mode_info = {
            # SGLang (PE) path: all 6 modes are pure prompt-engineering — no LoRA
            "prompt_engineered": ["teaching", "debug", "followup", "explain", "general", "empathy"],
            "inference_backend": f"SGLang @ {SGLANG_BASE_URL}",
            # Reported so an experiment can VERIFY which arm is serving rather than assume it. A
            # stale process holding the port once served a whole arm with this flag off while the
            # run believed it was on -- the kind of silent wrong answer that only shows up as an
            # inexplicable null result.
            "two_stage_debug": USE_TWO_STAGE_DEBUG,
            "model": SGLANG_MODEL_NAME,
        }
    elif USE_VLLM:
        arch_label = "hybrid-vllm"
        mode_info = {
            "fine_tuned": ["teaching", "debug", "followup"],
            "prompt_engineered": ["explain", "general", "empathy"],
            "inference_backend": "vLLM PagedAttention",
        }
    else:
        arch_label = "hybrid-hf"
        mode_info = {
            "fine_tuned": ["teaching", "debug", "followup"],
            "prompt_engineered": ["explain", "general", "empathy"],
            "inference_backend": "HuggingFace model.generate()",
        }

    return {
        "status": status,
        "version": "5.2",
        "architecture": arch_label,
        "model_loaded": _is_model_ready(),
        "judge0_available": judge0_available,
        "database_connected": db_connected,
        "redis_connected": redis_connected,
        "base_model": BASE_MODEL_ID,
        "adapter_path": ADAPTER_PATH if not USE_SGLANG else None,
        "modes": mode_info,
        # Whether grounded modes can actually cite anything. Queryable rather than a log line,
        # because "the tutor answered without citations" is indistinguishable from a normal answer
        # at the response, and this project has repeatedly shipped configuration that was never
        # read. `loaded: true, documents: 0` (seeded nothing) and `loaded: false` (database
        # unreachable) are deliberately different states.
        "knowledge_corpus": knowledge_cache.stats(),
        "gpu_memory_used_gb": round(gpu_memory_used, 2),
        "gpu_memory_total_gb": round(gpu_memory_total, 2),
    }


@app.get("/v1/models")
async def list_models():
    """List available models."""
    return {
        "object": "list",
        "data": [
            {
                "id": "voidcode-ai-v5.2",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "voidcode-ai",
                "architecture": "hybrid",
            }
        ]
    }


@app.post("/v1/chat/completions")
async def create_chat_completion(
    request: ChatCompletionRequest,
    http_request: Request,
    caller: identity.Caller = Depends(identity.resolve_caller),
):
    """
    Create chat completion with hybrid architecture.

    v5.2: Automatically detects mode and uses appropriate system prompt.
    - TEACHING, DEBUG, FOLLOWUP: Fine-tuned behavior
    - EXPLAIN: Prompt-engineered with base model
    """
    # The most expensive endpoint in the product by a wide margin: a GPU for seconds per call, and
    # a semaphore that a flood would fill, so an unthrottled caller starves every other learner
    # rather than merely costing money.
    await ratelimit.check_ip(ratelimit.CHAT, http_request)

    # V3: reject an image the served model cannot read, BEFORE spending the semaphore or the GPU.
    # The alternative — answering from the text alone and saying nothing — returns a fluent reply
    # about a chart the model never saw, which the learner has no way to detect. Fail loudly or
    # deliver the image; there is no third branch. See apps/api/src/multimodal.py.
    try:
        multimodal.assert_can_accept(request.messages)
    except multimodal.VisionUnsupported as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc

    # SGLang and vLLM paths skip the local model==None check (backend is external)
    if not USE_SGLANG and not USE_VLLM and model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Concurrency gate — non-blocking; return 503 immediately if at capacity so
    # students get fast feedback instead of silently queuing behind a full server.
    if _inference_semaphore.locked():
        raise HTTPException(
            status_code=503,
            detail=(
                f"Server at capacity ({_MAX_CONCURRENT_REQUESTS} concurrent requests). "
                "Please retry in a few seconds."
            ),
        )
    await _inference_semaphore.acquire()

    # _semaphore_held_by_wrapper: set to True when we return a StreamingResponse —
    # _semaphore_wrapped() releases the permit after the stream ends.
    # For non-streaming paths the inner try/finally releases it.
    _semaphore_held_by_wrapper = False

    # A UUID, not a millisecond timestamp.
    #
    # This was `f"chatcmpl-{int(time.time() * 1000)}"`, which is not unique: two requests in the
    # same millisecond collide, and `deploy/base/api-deployment.yaml` runs two replicas (HPA to
    # four) whose clocks collide freely. Nothing depended on uniqueness while the id was only an
    # OpenAI-shaped echo, but GPU metering keys a reservation to a request, and a duplicate id
    # there charges one learner for another's generation.
    #
    # Format is preserved -- `chatcmpl-` prefix, opaque suffix -- because clients treat it as
    # opaque and the OpenAI shape says nothing about how the suffix is built.
    request_id = f"chatcmpl-{uuid.uuid4().hex}"

    # The clock starts HERE, after acquire() returned, so a request never pays for the time it
    # spent waiting for a slot. Queue wait is a throughput problem, not a learner's cost.
    meter = None

    # Prepare messages with hybrid architecture (mode detection + system prompt injection)
    # Guard separately: if this throws after acquire(), the permit must be released
    # or it leaks forever (no outer try/finally covers this section).
    #
    # The reservation joins this block rather than getting one of its own: the block already exists
    # and already releases the permit on every failure, and extending it is strictly less risky than
    # introducing a second acquire-then-guard.
    try:
        if config.GPU_METERING_ENABLED:
            meter = await _begin_metering(caller, request_id=request_id)
        messages, detected_mode = prepare_messages_hybrid(request.messages)
    except HTTPException:
        # Already the right status -- 401 for an unusable identity, 402 for insufficient credit.
        # Nothing was consumed, so void rather than settle.
        _release_slot(meter, consumed=False)
        raise
    except Exception as _prep_err:
        _release_slot(meter, consumed=False)
        logger.exception(f"[{request_id}] prepare_messages_hybrid failed: {_prep_err}")
        raise HTTPException(status_code=500, detail=f"Request preparation failed: {_prep_err!s}") from _prep_err

    # Log request. text_of() again: slicing [:60] on a parts list would raise here, in the logging
    # line, long after the real work — an unhelpful place to discover the request was multimodal.
    user_messages = [msg for msg in request.messages if msg.role == "user"]
    latest_user_message = multimodal.text_of(user_messages[-1].content) if user_messages else ""
    logger.info(f"[{request_id}] Mode: {detected_mode.upper()} | Query: {latest_user_message[:60]}...")

    # ── Two-stage debug (stage A) ────────────────────────────────────────────
    # First turn only. A later turn is an escalation, where naming the line is the point, and
    # re-localising would also discard the conversation the student has been having.
    _reasoning_visible_to_caller.set(bool(request.include_reasoning))

    located_issues: list[dict] | None = None
    if (USE_TWO_STAGE_DEBUG and USE_SGLANG and detected_mode == "debug"
            and len(user_messages) <= 1):
        located_issues = await _localise_bugs(latest_user_message, request_id)
        if located_issues:
            # Replace the system prompt: stage B is handed location and symptom and NOT the fix.
            # Grounding is not reapplied -- `debug` is not in GROUNDED_MODES, so there was none.
            messages = [{"role": "system", "content": _hint_system_prompt(located_issues)}] + [
                m for m in messages if m.get("role") != "system"]

    # Handle streaming
    if request.stream:
        if USE_VLLM:
            # ── P4: vLLM streaming path ────────────────────────────────────
            # vLLM takes a plain string prompt (not token IDs).
            # apply_chat_template converts the messages list to the Qwen chat format.
            from .vllm_engine import generate_stream_vllm
            gen_cfg = get_generation_config(detected_mode)
            actual_max_tokens = min(request.max_tokens, gen_cfg["max_new_tokens"])
            actual_temp = (
                request.temperature
                if request.temperature is not None
                else gen_cfg["temperature"]
            )
            vllm_prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            _semaphore_held_by_wrapper = True
            return StreamingResponse(
                _semaphore_wrapped(generate_stream_vllm(
                    prompt=vllm_prompt,
                    mode=detected_mode,
                    max_new_tokens=actual_max_tokens,
                    temperature=actual_temp,
                    top_p=request.top_p,
                    repetition_penalty=request.repetition_penalty,
                    request_id=request_id,
                ), meter),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        if USE_SGLANG:
            # ── SGLang streaming path ──────────────────────────────────────
            gen_cfg = get_generation_config(detected_mode)
            actual_max_tokens = token_budget(
                detected_mode, latest_user_message, request.max_tokens)
            actual_temp = (
                request.temperature
                if request.temperature is not None
                else gen_cfg["temperature"]
            )
            actual_top_p = (
                request.top_p
                if request.top_p is not None
                else gen_cfg.get("top_p", 0.95)
            )
            _semaphore_held_by_wrapper = True

            # Stage A's diagnosis travels as a HEADER, not as a stream frame.
            #
            # It was briefly prepended by wrapping the generator in another async generator, and
            # that wrapper is the only suspect for an API that died silently after 20-60 requests --
            # three times on this arm, while the one run with the flag off survived. A discarded
            # wrapper never drives the inner generator to completion, so its `finally` never runs and
            # the underlying SGLang stream is left open.
            #
            # A header avoids the question entirely: it is sent before the body, needs no extra
            # generator, and cannot be mixed into the answer text under any failure mode.
            _headers = {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
            if request.include_diagnosis and located_issues is not None:
                _headers["X-VoidCode-Diagnosis"] = json.dumps(located_issues)

            return StreamingResponse(
                _semaphore_wrapped(generate_stream_sglang(
                    messages=messages,
                    mode=detected_mode,
                    max_new_tokens=actual_max_tokens,
                    temperature=actual_temp,
                    top_p=actual_top_p,
                    request_id=request_id,
                    top_k=gen_cfg.get("top_k", 20),
                    min_p=gen_cfg.get("min_p", 0.0),
                    presence_penalty=gen_cfg.get("presence_penalty", 0.0),
                    thinking_budget_tokens=gen_cfg.get("thinking_budget_tokens", 512),
                    enable_thinking=gen_cfg.get("enable_thinking", True),
                ), meter),
                media_type="text/event-stream",
                headers=_headers,
            )

        # ── HF streaming path (USE_VLLM=false, USE_SGLANG=false) ──────────
        _semaphore_held_by_wrapper = True
        return StreamingResponse(
            _semaphore_wrapped(generate_stream(
                messages=messages,
                mode=detected_mode,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
                repetition_penalty=request.repetition_penalty,
                request_id=request_id,
            ), meter),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )

    # Non-streaming
    # vLLM mode only supports streaming (USE_VLLM=true). If the client sends
    # stream=false while vLLM is active, return a clear error rather than
    # crashing on model.device (model=None in the vLLM path).
    if USE_VLLM:
        # Not using _semaphore_wrapped; release manually. Nothing reached the model, so the hold
        # is voided rather than settled.
        _release_slot(meter, consumed=False)
        raise HTTPException(
            status_code=400,
            detail=(
                "Non-streaming requests (stream=false) are not supported when "
                "USE_VLLM=true. Set stream=true in your request."
            ),
        )

    # SGLang non-streaming: use OpenAI client with stream=False
    if USE_SGLANG:
        try:
            gen_cfg = get_generation_config(detected_mode)
            actual_max_tokens = token_budget(
                detected_mode, latest_user_message, request.max_tokens)
            actual_temp = (
                request.temperature
                if request.temperature is not None
                else gen_cfg["temperature"]
            )
            actual_top_p = (
                request.top_p
                if request.top_p is not None
                else gen_cfg.get("top_p", 0.95)
            )
            start_time = time.time()
            completion = await _sglang_client.chat.completions.create(
                model=SGLANG_MODEL_NAME,
                messages=messages,
                max_tokens=actual_max_tokens,
                temperature=actual_temp,
                top_p=actual_top_p,
                presence_penalty=gen_cfg.get("presence_penalty", 0.0),
                stream=False,
                # Per-mode, matching the streaming path. This was
                # `{"enable_thinking": True}` with no budget, so empathy and followup -- whose
                # configs disable thinking to protect 512- and 1024-token ceilings -- had it forced
                # back on and uncapped here.
                extra_body=_sglang_extra_body(
                    top_k=gen_cfg.get("top_k", 20),
                    min_p=gen_cfg.get("min_p", 0.0),
                    enable_thinking=gen_cfg.get("enable_thinking", True),
                    thinking_budget_tokens=gen_cfg.get("thinking_budget_tokens", 512),
                ),
            )
            raw_text = completion.choices[0].message.content or ""
            # Strip <think>…</think> from non-streaming response — thinking is
            # only meaningful in the streaming UI (ThinkingBlock component).
            response_text, _thinking = strip_thinking_tags(raw_text)
            prompt_tokens = completion.usage.prompt_tokens if completion.usage else 0
            completion_tokens = completion.usage.completion_tokens if completion.usage else 0
            generation_time = time.time() - start_time
            logger.info(
                f"[{request_id}] SGLang non-stream: {detected_mode.upper()} | "
                f"{completion_tokens} tokens | {generation_time:.2f}s | "
                f"thinking={'yes' if _thinking else 'no'}"
            )
            return ChatCompletionResponse(
                id=request_id,
                created=int(time.time()),
                choices=[
                    ChatCompletionChoice(
                        message=ChatMessage(role="assistant", content=response_text),
                    )
                ],
                usage=Usage(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=prompt_tokens + completion_tokens,
                ),
            )
        finally:
            _release_slot(meter, consumed=True)

    try:
        start_time = time.time()

        loop = asyncio.get_event_loop()
        future = loop.run_in_executor(
            executor,
            generate_response,
            messages,
            detected_mode,
            request.max_tokens,
            request.temperature,
            request.top_p,
            request.repetition_penalty,
        )

        try:
            response_text, prompt_tokens, completion_tokens, thinking_meta = await asyncio.wait_for(
                future,
                timeout=request.timeout
            )
        except TimeoutError:
            logger.error(f"[{request_id}] Generation timeout")
            raise HTTPException(status_code=504, detail="Generation timeout") from None

        generation_time = time.time() - start_time
        logger.info(f"[{request_id}] Response: {detected_mode.upper()} | {completion_tokens} tokens | {generation_time:.2f}s")

        # Build thinking metadata if present
        thinking_data = None
        if thinking_meta:
            thinking_data = ThinkingMetadata(
                content=thinking_meta["content"],
                token_count=thinking_meta["token_count"],
                budget_used=thinking_meta["budget_used"],
                budget_total=thinking_meta.get("budget_total", THINKING_TOKEN_BUDGET),
            )

        return ChatCompletionResponse(
            id=request_id,
            created=int(time.time()),
            choices=[
                ChatCompletionChoice(
                    message=ChatMessage(role="assistant", content=response_text),
                    thinking=thinking_data,
                )
            ],
            usage=Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
        )

    except TimeoutError:
        raise
    except torch.cuda.OutOfMemoryError:
        logger.error(f"[{request_id}] CUDA out of memory")
        torch.cuda.empty_cache()
        raise HTTPException(status_code=503, detail="GPU out of memory") from None
    except Exception as e:
        logger.exception(f"[{request_id}] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        # Release semaphore for non-streaming and error paths.
        # Streaming paths set _semaphore_held_by_wrapper=True so the permit is
        # held until _semaphore_wrapped() exhausts the generator and releases it —
        # and, with it, the meter, so a stream is not settled twice.
        if not _semaphore_held_by_wrapper:
            # `consumed=True` even on the error paths: reaching here means the permit was held
            # through an attempt at generation, and the slot was occupied whether or not an answer
            # came back. Charging for a failed generation is uncomfortable but it is the honest
            # reading of occupancy, and the alternative — free retries on any error — is the one
            # that can be driven deliberately.
            _release_slot(meter, consumed=True)


# --- Main ---
def main():
    parser = argparse.ArgumentParser(description="VoidCode AI v5.2 - Hybrid Architecture")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    parser.add_argument("--adapter-path", default=None, help="Path to LoRA adapter")
    args = parser.parse_args()

    if args.adapter_path:
        app.state.adapter_path = args.adapter_path
    else:
        app.state.adapter_path = ADAPTER_PATH

    logger.info("=" * 60)
    logger.info("VOIDCODE AI v5.2 - HYBRID ARCHITECTURE")
    logger.info("=" * 60)
    logger.info(f"Host: {args.host}:{args.port}")
    logger.info(f"Adapter: {app.state.adapter_path}")
    logger.info("Fine-tuned: TEACHING, DEBUG, FOLLOWUP")
    logger.info("Prompt-engineered: EXPLAIN")
    logger.info("=" * 60)

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
