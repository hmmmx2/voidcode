"""
vllm_engine.py — vLLM Inference Engine for VoidCode AI v5.3
─────────────────────────────────────────────────────────────────────────────────
Replaces HuggingFace model.generate() with vLLM AsyncLLMEngine when
the USE_VLLM=true environment variable is set.

Architecture:
    - W4A16 GPTQ-quantized MERGED model  (llm/outputs/awq_model/)
      The merge_lora.py script merged the LoRA adapter into the base weights
      (merge_and_unload), then quantize_awq.py quantized the merged result using
      llmcompressor (the official autoawq replacement maintained by the vLLM project).
      This means the fine-tuned Socratic teaching behaviour is BAKED INTO the AWQ model.
    - NO per-request LoRARequest injection — the adapter is already in the weights.
      All modes (TEACHING, DEBUG, FOLLOWUP, EXPLAIN, GENERAL) use the same model.
      Mode-specific behaviour is controlled entirely by the system prompt injected by
      main.py's prepare_messages_hybrid() via llm/scripts/prompts.py.

SSE Output Format:
    The generate_stream_vllm() function emits the IDENTICAL SSE event format
    as the existing generate_stream() in main.py. The frontend SSE reader
    (P1, VoidCodeAIPanel.tsx) consumes both without any code changes.

    Thinking event:  data: {"type":"thinking","content":"...","token_count":N,"budget_used":N,"budget_total":2000}
    Usage event:     data: {"type":"usage","usage":{"prompt_tokens":N,"completion_tokens":N,"total_tokens":N}}
    Delta chunk:     data: {"id":"...","created":N,"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
    Terminal:        data: [DONE]

vLLM Specifics:
    - vLLM's AsyncLLMEngine.generate() yields RequestOutput objects containing
      the FULL text generated so far (not incremental deltas). We track the
      previously-sent length and emit only the new portion as delta chunks.
    - vLLM has no native Windows support. This module must run in WSL2/Linux.
    - Requires: pip install vllm>=0.4.0 (CUDA 12.1 wheel recommended)

Prerequisites:
    Run offline prep scripts first:
        python -m apps.api.scripts.merge_lora
        python -m apps.api.scripts.quantize_awq
"""
import asyncio
import json
import logging
import os as _os
import time
from collections.abc import AsyncGenerator
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Path / environment configuration ────────────────────────────────────────

_PROJECT_ROOT = Path(__file__).parents[3]

# MODEL_PATH env var — set by Docker Compose (e.g. MODEL_PATH=/models/awq_model).
# Falls back to the WSL2-native ext4 path for fast loading, then the project-
# relative path as a last resort.
# I/O note: reading 5.6 GB via /mnt/c/ 9P FS is ~30 MB/s; ext4 is ~1 GB/s.
# Docker users: mount the model volume and set MODEL_PATH=/models/awq_model.
_env_model_path = _os.getenv("MODEL_PATH")
if _env_model_path:
    AWQ_MODEL_PATH = _env_model_path
else:
    _LINUX_AWQ_PATH = Path.home() / "voidcode_models" / "awq_model"
    AWQ_MODEL_PATH = (
        str(_LINUX_AWQ_PATH)
        if _LINUX_AWQ_PATH.is_dir()
        else str(_PROJECT_ROOT / "llm" / "outputs" / "awq_model")
    )

# Engine tuning — all values overridable via environment variables so Docker /
# cloud deployments can tune without rebuilding the image.
GPU_MEMORY_UTIL = float(_os.getenv("GPU_MEMORY_UTILIZATION", "0.90"))
MAX_MODEL_LEN   = int(_os.getenv("MAX_MODEL_LEN", "8192"))
QUANTIZATION    = _os.getenv("VLLM_QUANTIZATION", "compressed-tensors")
VLLM_DTYPE      = _os.getenv("VLLM_DTYPE", "float16")

LORA_ADAPTER_PATH = str(_PROJECT_ROOT / "llm" / "outputs" / "final_model")

# Must match the THINKING_TOKEN_BUDGET constant in main.py
THINKING_TOKEN_BUDGET = 2000

# ── Module-level engine singleton ────────────────────────────────────────────
_engine = None   # type: Optional[object]  # vllm.AsyncLLMEngine


