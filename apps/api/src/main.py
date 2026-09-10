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
from typing import Any, NamedTuple

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
from . import (
    config,
    identity,
    knowledge_cache,
    metering,
    metrics,
    multimodal,
    ratelimit,
    withholding,
)
from .database import AsyncSessionLocal
from .routers.auth import router as auth_router
from .routers.chat import router as chat_router
from .routers.credits import router as credits_router
from .routers.dashboard import router as dashboard_router
from .routers.drafts import router as drafts_router
from .routers.execution import router as execution_router
from .routers.interviews import router as interviews_router
from .routers.notifications import router as notifications_router
from .routers.papers import router as papers_router
from .routers.problems import router as problems_router
from .routers.profile import router as profile_router
from .routers.recommendations import router as recommendations_router
from .schemas.chat import MessageContent
from .services import (
    backend_registry,
    gpu_sweep_service,
    gpu_wallet_service,
    queue_service,
    spindown,
)

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

# ── Inference backend ────────────────────────────────────────────────────────
# These moved to `config.py` so `test_env_templates.py` can see them: it derives the
# must-be-documented set by scanning that file, and six inline `os.getenv` calls here were invisible
# to it. The reasoning behind each value moved with it -- particularly why the SGLang timeout is 900
# while nginx reads 300, which looks contradictory and is not.
USE_VLLM = config.USE_VLLM
USE_SGLANG = config.USE_SGLANG
SGLANG_BASE_URL = config.SGLANG_BASE_URL
SGLANG_MODEL_NAME = config.SGLANG_MODEL_NAME
SGLANG_TIMEOUT_SECONDS = config.SGLANG_TIMEOUT_SECONDS

_MAX_CONCURRENT_REQUESTS = config.MAX_CONCURRENT_REQUESTS
_inference_semaphore = asyncio.Semaphore(_MAX_CONCURRENT_REQUESTS)

