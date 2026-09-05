# The weights are here on this machine — but not in git

**The AWQ artifact exists and is verified.** `*.safetensors` is gitignored (5.16 GiB does not belong
in a git repo, and there is no LFS remote), so a fresh clone of this repository gets this marker and
nothing else. On the machine that produced it, the real files sit beside this one.

Built and verified 2026-09-06 on a rented A40:

| | |
|---|---|
| Size | **5.16 GiB**, 2 shards (`model-0000{1,2}-of-00002.safetensors`) |
| Scheme | `compressed-tensors` / `pack-quantized`, **W4A16** |
| Quant config | `num_bits=4`, `int`, group strategy, `group_size=128`, `symmetric=True` |
| Excluded | `lm_head` (stays fp16 — standard) |
| Recipe | `GPTQModifier, targets [Linear], ignore [lm_head], scheme W4A16` |
| **int4-packed tensors** | **196** = 28 layers × 7 target modules (Qwen2.5-7B) |
| Reduction | **15.2 GB fp16 → 5.16 GiB, 2.9×** |

**Behavioural check, not just structural.** Loaded to **5.19 GiB on GPU** and generated correct text
("a convolution layer's stride determines the interval at which filters move across the input feature
map…"). A botched quantization loads fine and emits garbage; a tensor count cannot see that, so it
was asked a question.

The download from the pod was re-verified locally: same 2 shards, same 5.16 GiB, same **196** packed
tensors. Transfer intact.

Evidence: [`docs/rl/model-chain-evidence/`](../../../docs/rl/model-chain-evidence/).

## Regenerating it

Needs ~16 GB VRAM. The merge before it is CPU-only (`DEVICE_MAP="cpu"`) and wants ~30 GB RAM.

```bash
cd apps/api
python scripts/merge_lora.py      # adapter + base -> merged_model  (~15 GB download first run)
python scripts/quantize_awq.py    # merged_model  -> awq_model
```

**Version trap, fixed in both scripts but worth knowing:** `llmcompressor` 0.6.0.1 pins
`transformers` to 4.52.4, which accepts `torch_dtype=` and rejects `dtype=`; transformers 5.x is the
reverse. Both scripts now try the modern name and fall back. Getting it wrong fails *after* the 14 GB
base-model download — which is exactly why this directory sat empty for months.

**Also fixed:** `.gitignore` used to ignore this directory wholesale, so this explanation was itself
untracked. It now ignores the contents and keeps the marker.

## Serving

**vLLM serves this artifact** — demonstrated 2026-09-06: loaded natively as `compressed-tensors`
W4A16 (no conversion step) and generated **157.1 tok/s** across a 3-prompt batch, all answers
correct. The working stack is **vllm 0.11.0 + torch 2.8.0+cu128 + transformers<5**, and all three
pins matter: a bare `pip install vllm` takes torch cu130, which the CUDA-12.8 driver refuses, and
vllm 0.11.0 needs the transformers 4.x tokenizer API. See
[`docs/rl/model-chain-evidence/vllm_serving.md`](../../../docs/rl/model-chain-evidence/vllm_serving.md).
