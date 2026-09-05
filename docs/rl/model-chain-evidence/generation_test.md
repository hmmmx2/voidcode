# The AWQ model loads and generates — 2026-09-06, A40

Structural validity (196 int4-packed tensors) proves the file was *quantized*. Only generation
proves it still **works**: a botched quantization loads fine and emits garbage, and a tensor count
cannot see that. So the artifact was loaded on GPU and asked a question.

```
loaded in 41.3s, 5.19 GiB on GPU
generated 31 tokens in 13.0s (2.4 tok/s)
---OUTPUT---
A convolution layer's stride determines the interval at which filters move across the
input feature map to perform convolutions, controlling the spatial resolution of the output.
---END---
VERDICT: MODEL GENERATES COHERENT TEXT
```

**Memory:** 5.19 GiB resident against 15.2 GB for the fp16 merge — a **2.9× reduction**, consistent
with W4A16 over ~7.6B parameters with `lm_head` left in fp16.

**Answer quality:** correct and on-topic for the tutor's own domain. Greedy decoding
(`do_sample=False`), so it is reproducible.

## The throughput number is NOT a serving benchmark

**2.4 tok/s says nothing about vLLM.** This ran through plain `transformers` eager execution, where
`compressed-tensors` int4 has no fused dequant/GEMM kernel — every packed weight is unpacked to fp16
on the fly. That is the slowest possible way to run this artifact and it was chosen for *correctness
checking*, not speed.

Do not quote 2.4 tok/s anywhere. A real serving figure requires loading the model under vLLM, which
**has not been done** — see the README status table, where vLLM serving is still listed as not
demonstrated.
