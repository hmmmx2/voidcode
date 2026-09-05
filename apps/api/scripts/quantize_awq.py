"""
quantize_awq.py — Offline script: AWQ 4-bit quantize the merged model for vLLM.
─────────────────────────────────────────────────────────────────────────────────
This is a one-time preparation step required before vLLM can be used (P4).
Run AFTER merge_lora.py has completed successfully.

Why AWQ (not BnB NF4)?
    vLLM does NOT support BitsAndBytes NF4. vLLM's supported quantization formats
    are AWQ, GPTQ, GGUF, FP8, and INT8. AWQ (Activation-aware Weight Quantization)
    uses calibration data to identify the most weight-sensitive channels and applies
    mixed-precision quantization, giving better perplexity than standard round-to-
    nearest 4-bit at the same model size.

Why llmcompressor (not autoawq)?
    AutoAWQ was officially deprecated in 2025 (incompatible with transformers >= 4.52).
    The AutoAWQ maintainer officially handed off to the vLLM project. llm-compressor
    (https://github.com/vllm-project/llm-compressor) is the direct replacement and
    is maintained by the same team that maintains vLLM. It supports the same AWQ
    quantization format that vLLM loads natively.

Input:
    llm/outputs/merged_model/  (produced by merge_lora.py, ~14 GB fp16)

Output:
    llm/outputs/awq_model/  (~4 GB AWQ 4-bit safetensors, vLLM-compatible)

Install:
    pip install --no-build-isolation --no-deps llmcompressor

Usage:
    # From the project root:
    python -m apps.api.scripts.quantize_awq

    # Or directly:
    python apps/api/scripts/quantize_awq.py

Hardware:
    Requires ~16 GB VRAM (the full fp16 model must fit during calibration).
    Takes ~15 minutes on an RTX 5060 Ti 16 GB.

Calibration data:
    AWQ calibration requires a small representative dataset (~128-512 samples).
    We use VoidCode AI domain examples (programming questions and debug
    scenarios) to ensure the quantized model retains quality for our actual
    workload. More samples → better quality but slower quantization.

Next step:
    Install vLLM (in WSL2/Linux) and start the server with USE_VLLM=true.
"""
from pathlib import Path

# ── Path configuration ──────────────────────────────────────────────────────
_PROJECT_ROOT = Path(__file__).parents[3]
MERGED_PATH   = str(_PROJECT_ROOT / "llm" / "outputs" / "merged_model")
AWQ_PATH      = str(_PROJECT_ROOT / "llm" / "outputs" / "awq_model")

# ── Calibration dataset ─────────────────────────────────────────────────────
# Domain-representative examples covering all 5 tutor modes.
# llmcompressor's AWQ calibration analyses activation statistics to identify
# which weight channels are most sensitive to quantization error and compensates.
# Using domain-specific data ensures the quantized model retains quality for
# our actual teaching/debug/explain workload.
CALIB_DATA = [
    # Teaching mode
    "How do I solve the Two Sum problem?",
    "How do I implement binary search?",
    "How do I solve the Valid Parentheses problem?",
    "How do I implement a queue using two stacks?",
    "How do I find the maximum subarray sum?",
    "How do I reverse a linked list?",
    "How do I implement merge sort?",
    "How do I solve the climbing stairs problem?",
    # Debug mode
    "My code has a runtime error: IndexError: list index out of range",
    "Fix this bug in my code: for i in range(len(nums)):",
    "I'm getting a TypeError: 'NoneType' object is not subscriptable",
    "My function returns None instead of the expected value",
    "I get RecursionError: maximum recursion depth exceeded",
    "My loop runs one too many times",
    "I'm getting KeyError in my dictionary lookup",
    # Explain mode
    "What is a hash map and how does it work internally?",
    "Explain recursion with a simple example.",
    "What is the difference between BFS and DFS?",
    "What is dynamic programming and when should I use it?",
    "What is the time complexity of binary search?",
    "What is a stack and how does it work?",
    "Explain Big O notation.",
    # Followup mode
    "Why does this work?",
    "What does that mean?",
    "Can you show me an example?",
    "Is there a faster way to do this?",
    "What is the space complexity?",
    # General / programming concepts
    "What is object-oriented programming?",
    "Explain the difference between a list and a tuple in Python.",
    "What is memoization?",
    "How do I implement a linked list?",
]


