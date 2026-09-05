# vLLM serves the AWQ model — 2026-09-06, A40 (Secure, CA-MTL-1)

The last link of merge → quantize → **serve**. Raw log: `vllm_serving.log`.

```
vllm loaded in 133.7s
generated 91 tokens over 3 prompts in 0.58s (157.1 tok/s)
VERDICT: VLLM SERVES THE AWQ MODEL
VLLM_EXIT=0
```

Outputs (greedy, `temperature=0.0`, `max_tokens=64`), all three correct:

1. *"A convolution layer's stride determines the sampling interval (step size) at which a filter moves across the input feature map to produce the output."*
2. *"Padding is used in convolutional layers to maintain spatial dimensions of the output and to control for feature map size reduction."*
3. *"A LoRA (Low-Rank Adaptation) adapter is a technique for fine-tuning large language models with minimal parameters by learning low-rank updates to the model's weight matrices."*

## Stack that works — three pins, each one earned

| | |
|---|---|
| vllm | **0.11.0** |
| torch | **2.8.0+cu128** |
| transformers | **<5** |
| model | `compressed-tensors` / `pack-quantized` W4A16, loaded natively (no conversion) |

**Every one of those pins is load-bearing, and each was found by failing:**

1. A bare `pip install vllm` took **0.28.0**, which pulls **torch 2.13.0+cu130**. This pod's driver
   reports CUDA **12080** (12.8), so EngineCore died with *"The NVIDIA driver on your system is too
   old"*. **cu128 is the ceiling here.**
2. Installing a cu128 torch first and pinning it in a **constraints file** forced pip to backtrack
   from 0.28.0 to **0.11.0**, which accepts torch 2.8.0. A plain version guess would not have found
   that; constraints bind the resolver, a bare pin does not.
3. That still failed: `AttributeError: Qwen2Tokenizer has no attribute all_special_tokens_extended`.
   vllm 0.11.0 uses the **transformers 4.x** tokenizer API, and the constraint said nothing about
   transformers, so the resolver installed **5.16.1**. Pinning `transformers<5` fixed it.

## On the 157.1 tok/s

Real and measured, but **read the conditions before quoting it**: 3 prompts in one batch, 64
max tokens, greedy, after a warm load, with CUDA graphs captured. It is a small-batch latency-shaped
figure, **not** a sustained throughput benchmark, and `FlashInfer` was absent (vLLM fell back to
PyTorch-native top-p/top-k sampling), so a tuned deployment would differ.

What it *does* establish beyond doubt is the comparison: the same artifact ran at **2.4 tok/s**
through `transformers` eager execution, where int4 weights are unpacked to fp16 on every forward.
**65× is the cost of having no fused int4 kernel** — which is the entire reason to serve through
vLLM rather than transformers.