async def init_engine():
    """
    Initialise the vLLM AsyncLLMEngine singleton.

    Called once from main.py lifespan() when USE_VLLM=true.
    The engine is shared across all requests (thread-safe, async-safe).

    Engine configuration:
        quantization="compressed-tensors" — llmcompressor saves in "compressed-tensors"
                                            format; vLLM reads the W4A16 quantization
                                            config from config.json automatically
        dtype="float16"            — W4A16 GPTQ requires fp16 (not bfloat16)
        gpu_memory_utilization=0.9 — Leave 10% headroom for CUDA overhead
        max_model_len=8192         — Matches the tokenizer max_length in main.py
        enable_lora=True           — Allow per-request LoRA injection
        max_lora_rank=16           — Must match adapter_config.json r=16
        max_loras=1                — Only one adapter served at a time
        # enforce_eager not set    — gcc installed; CUDA graph capture active.
                                     # Triton JIT (Punica LoRA GEMM kernels) works.
    """
    global _engine

    # Check for WEIGHTS, not for the directory.
    #
    # This guard used to test `is_dir()` alone, which is the one case that
    # cannot happen usefully: the repo ships `awq_model/` containing the
    # tokenizer, config and a `model.safetensors.index.json` but no shards (see
    # `docs/DECISIONS.md` D-012 — the quantize run completed and the 5.55 GB of
    # weights were later deleted to reclaim disk). So the directory existed, the
    # guard passed, and vLLM failed much deeper on a missing shard with a
    # message that pointed at neither cause nor remedy.
    model_dir = Path(AWQ_MODEL_PATH)
    if not model_dir.is_dir() or not any(model_dir.glob("*.safetensors")):
        detail = (
            "the directory does not exist"
            if not model_dir.is_dir()
            else "the directory exists but contains no *.safetensors shards "
                 "(config and tokenizer alone are not enough to serve)"
        )
        raise FileNotFoundError(
            f"AWQ model weights not usable at: {AWQ_MODEL_PATH} — {detail}.\n"
            "Run the offline prep scripts first:\n"
            "  python -m apps.api.scripts.merge_lora\n"
            "  python -m apps.api.scripts.quantize_awq"
        )

    try:
        from vllm import AsyncEngineArgs, AsyncLLMEngine
    except ImportError as exc:
        raise ImportError(
            "vLLM is not installed. Install it in WSL2/Linux:\n"
            "  pip install vllm --extra-index-url https://download.pytorch.org/whl/cu121"
        ) from exc

    logger.info(f"Initialising vLLM AsyncLLMEngine from {AWQ_MODEL_PATH}...")
    logger.info(f"LoRA adapter path: {LORA_ADAPTER_PATH}")

    engine_args = AsyncEngineArgs(
        model=AWQ_MODEL_PATH,
        quantization=QUANTIZATION,       # "compressed-tensors" (llmcompressor W4A16)
        dtype=VLLM_DTYPE,               # "float16" — required for W4A16 GPTQ
        gpu_memory_utilization=GPU_MEMORY_UTIL,  # Default 0.90 → ~14.4 GB on 16 GB GPU
        max_model_len=MAX_MODEL_LEN,    # Default 8192 — matches tokenizer truncation
        # enable_lora NOT set — the LoRA adapter was merged into the AWQ model weights
        # via merge_lora.py before quantization. The fine-tuned Socratic behaviour is
        # baked directly into the model weights. Runtime LoRARequest injection is
        # unnecessary and would double-apply the adapter (causing output degradation).
        trust_remote_code=True,
        # enforce_eager removed — gcc is installed; CUDA graph capture is active.
    )

    _engine = AsyncLLMEngine.from_engine_args(engine_args)
    logger.info("vLLM AsyncLLMEngine initialised successfully")
    # The en dash and multiplication sign are intended typography in a human-read log line.
    logger.info("5–8× speedup over HuggingFace model.generate() via PagedAttention")  # noqa: RUF001
    return _engine


def get_engine():
    """Return the engine singleton. Raises if init_engine() was not called."""
    if _engine is None:
        raise RuntimeError(
            "vLLM engine not initialised. "
            "Call init_engine() from lifespan() before handling requests."
        )
    return _engine


def _make_lora_request(mode: str):
    """
    Always returns None.

    The AWQ model was produced by merge_lora.py which merges the LoRA adapter
    weights directly into the base model weights (merge_and_unload), then
    quantize_awq.py quantizes the MERGED model. This means:

        AWQ model = Qwen2.5-7B-Instruct + LoRA(r=16) merged and quantized

    The fine-tuned behaviour for TEACHING/DEBUG/FOLLOWUP is already baked into
    the AWQ model's weights. Applying a LoRARequest on top would double-apply
    the adapter, causing catastrophic output degradation (repetition loops, etc).

    ALL modes use the same AWQ model weights — the system prompt injected by
    main.py's prepare_messages_hybrid() provides the mode-specific instruction.
    """
    return None  # LoRA already merged into AWQ model — do NOT inject again


