# Empty here — but the chain is proven

This directory is empty of weights **by design**, not because the pipeline is broken. `*.safetensors`
is gitignored (a 5–15 GB artifact does not belong in git), and this repo has no LFS remote.

**The chain was run end to end on 2026-09-06** on a rented A40 and produced a real
`awq_model`: **5.16 GB across 2 shard(s)** — AWQ 4-bit W4A16 quantization.

Verified, not assumed:
- **196 int4-packed tensors** = 28 layers × 7 target modules for Qwen2.5-7B
- recipe `GPTQModifier, targets [Linear], ignore [lm_head], scheme W4A16`
- the quantized model **loads to 5.19 GiB on GPU and generates correct text**

Evidence: [`docs/rl/model-chain-evidence/`](../../../docs/rl/model-chain-evidence/).

## Reproducing it

Needs ~16 GB VRAM for the quantize; the merge is CPU-only (`DEVICE_MAP="cpu"`) and needs ~30 GB RAM.

```bash
cd apps/api
python scripts/merge_lora.py      # adapter + base -> merged_model  (~15 GB download first run)
python scripts/quantize_awq.py    # merged_model  -> awq_model
```

**Version trap, already fixed in both scripts but worth knowing:** `llmcompressor` 0.6.0.1 pins
`transformers` to 4.52.4, which accepts `torch_dtype=` and rejects `dtype=`; transformers 5.x is the
reverse. Both scripts now try the modern name and fall back. Getting this wrong fails *after* the
14 GB base-model download — which is what left these directories empty in the first place.

**Still not demonstrated:** loading this under **vLLM**. The artifact is structurally valid and
generates under `transformers`, but serving has not been shown. Do not claim it.
