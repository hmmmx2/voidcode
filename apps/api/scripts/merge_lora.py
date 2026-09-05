"""
merge_lora.py — Offline script: Merge LoRA adapter into Qwen2.5-7B base weights.
─────────────────────────────────────────────────────────────────────────────────
This is a one-time preparation step required before vLLM can be used (P4).

Why this is needed:
    vLLM does NOT support BitsAndBytes NF4 quantization. It uses its own AWQ/GPTQ
    quantization format. Before quantizing, we first need to merge the fine-tuned
    LoRA adapter (r=16, lora_alpha=32) into the base Qwen2.5-7B-Instruct weights to
    produce a single merged model in fp16 safetensors format.

Input:
    Base model: Qwen/Qwen2.5-7B-Instruct  (downloaded from HuggingFace on first run)
    LoRA adapter: llm/outputs/final_model/  (adapter_config.json + adapter_model.bin)

Output:
    llm/outputs/merged_model/  (~14 GB in fp16 safetensors format)

Usage:
    # From the project root:
    python -m apps.api.scripts.merge_lora

    # Or directly:
    python apps/api/scripts/merge_lora.py

Hardware:
    Option A — GPU: Requires ~16 GB VRAM. Set device_map="auto" below.
    Option B — CPU: Slower (~10 min), no VRAM requirement. Set device_map="cpu".

Next step:
    Run quantize_awq.py to convert the merged model to AWQ 4-bit for vLLM.
"""
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

# ── Path configuration ──────────────────────────────────────────────────────
_PROJECT_ROOT = Path(__file__).parents[3]
BASE_MODEL_ID = "Qwen/Qwen2.5-7B-Instruct"
ADAPTER_PATH  = str(_PROJECT_ROOT / "llm" / "outputs" / "final_model")
OUTPUT_PATH   = str(_PROJECT_ROOT / "llm" / "outputs" / "merged_model")

# ── Device selection ────────────────────────────────────────────────────────
# Always use CPU for the merge step.
#
# Why not "auto" (GPU)?
#   PeftModel.merge_and_unload() requires the ENTIRE model to be on a single
#   device. device_map="auto" splits layers across GPU+CPU when fp16 exceeds
#   available VRAM. accelerate's dispatch_model then requires an offload_dir
#   and cannot perform an in-place merge — it raises:
#       ValueError: We need an `offload_dir` to dispatch this model ...
#
# CPU merge is ~10 minutes and works unconditionally. VRAM is freed for
# quantize_awq.py (Step 2) which DOES need full VRAM.
DEVICE_MAP = "cpu"


def main() -> None:
    print("=" * 60)
    print("VoidCode AI — LoRA Merge Script (P4 prep)")
    print("=" * 60)
    print(f"Base model : {BASE_MODEL_ID}")
    print(f"Adapter    : {ADAPTER_PATH}")
    print(f"Output     : {OUTPUT_PATH}")
    print(f"Device map : {DEVICE_MAP}")
    print()

    # Verify adapter exists before starting the (slow) model download
    if not Path(ADAPTER_PATH).is_dir():
        raise FileNotFoundError(
            f"LoRA adapter not found at: {ADAPTER_PATH}\n"
            "Train the model first: python llm/scripts/train.py"
        )

    print("[1/4] Loading base model in fp16 (no BnB — full weights needed for merge)...")
    print("      This downloads ~14 GB from HuggingFace on first run.")

    # The fp16 kwarg was renamed, and this line previously hard-coded the NEW name with the
    # comment "transformers >=4.52 prefers `dtype` over `torch_dtype`". That is wrong: 4.52.4
    # raises `TypeError: Qwen2ForCausalLM.__init__() got an unexpected keyword argument 'dtype'`
    # — the alias landed later in the 4.x line. It cost a paid GPU session to find, because the
    # failure only appears AFTER the ~14 GB base-model download.
    #
    # Pinning either name breaks the other half of the version range, and the range is not
    # optional: llmcompressor 0.6.0.1 (needed by quantize_awq.py) pins transformers to 4.52.4,
    # while transformers 5.x removed `torch_dtype`.
    #
    # Signature inspection does not settle it — `from_pretrained` takes **kwargs, so the name is
    # absent from the signature either way. Just try the modern name and fall back. The retry is
    # cheap: the weights are in the HF cache by the time the TypeError is raised, so only the
    # (fast) instantiation repeats, not the download.
    _load = {"device_map": DEVICE_MAP, "trust_remote_code": True}
    try:
        model = AutoModelForCausalLM.from_pretrained(
            BASE_MODEL_ID, dtype=torch.float16, **_load
        )
    except TypeError as exc:
        if "dtype" not in str(exc):
            raise
        print("      (this transformers predates the `dtype` kwarg; using `torch_dtype`)")
        model = AutoModelForCausalLM.from_pretrained(
            BASE_MODEL_ID, torch_dtype=torch.float16, **_load
        )
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_ID, trust_remote_code=True)
    print(f"      Base model loaded ({sum(p.numel() for p in model.parameters()) / 1e9:.1f}B parameters)")

    print(f"\n[2/4] Loading LoRA adapter from {ADAPTER_PATH}...")
    model = PeftModel.from_pretrained(model, ADAPTER_PATH)
    lora_params = sum(p.numel() for n, p in model.named_parameters() if "lora_" in n)
    print(f"      LoRA parameters: {lora_params / 1e6:.1f}M")

    print("\n[3/4] Merging LoRA weights into base model (merge_and_unload)...")
    print("      This fuses the adapter weights permanently. The original adapter")
    print("      at llm/outputs/final_model/ is not modified.")
    model = model.merge_and_unload()  # Returns a plain AutoModelForCausalLM
    print("      Merge complete.")

    print(f"\n[4/4] Saving merged model to {OUTPUT_PATH}...")
    Path(OUTPUT_PATH).mkdir(parents=True, exist_ok=True)
    model.save_pretrained(OUTPUT_PATH, safe_serialization=True)
    tokenizer.save_pretrained(OUTPUT_PATH)

    # Report output size
    total_bytes = sum(f.stat().st_size for f in Path(OUTPUT_PATH).rglob("*") if f.is_file())
    print(f"      Saved. Total size: {total_bytes / 1e9:.1f} GB")

    print()
    print("=" * 60)
    print("Merge complete!")
    print(f"Merged model saved to: {OUTPUT_PATH}")
    print()
    print("Next step: Run quantize_awq.py to produce the AWQ 4-bit model for vLLM")
    print("  python -m apps.api.scripts.quantize_awq")
    print("=" * 60)


if __name__ == "__main__":
    main()