async def generate_stream_vllm(
    prompt: str,
    mode: str,
    max_new_tokens: int,
    temperature: float,
    top_p: float,
    repetition_penalty: float,
    request_id: str,
) -> AsyncGenerator[str, None]:
    """
    Stream SSE events via vLLM AsyncLLMEngine.

    Output format is IDENTICAL to generate_stream() in main.py so the P1
    frontend SSE reader (VoidCodeAIPanel.tsx) works without modification.

    Key difference from HuggingFace TextIteratorStreamer:
        vLLM yields RequestOutput objects with the FULL generated text so far.
        We track the previously-sent character position and emit only the delta.

    Args:
        prompt:             Formatted prompt string (from tokenizer.apply_chat_template)
        mode:               Detected mode string ('teaching', 'debug', 'explain', etc.)
        max_new_tokens:     Maximum tokens to generate
        temperature:        Sampling temperature
        top_p:              Nucleus sampling probability
        repetition_penalty: Penalty for repeated tokens
        request_id:         Unique request ID for vLLM (also used as SSE event id)
    """
    try:
        from vllm import SamplingParams
    except ImportError:
        yield f"data: {json.dumps({'error': 'vLLM not installed'})}\n\n"
        return

    engine    = get_engine()
    lora_req  = _make_lora_request(mode)

    sampling = SamplingParams(
        max_tokens=max_new_tokens,
        temperature=max(temperature, 0.0),  # vLLM requires temperature >= 0
        top_p=top_p,
        repetition_penalty=repetition_penalty,
        skip_special_tokens=True,
    )

    created = int(time.time())

    # ── Streaming state ──────────────────────────────────────────────────────
    # vLLM yields cumulative text; we track position to emit incremental deltas.
    prev_text_len = 0

    # <think> tag stripping state — identical logic to generate_stream() in main.py
    content_buffer  = ""   # Accumulates text for think-tag scanning
    thinking_buffer = ""   # Accumulates content inside <think>...</think>
    inside_think    = False
    think_done      = False
    thinking_sent   = False
    all_content     = []   # All emitted content tokens for usage reporting

    try:
        async for req_output in engine.generate(
            prompt=prompt,
            sampling_params=sampling,
            request_id=request_id,
            lora_request=lora_req,
        ):
            # vLLM gives us the full text so far — extract the new delta
            full_text = req_output.outputs[0].text
            new_text  = full_text[prev_text_len:]
            prev_text_len = len(full_text)

            if not new_text:
                continue

            content_buffer += new_text
            all_content.append(new_text)

            # ── <think> tag stripping ────────────────────────────────────────
            # Identical state machine to generate_stream() in main.py lines 580–630.
            # Strips internal chain-of-thought reasoning from the visible output and
            # sends it as a separate "thinking" SSE event instead.
            if not think_done:
                if "<think>" in content_buffer and not inside_think:
                    inside_think = True
                    before_think = content_buffer.split("<think>")[0]
                    if before_think.strip():
                        yield _delta_event(request_id, created, before_think)
                        await asyncio.sleep(0)
                    content_buffer = "<think>" + content_buffer.split("<think>", 1)[1]

                if inside_think:
                    thinking_buffer = content_buffer

                if inside_think and "</think>" in content_buffer:
                    inside_think = False
                    think_done   = True

                    # Extract thinking content (without the tags themselves)
                    think_content = content_buffer.split("<think>")[1].split("</think>")[0].strip()
                    thinking_buffer = think_content

                    # Emit thinking metadata event (mirrors main.py format)
                    if thinking_buffer and not thinking_sent:
                        # Word-count estimate for token count (no tokenizer available here)
                        est_tokens = len(thinking_buffer.split())
                        budget_pct = round(100 * est_tokens / THINKING_TOKEN_BUDGET, 1)
                        thinking_event = {
                            "type": "thinking",
                            "content": thinking_buffer,
                            "token_count": est_tokens,
                            "budget_used": budget_pct,
                            "budget_total": THINKING_TOKEN_BUDGET,
                        }
                        yield f"data: {json.dumps(thinking_event)}\n\n"
                        await asyncio.sleep(0)
                        thinking_sent = True

                    # Continue with text after </think>
                    content_buffer = content_buffer.split("</think>", 1)[1]

                # While inside <think>, do not emit delta chunks
                if inside_think:
                    continue

            # ── Emit delta chunk ─────────────────────────────────────────────
            if content_buffer and not ("<think>" in content_buffer and not think_done):
                yield _delta_event(request_id, created, content_buffer)
                await asyncio.sleep(0)
                content_buffer = ""

        # Flush any remaining buffer content after the stream ends
        if content_buffer and not inside_think:
            yield _delta_event(request_id, created, content_buffer)
            await asyncio.sleep(0)

        # ── Usage event ──────────────────────────────────────────────────────
        # Approximate token count using word count (tokenizer not available in
        # this module without adding a dependency). Replace with exact tokenizer
        # call if precision is required.
        full_response   = "".join(all_content)
        est_comp_tokens = len(full_response.split())
        usage_event = {
            "type": "usage",
            "usage": {
                "prompt_tokens": 0,          # Prompt tokens not tracked by vLLM here
                "completion_tokens": est_comp_tokens,
                "total_tokens": est_comp_tokens,
            },
        }
        yield f"data: {json.dumps(usage_event)}\n\n"
        await asyncio.sleep(0)

        # ── Final done event + terminator ─────────────────────────────────────
        final_chunk = {
            "id": request_id,
            "created": created,
            "choices": [{"delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(final_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    except Exception as exc:
        logger.error(f"vLLM streaming error [{request_id}]: {exc}")
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"


def _delta_event(request_id: str, created: int, content: str) -> str:
    """Format a content delta as a standard SSE data line."""
    payload = {
        "id": request_id,
        "created": created,
        "choices": [
            {
                "delta": {"content": content},
                "finish_reason": None,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n"