# Global model references
# HF path:     model + tokenizer loaded in-process
# vLLM path:   vllm_engine module manages the engine; tokenizer loaded here
# SGLang path: _sglang_client (AsyncOpenAI) — no model/tokenizer in this process
model = None
tokenizer = None
# The SGLang client is NOT a module global any more. It lives in `services/backend_registry`
# and is resolved per call by `_backend_client()`, because a client with the address baked in
# cannot notice a backend that moved -- and could not tell `/health` whether one was there.
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
        logger.info(f"USE_SGLANG=true — connecting to SGLang at {SGLANG_BASE_URL}")

        # Built through the registry rather than assigned directly, so the address is a value that
        # can change rather than one baked into a client at startup. Nothing changes it yet; that
        # is what makes spin-down possible later, and what makes `/health` able to tell the truth
        # now. See `services/backend_registry.py`.
        def _make_client(base_url: str):
            return _openai.AsyncOpenAI(
                base_url=base_url,
                api_key="none",  # SGLang does not require authentication
                timeout=SGLANG_TIMEOUT_SECONDS,
            )

        backend_registry.configure(SGLANG_BASE_URL, _make_client)
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
                await _backend_client().chat.completions.create(
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

    # The idle watcher. Both switches, because this one can take the backend away from a learner
    # mid-session if the idle predicate is ever wrong, and that is the most user-visible failure
    # available in this subsystem. `watch_loop` returns immediately when disabled rather than
    # becoming a task that wakes every two minutes to decide it may do nothing.
    _spindown_task = None
    if config.SPINDOWN_ENABLED and config.POD_CONTROL_ENABLED:
        _spindown_task = asyncio.create_task(spindown.watch_loop())
        logger.info("gpu idle watcher started")

    yield

    # Shutdown
    logger.info("Shutting down...")

    if _spindown_task is not None:
        # Cancelled before anything else: a spin-down decision made during shutdown would be based
        # on a system that is idle only because it is stopping.
        _spindown_task.cancel()

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
app.include_router(credits_router)
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
    if _backend_client() is None:
        return None
    try:
        completion = await _backend_client().chat.completions.create(
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
    protected: set[str] | None = None,
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

    # ── The output guard ────────────────────────────────────────────────────────────────────
    #
    # INSIDE this generator rather than wrapped around it, and that is not a style preference. The
    # comment in `_stream_for` records an API that died silently after 20-60 requests, with a
    # discarded generator wrapper as the only suspect: a wrapper never driven to completion never
    # runs its `finally`, so the upstream SGLang stream is left open. Adding a second wrapper here
    # to filter tokens would be re-running that experiment. Filtering where the frames are already
    # built adds no layer and no new `finally`.
    gate = (
        withholding.SolutionGate(protected)
        if protected and config.WITHHOLD_SOLUTIONS
        else None
    )

    def _content_chunk(text: str) -> str:
        return "data: " + json.dumps({
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "choices": [{"delta": {"content": text}, "index": 0, "finish_reason": None}],
        }) + "\n\n"

    def _deliver(text: str) -> str | None:
        """One content frame, or None when the gate is holding everything it was just given.

        Returning None rather than an empty frame matters: an empty `delta.content` is a valid
        chunk, and emitting one per held token would make a withheld block look like the model
        stuttering rather than like nothing happening.
        """
        nonlocal full_response
        out = gate.feed(text) if gate is not None else text
        if not out:
            return None
        full_response += out
        return _content_chunk(out)

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
        response = await _backend_client().chat.completions.create(
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
                        completion_tokens += 1
                        frame = _deliver(after)
                        if frame:
                            yield frame
                continue  # buffer all tokens until </think> found

            # ── Regular content token ────────────────────────────────────────
            completion_tokens += 1
            frame = _deliver(token)
            if frame:
                yield frame

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
                    completion_tokens += len(clean.split())
                    frame = _deliver(clean)
                    if frame:
                        yield frame

        # Release whatever the gate is still holding, judged now because nothing more is
        # coming.
        #
        # BEFORE the terminal chunk, deliberately. A strict client treats `finish_reason` as
        # the end of the answer, so anything released after it is dropped -- and the end of a
        # reply is exactly where a model that has been talked into it puts the function.
        if gate is not None:
            tail = gate.flush()
            if tail:
                full_response += tail
                yield _content_chunk(tail)
            if gate.withheld:
                logger.warning(
                    "[%s] withheld a complete %s from a %s reply",
                    request_id, ", ".join(gate.withheld), mode,
                )
                metrics._bump(metrics.solutions_withheld, {"mode": mode})

        # THE TERMINAL CHUNK, WHICH THIS PATH NEVER SENT.
        #
        # Every content chunk above carries `finish_reason: None`, and this stream then went
        # straight to the usage event and `[DONE]` -- so a completed answer was indistinguishable,
        # on the wire, from a connection that dropped mid-generation. The HF path has always sent
        # one (see `generate_stream`); this one did not.
        #
        # Nothing noticed because the web panel keys completion on the `[DONE]` sentinel. A strict
        # OpenAI client keys on `finish_reason`, which is what the specification says, and the
        # desktop app reported every successful answer as "closed the connection before finishing".
        # Worse for an agent: `finishReason` is the only thing that distinguishes "the model
        # finished" from "the model wants tools run and is waiting", so a loop keyed on it either
        # stops early or spins.
        #
        # Emitted before the usage event so a client that stops at the terminal chunk has already
        # seen the whole answer, and after the flush above so no content follows it.
        terminal_chunk = {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(terminal_chunk)}\n\n"

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


def _backend_client():
    """The client for the address in force right now.

    A function rather than the module global it replaces: the global was assigned once in the
    lifespan with the base URL baked in, so a backend that moved was invisible until the process
    restarted. Resolving per call costs a dictionary lookup and removes that entire class of
    problem.
    """
    return backend_registry.current_client()


async def _is_model_ready() -> bool:
    """Return True if the LLM inference backend is initialised AND answering.

    THIS USED TO RETURN `_sglang_client is not None`, which is a statement about whether a Python
    object was constructed at startup -- not about whether anything is listening. Point the config
    at a dead address and `/health` reported `model_loaded: true`, to a readiness probe, to a load
    balancer, and to whoever was trying to work out why every request was failing.

    A health endpoint that cannot report ill-health is worse than no health endpoint, because
    everything downstream is built on trusting it. It is async now because finding out requires
    asking; the probe is cached for a few seconds so a burst of health checks is one request rather
    than one per check per replica.
    """
    if USE_SGLANG:
        return await backend_registry.probe() == backend_registry.READY
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
    lease: "queue_service.SlotLease | None" = None,
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

    `lease` is here for exactly the same reason and was briefly NOT, which is worth recording. The
    fleet-slot lease was threaded through the six `_release_slot` call sites by editing them all to
    read `lease=slot_lease` -- and one of those six is this `finally`, in a module-level function
    where `slot_lease` is a local of the endpoint and does not exist. Every streaming request would
    have raised `NameError` while cleaning up. 419 tests did not catch it, because none of them
    drives this generator; `ruff --select F821` found it in under a second.

    `finish()` schedules and returns; it never awaits. During a client disconnect this `finally`
    runs while the task is being cancelled, and awaiting database I/O there risks swallowing the
    `CancelledError` or hanging the close.
    """
    try:
        async for chunk in gen:
            yield chunk
    finally:
        _release_slot(meter, consumed=True, lease=lease)


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


def _release_slot(
    meter: "metering.Meter | None",
    *,
    consumed: bool,
    lease: "queue_service.SlotLease | None" = None,
) -> None:
    """Release the permit and finish the meter, together, at every site that does either.

    Six call sites in this file route through here (1703, 2002, 2005, 2146, 2218, 2293 at the time
    of writing). The actual pairing lives in `metering.release_slot`, because this file is not the
    only one that releases this semaphore: `interviews.py` imports `_inference_semaphore` and hands
    it to `metering.gpu_slot`, which released it directly until that was noticed.

    `test_gpu_metering_wiring.py::test_the_only_release_call_is_inside_release_slot` now asserts the
    invariant across BOTH files. A seventh release site added later without a settle would leave a
    reservation held forever, and the learner's credit with it.

    `consumed=False` means the request never reached the model -- a failed prompt build, or a
    configuration refusal -- so the hold is released without a charge.
    """
    metering.release_slot(_inference_semaphore, meter, consumed=consumed)
    if lease is not None:
        lease.release_in_background(AsyncSessionLocal)


# --- API Endpoints ---
@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "VoidCode AI API v5.2 - Hybrid Architecture"}


@app.get("/metrics")
async def prometheus_metrics():
    """Prometheus scrape endpoint. Spec §6.2 — there was none.

    NAMED `prometheus_metrics`, NOT `metrics`, AND THAT IS NOT COSMETIC. A module-level `async def
    metrics()` binds the name `metrics` for the entire module, shadowing `from . import metrics`
    everywhere below it. This function already worked around its own shadow with a local import;
    what it could not do was stop code added later from writing `metrics.record_...` and getting an
    AttributeError on a route handler. That is exactly what happened when the queue metrics landed,
    and no linter caught it -- the name resolves, it is just bound to the wrong thing.

    Deliberately NOT behind the identity dependency. A scraper is not a user, it has no session, and
    requiring one would mean either giving Prometheus a credential or giving up on scraping. The
    protection is network-level: in Kubernetes this port is reachable only from inside the namespace,
    and the deployment does not expose it through the ingress.
    """
    from fastapi import Response

    # Read the live counter out of identity.py rather than mirroring it. Two counters for one fact
    # drift, and the one on the dashboard would be the one nobody updated.
    metrics.set_enforcement(config.INTERNAL_AUTH_ENFORCE)

    # THE QUEUE GAUGES ARE SAMPLED HERE, AT SCRAPE TIME, AND THEY WERE NOT BEFORE.
    #
    # They were declared with a setter and nothing called it, so both read 0.0 for the life of the
    # process -- which is worse than not having them: a dashboard would show an empty queue and an
    # idle fleet during a pile-up, and the graph would look like the thing was working.
    #
    # A gauge describing current state belongs at the scrape rather than on the request path.
    # Setting it from the queue loop would mean it only updated while somebody was waiting, so it
    # would freeze at the last value once the queue drained and read as a permanent backlog.
    #
    # Wrapped, because instrumentation must never be the reason a request fails -- and this one is
    # the endpoint that reports whether anything is wrong. A database that is down leaves the
    # gauges at their previous values, which is the least misleading option available.
    if config.GPU_QUEUE_ENABLED:
        try:
            async with AsyncSessionLocal() as db:
                metrics.set_queue_gauges(
                    depth=await queue_service.waiting_count(db),
                    slots_in_use=await queue_service.slots_in_use(db),
                )
        except Exception as exc:
            logger.debug("could not sample the queue gauges: %s", exc)

    body, content_type = metrics.render()
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
        "model_loaded": await _is_model_ready(),
        # Distinguishes "deliberately down and coming back" from "down". Identical from outside
        # otherwise, and they call for opposite reactions: one is a wait, the other is a page.
        "backendState": await backend_registry.probe() if USE_SGLANG else None,
        "judge0_available": judge0_available,
        "database_connected": db_connected,
        "redis_connected": redis_connected,
        # What is ACTUALLY serving, asked of the backend rather than assumed from config.
        # `BASE_MODEL_ID` describes the in-process HuggingFace path and means nothing when
        # inference is delegated -- this endpoint reported a 7B while a 30B answered every
        # request. Falls back to the configured alias, then to None: naming no model is
        # better than naming the wrong one, which is the whole reason this module exists.
        "base_model": (
            backend_registry.served_model(SGLANG_MODEL_NAME) or (SGLANG_MODEL_NAME or None)
            if USE_SGLANG else BASE_MODEL_ID
        ),
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



class _Prepared(NamedTuple):
    """Everything decided between taking a slot and asking the model for tokens."""

    meter: "metering.Meter | None"
    messages: list
    detected_mode: str
    latest_user_message: str
    located_issues: list[dict] | None


async def _prepare_for_generation(
    request: "ChatCompletionRequest", caller: identity.Caller, request_id: str
) -> _Prepared:
    """Take the hold, build the prompt, run stage-A localisation. Raises `HTTPException`.

    LIFTED OUT OF THE ENDPOINT SO IT CAN RUN IN TWO PLACES, and the two places differ in exactly one
    way that matters: whether response headers have already been sent.

    On the ordinary path this runs BEFORE headers, so a 402 for insufficient credit or a 401 for an
    unusable identity is a real HTTP status the client sees as one. On the queued path it runs after
    headers -- there is no way to report a queue position without sending them first -- so the same
    exception has to become an in-band error event on a 200 response. That is a genuine loss and it
    is why the ordinary path was kept rather than routing everything through the queue.

    It does NOT release the slot on failure. The caller owns the slot and knows how to give it back;
    a helper that released a lease it was handed would be releasing something it does not own.
    """
    meter = None
    try:
        if config.GPU_METERING_ENABLED:
            meter = await _begin_metering(caller, request_id=request_id)
        messages, detected_mode = prepare_messages_hybrid(request.messages)
    except HTTPException:
        # Already the right status -- 401 for an unusable identity, 402 for insufficient credit.
        # THE HOLD IS VOIDED HERE, because this function is what took it. If metering succeeded and
        # the prompt build then threw, the learner has credit reserved against a request that will
        # never run; the caller cannot void it because it never received the meter. Ownership is
        # split cleanly: this owns the meter it created, the caller owns the slot it was given.
        if meter is not None:
            meter.finish(consumed=False)
        raise
    except Exception as _prep_err:
        if meter is not None:
            meter.finish(consumed=False)
        logger.exception(f"[{request_id}] prepare_messages_hybrid failed: {_prep_err}")
        raise HTTPException(
            status_code=500, detail=f"Request preparation failed: {_prep_err!s}"
        ) from _prep_err

    # Log request. text_of() again: slicing [:60] on a parts list would raise here, in the logging
    # line, long after the real work — an unhelpful place to discover the request was multimodal.
    user_messages = [msg for msg in request.messages if msg.role == "user"]
    latest_user_message = multimodal.text_of(user_messages[-1].content) if user_messages else ""
    logger.info(
        f"[{request_id}] Mode: {detected_mode.upper()} | Query: {latest_user_message[:60]}..."
    )

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

    return _Prepared(meter, messages, detected_mode, latest_user_message, located_issues)


def _stream_for(request: "ChatCompletionRequest", request_id: str, prepared: _Prepared):
    """The backend's token generator for this request, and the headers that go with it.

    Returns the INNER generator, unwrapped. Whoever calls this owns the slot and is responsible for
    putting exactly one `finally` around the iteration -- `_semaphore_wrapped` on the ordinary path,
    `_queued_stream`'s own `finally` on the queued one. This function deliberately does not wrap,
    because a second wrapper layer is the failure this file documents at length: a discarded
    wrapper never drives the inner generator to completion, its `finally` never runs, and the
    upstream stream leaks. One layer, one `finally`, one invariant.
    """
    gen_cfg = get_generation_config(prepared.detected_mode)
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }

    if USE_VLLM:
        # vLLM takes a plain string prompt (not token IDs). apply_chat_template converts the
        # messages list to the Qwen chat format.
        from .vllm_engine import generate_stream_vllm
        actual_max_tokens = min(request.max_tokens, gen_cfg["max_new_tokens"])
        actual_temp = (
            request.temperature if request.temperature is not None else gen_cfg["temperature"]
        )
        vllm_prompt = tokenizer.apply_chat_template(
            prepared.messages, tokenize=False, add_generation_prompt=True
        )
        return generate_stream_vllm(
            prompt=vllm_prompt,
            mode=prepared.detected_mode,
            max_new_tokens=actual_max_tokens,
            temperature=actual_temp,
            top_p=request.top_p,
            repetition_penalty=request.repetition_penalty,
            request_id=request_id,
        ), headers

    if USE_SGLANG:
        actual_max_tokens = token_budget(
            prepared.detected_mode, prepared.latest_user_message, request.max_tokens
        )
        actual_temp = (
            request.temperature if request.temperature is not None else gen_cfg["temperature"]
        )
        actual_top_p = (
            request.top_p if request.top_p is not None else gen_cfg.get("top_p", 0.95)
        )

        # Stage A's diagnosis travels as a HEADER, not as a stream frame.
        #
        # It was briefly prepended by wrapping the generator in another async generator, and that
        # wrapper is the only suspect for an API that died silently after 20-60 requests -- three
        # times on this arm, while the one run with the flag off survived. A discarded wrapper never
        # drives the inner generator to completion, so its `finally` never runs and the underlying
        # SGLang stream is left open.
        #
        # A header avoids the question entirely: it is sent before the body, needs no extra
        # generator, and cannot be mixed into the answer text under any failure mode.
        #
        # NOTE FOR THE QUEUED PATH: headers are already gone by the time preparation runs there, so
        # a queued request carries no diagnosis header. That is a real asymmetry and it is recorded
        # rather than papered over -- see `_queued_stream`.
        if request.include_diagnosis and prepared.located_issues is not None:
            headers["X-VoidCode-Diagnosis"] = json.dumps(prepared.located_issues)

        return generate_stream_sglang(
            messages=prepared.messages,
            mode=prepared.detected_mode,
            max_new_tokens=actual_max_tokens,
            temperature=actual_temp,
            top_p=actual_top_p,
            request_id=request_id,
            top_k=gen_cfg.get("top_k", 20),
            min_p=gen_cfg.get("min_p", 0.0),
            presence_penalty=gen_cfg.get("presence_penalty", 0.0),
            thinking_budget_tokens=gen_cfg.get("thinking_budget_tokens", 512),
            enable_thinking=gen_cfg.get("enable_thinking", True),
            # Read from the learner's own submission, so no catalogue -- and therefore no
            # answer key -- is ever loaded on the serving path. Empty when no code is
            # attached, which disables the guard for general questions, deliberately.
            protected=withholding.protected_functions(prepared.latest_user_message),
        ), headers

    # ── HF streaming path (USE_VLLM=false, USE_SGLANG=false) ──────────
    return generate_stream(
        messages=prepared.messages,
        mode=prepared.detected_mode,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        top_p=request.top_p,
        repetition_penalty=request.repetition_penalty,
        request_id=request_id,
    ), headers




def _queue_frame(request_id: str, position: int, backend_state: str) -> str:
    """One queue update, shaped so that every reader does something sensible with it.

    THREE AUDIENCES, ONE FRAME.

      * **The proxies.** The leading SSE comment is what keeps the connection alive. `nginx.conf`'s
        `proxy_read_timeout` is a gap-BETWEEN-READS timeout, so anything written resets it -- which
        is exactly why a heartbeating stream has no 300s ceiling while a silent wait would hit one.
        Every conformant SSE parser discards a comment line, so it costs nothing to send.
      * **A strict OpenAI client**, such as the desktop app, which points at this endpoint with a
        hardcoded base URL. It sees a valid `chat.completion.chunk` whose delta is empty, renders
        nothing, and ignores the extra keys. That is why this is not a bespoke event shape.
      * **Our own web client**, which branches on `type` -- the convention already used by the
        `thinking` and `usage` frames this endpoint emits.

    The web client's loop is worth knowing when changing this: it skips anything not starting with
    `data: `, silently skips unparseable JSON, and guards content on `if (delta)`. An empty delta is
    therefore a no-op there today, before it learns what a queue frame is.
    """
    chunk = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": SGLANG_MODEL_NAME if USE_SGLANG else BASE_MODEL_ID,
        "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
        "type": "queue",
        "queue": {
            "position": position,
            "ahead": max(position - 1, 0),
            "backendState": backend_state,
        },
    }
    return f": queue position {position}\n\n" + f"data: {json.dumps(chunk)}\n\n"


def _stream_error(message: str, kind: str) -> str:
    """A refusal delivered inside a 200 response, because the headers are already gone.

    This is the price of reporting queue position at all, and it is worth stating plainly: once the
    response has started there is no status code left to send. A learner who runs out of credit
    while queued gets a 200 whose body says so, rather than a 402. The ordinary path -- every
    request that does not wait -- still gets the real status, which is why it was kept.
    """
    return (
        f"data: {json.dumps({'error': {'message': message, 'type': kind}})}\n\n"
        "data: [DONE]\n\n"
    )


async def _queued_stream(
    request: "ChatCompletionRequest",
    caller: identity.Caller,
    http_request: Request,
    request_id: str,
):
    """Wait for a slot in view of the learner, then prepare and generate. One generator, one finally.

    WHY THIS EXISTS AT ALL. Response headers cannot be sent twice, so anything that reports progress
    has to send them first -- which means everything after that point, including refusals that used
    to be HTTP statuses, happens inside the body. That is a real cost, paid only by requests that
    actually have to wait.

    WHY IT IS ONE GENERATOR AND NOT A WRAPPER AROUND `_semaphore_wrapped`. This file records an API
    that died silently after 20-60 requests when a discarded async-generator wrapper's `finally`
    never ran and the upstream stream leaked. So this does not wrap: it delegates with `async for`
    and carries the single `finally` itself, exactly as `_semaphore_wrapped` does for the ordinary
    path. One layer, one `finally`, one invariant.

    WHAT A QUEUED REQUEST DOES NOT GET. The stage-A diagnosis travels as a response header, and by
    the time preparation runs here the headers are long gone. A queued debug request therefore
    carries no `X-VoidCode-Diagnosis`. Left as an asymmetry rather than moved in-band, because
    moving it would change the frame shape for every client to serve the rarer path.
    """
    lease = None
    prepared = None
    acquired_semaphore = False
    consumed = False
    queued_at = time.monotonic()

    try:
        # ── The wait, in view of the caller ──────────────────────────────────────────────
        async for kind, payload in queue_service.wait_for_slot_events(
            AsyncSessionLocal,
            caller.user_id,
            request_id,
            max_wait_seconds=config.GPU_QUEUE_MAX_WAIT_SECONDS,
            max_depth=config.GPU_QUEUE_MAX_DEPTH,
            is_disconnected=http_request.is_disconnected,
        ):
            if kind == queue_service.POSITION:
                state = (
                    await backend_registry.probe() if USE_SGLANG else backend_registry.READY
                )
                yield _queue_frame(request_id, payload, state)
            else:
                ticket_id, slot_id = payload
                lease = queue_service.lease_from_admission(AsyncSessionLocal, ticket_id, slot_id)

        if lease is None:  # pragma: no cover — the generator raises rather than ending
            yield _stream_error("The queue closed without admitting this request.", "queue_error")
            return

        metrics.observe_queue_wait(time.monotonic() - queued_at)

        # ── Admitted. Everything from here is what the ordinary path does before headers ──
        await _inference_semaphore.acquire()
        acquired_semaphore = True

        prepared = await _prepare_for_generation(request, caller, request_id)
        inner, _headers = _stream_for(request, request_id, prepared)

        consumed = True
        async for chunk in inner:
            yield chunk

    except queue_service.QueueFull:
        metrics.record_queue_abandoned("full")
        yield _stream_error(
            "Too many requests are waiting. Please try again shortly.", "queue_full"
        )
    except queue_service.QueueTimeout:
        metrics.record_queue_abandoned("timeout")
        yield _stream_error(
            "No serving slot became free in time. Please try again.", "queue_timeout"
        )
    except HTTPException as exc:
        # A 402 or 401 that arrived too late to be a status code. The detail is already written for
        # a learner to read -- `_begin_metering` phrases it that way -- so it is passed through.
        detail = exc.detail
        if isinstance(detail, dict):
            detail = detail.get("message", str(detail))
        yield _stream_error(str(detail), f"http_{exc.status_code}")
    except Exception as exc:
        logger.exception(f"[{request_id}] queued stream failed: {exc}")
        yield _stream_error("The request could not be completed.", "internal_error")
    finally:
        # The one `finally`. Releases only what was actually taken: releasing a semaphore that was
        # never acquired raises its permit count above the cap, which is a capacity leak that gets
        # worse with every timed-out request rather than announcing itself.
        if acquired_semaphore:
            _release_slot(prepared.meter if prepared else None, consumed=consumed, lease=lease)
        elif lease is not None:
            lease.release_in_background(AsyncSessionLocal)



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

    # ASSIGNED BEFORE THE CAPACITY GATE, not after. The queue ticket and the reservation must carry
    # the SAME id: that is the only thing tying "this request waited 40s" to "this request was
    # charged 12 credits", and a queue ticket with an id nothing else uses answers no question.

    # ── Capacity ─────────────────────────────────────────────────────────────
    #
    # TWO LIMITS, ASKING DIFFERENT QUESTIONS. `_inference_semaphore` bounds concurrency in THIS
    # PROCESS -- on the HuggingFace path `model.generate()` runs in a thread and more than two at
    # once risks OOM here. The fleet-wide budget is `gpu_slots`, because the HPA runs two to four
    # replicas and a per-process count says nothing about what the backend is being asked to carry.
    #
    # A NON-STREAMING REQUEST IS NEVER QUEUED. It has no channel to say "you are third", and
    # `nginx.conf`'s 300s read timeout is a hard total for it rather than a gap between chunks, so
    # waiting spends a budget the caller cannot see. 429 with `Retry-After` is the honest answer;
    # the old 503 said the server was broken, which it is not.
    slot_lease = None
    if config.GPU_QUEUE_ENABLED:
        if not request.stream:
            async with AsyncSessionLocal() as _db:
                if await queue_service.slots_in_use(_db) >= await queue_service.capacity(_db):
                    raise HTTPException(
                        status_code=429,
                        detail="Every serving slot is busy. Please retry in a few seconds.",
                        headers={"Retry-After": "5"},
                    )
        else:
            # ASK FOR A SLOT WITHOUT WAITING, and branch on the answer. This is what keeps the
            # common case on the code path it has always been on.
            #
            # A slot is free almost every time. Those requests carry on exactly as before: prompt
            # preparation happens BEFORE any bytes are sent, so a 402 for insufficient credit is a
            # real 402 and the stage-A diagnosis still travels as a response header.
            #
            # When no slot is free the trade reverses. Reporting a queue position means sending
            # headers first, which means preparation and its refusals move inside the body. That is
            # a genuine loss -- a late 402 becomes an error event on a 200 -- and it is paid only
            # by requests that actually wait, in exchange for the learner seeing that they are third
            # in line rather than staring at a blank panel for two minutes.
            slot_lease = await queue_service.try_acquire_lease(
                AsyncSessionLocal, caller.user_id, request_id
            )
            if slot_lease is None:
                return StreamingResponse(
                    _queued_stream(request, caller, http_request, request_id),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        # Without this nginx buffers the response and the queue frames arrive in
                        # one lump when the answer does, which defeats the entire point.
                        "X-Accel-Buffering": "no",
                    },
                )
    else:
        # Unchanged behaviour while the switch is off: fast feedback rather than silent queuing.
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


    # The clock starts HERE, after acquire() returned, so a request never pays for the time it
    # spent waiting for a slot. Queue wait is a throughput problem, not a learner's cost.
    # Preparation, which is where the hold is taken and the prompt is built. Extracted so the
    # queued path can run the identical steps from inside its generator -- see
    # `_prepare_for_generation`, which owns the meter it creates and voids it if it throws.
    try:
        prepared = await _prepare_for_generation(request, caller, request_id)
    except HTTPException:
        # The hold, if there was one, has already been voided by the helper. This releases what the
        # endpoint owns: the permit and the fleet slot.
        _release_slot(None, consumed=False, lease=slot_lease)
        raise

    meter = prepared.meter
    messages = prepared.messages
    detected_mode = prepared.detected_mode
    latest_user_message = prepared.latest_user_message
    # `located_issues` and `user_messages` are deliberately not unpacked: both moved into
    # `_prepare_for_generation` and `_stream_for` with the code that used them, and the
    # non-streaming path below never needed either.

    # Handle streaming
    if request.stream:
        # One return for all three backends. `_stream_for` picks the generator and the headers;
        # `_semaphore_wrapped` puts the single `finally` around it that releases the permit, the
        # fleet slot and the meter together.
        inner, stream_headers = _stream_for(request, request_id, prepared)
        _semaphore_held_by_wrapper = True
        return StreamingResponse(
            _semaphore_wrapped(inner, meter, slot_lease),
            media_type="text/event-stream",
            headers=stream_headers,
        )

    # Non-streaming
    # vLLM mode only supports streaming (USE_VLLM=true). If the client sends
    # stream=false while vLLM is active, return a clear error rather than
    # crashing on model.device (model=None in the vLLM path).
    if USE_VLLM:
        # Not using _semaphore_wrapped; release manually. Nothing reached the model, so the hold
        # is voided rather than settled.
        _release_slot(meter, consumed=False, lease=slot_lease)
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
            completion = await _backend_client().chat.completions.create(
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

            # The same guard as the streaming path, and it has to be here too: this endpoint
            # is what the evaluation suite and any script calls, so a guard that only covered
            # the browser would leave the answer reachable by anything holding a token.
            # Whole-text here rather than the streaming gate, because there is no stream to
            # hold -- which also catches an UNFENCED handover that the gate cannot see.
            _protected = withholding.protected_functions(latest_user_message)
            if _protected and config.WITHHOLD_SOLUTIONS:
                _gate = withholding.SolutionGate(_protected)
                response_text = _gate.feed(response_text) + _gate.flush()
                _unfenced = withholding.completed_outside_a_fence(response_text, _protected)
                if _unfenced is not None:
                    # A finished function written as plain prose, with no fence for the gate
                    # to hold. Rare, and the whole reply goes rather than trying to excise it:
                    # a partially-redacted explanation reads as a bug and teaches nothing.
                    _gate.withheld.append(_unfenced)
                    response_text = withholding.REDACTION.strip()
                if _gate.withheld:
                    logger.warning(
                        "[%s] withheld a complete %s from a %s reply",
                        request_id, ", ".join(_gate.withheld), detected_mode,
                    )
                    metrics._bump(metrics.solutions_withheld, {"mode": detected_mode})
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
            _release_slot(meter, consumed=True, lease=slot_lease)

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
            _release_slot(meter, consumed=True, lease=slot_lease)


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