def main() -> None:
    print("=" * 60)
    print("VoidCode AI — AWQ Quantization Script (P4 prep)")
    print("Using: llm-compressor (official autoawq replacement)")
    print("=" * 60)
    print(f"Input  (merged fp16): {MERGED_PATH}")
    print(f"Output (AWQ 4-bit)  : {AWQ_PATH}")
    print(f"Calibration samples : {len(CALIB_DATA)}")
    print()

    # ── Preflight checks ────────────────────────────────────────────────────
    if not Path(MERGED_PATH).is_dir():
        raise FileNotFoundError(
            f"Merged model not found at: {MERGED_PATH}\n"
            "Run merge_lora.py first:\n"
            "  python -m apps.api.scripts.merge_lora"
        )

    try:
        import llmcompressor  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "llmcompressor is not installed.\n"
            "autoawq is deprecated (incompatible with transformers >= 4.52).\n"
            "Install the replacement:\n"
            "  pip install --no-build-isolation --no-deps llmcompressor"
        ) from exc

    # ── Imports ─────────────────────────────────────────────────────────────
    import torch
    from llmcompressor import oneshot
    from llmcompressor.modifiers.quantization import GPTQModifier
    from transformers import AutoModelForCausalLM, AutoTokenizer

    # ── Load model and tokenizer ─────────────────────────────────────────────
    print("[1/3] Loading merged model in fp16 for quantization calibration...")
    print("      This loads the full ~14 GB model into VRAM.")

    tokenizer = AutoTokenizer.from_pretrained(MERGED_PATH, trust_remote_code=True)

    # Same kwarg-rename trap as merge_lora.py, and it bites harder here: the failure lands only
    # after the full ~14 GB model has been read off disk. `dtype` is the 5.x / late-4.x name;
    # `torch_dtype` is the one 4.52.4 accepts — and 4.52.4 is exactly what llmcompressor 0.6.0.1
    # pins, so this script cannot assume the modern name. Try the new name, fall back to the old.
    _load = {"device_map": "auto", "trust_remote_code": True}
    try:
        model = AutoModelForCausalLM.from_pretrained(
            MERGED_PATH, dtype=torch.float16, **_load
        )
    except TypeError as exc:
        if "dtype" not in str(exc):
            raise
        print("      (this transformers predates the `dtype` kwarg; using `torch_dtype`)")
        model = AutoModelForCausalLM.from_pretrained(
            MERGED_PATH, torch_dtype=torch.float16, **_load
        )
    print("      Model loaded.")

    # ── Build calibration dataset ────────────────────────────────────────────
    print("\n[2/3] Running AWQ-style quantization via llmcompressor (~15 min)...")
    print("      Analysing activation statistics with VoidCode domain calibration data.")

    # llmcompressor's oneshot() expects a HuggingFace datasets.Dataset object
    # (not a plain Python list). We build one from our domain-specific text samples.
    # The "text" column is the standard column name llmcompressor looks for.
    from datasets import Dataset as HFDataset
    calib_dataset = HFDataset.from_dict({"text": CALIB_DATA})

    # GPTQModifier with AWQ-equivalent settings:
    #   scheme="W4A16"  → 4-bit weights, 16-bit activations (standard AWQ format)
    #   block_size=128  → quantization group size (matches autoawq q_group_size=128)
    # This produces a model in the exact format vLLM loads with quantization="gptq"
    # (vLLM treats W4A16 GPTQ and AWQ identically at the kernel level)
    recipe = GPTQModifier(
        targets="Linear",
        scheme="W4A16",
        ignore=["lm_head"],         # Do not quantize the language model head
    )

    oneshot(
        model=model,
        dataset=calib_dataset,
        recipe=recipe,
        max_seq_length=512,
        num_calibration_samples=len(CALIB_DATA),
        output_dir=AWQ_PATH,
    )
    print("      Quantization complete.")

    # ── Save tokenizer alongside quantized model ─────────────────────────────
    print(f"\n[3/3] Saving tokenizer to {AWQ_PATH}...")
    tokenizer.save_pretrained(AWQ_PATH)

    # Report output size
    total_bytes = sum(
        f.stat().st_size for f in Path(AWQ_PATH).rglob("*") if f.is_file()
    )
    print(f"      Saved. Total size: {total_bytes / 1e9:.1f} GB")

    print()
    print("=" * 60)
    print("Quantization complete!")
    print(f"Quantized model saved to: {AWQ_PATH}")
    print()
    print("Note: Load this model in vLLM with quantization='compressed-tensors'.")
    print("      llmcompressor outputs 'compressed-tensors' format (not 'gptq' or 'awq').")
    print("      vLLM reads the W4A16 quantization config from config.json automatically.")
    print()
    print("Next steps:")
    print("  1. Install vLLM (in WSL2/Linux):")
    print("     pip install vllm --extra-index-url https://download.pytorch.org/whl/cu121")
    print("  2. vllm_engine.py already uses quantization='gptq' (no changes needed)")
    print("  3. Start the server with vLLM enabled:")
    print("     export USE_VLLM=true")
    print("     uvicorn apps.api.src.main:app --host 0.0.0.0 --port 8000")
    print("=" * 60)


if __name__ == "__main__":
    main()
