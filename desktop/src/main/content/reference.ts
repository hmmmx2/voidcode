/**
 * What the tutor is allowed to state as fact.
 *
 * The tutor answers from model weights. That is fine for "explain the chain rule" and wrong for
 * anything that moved: attention variants, quantization schemes, occupancy rules and sampler
 * defaults all churn, and a model trained before a change will teach the old thing confidently.
 * **The learner cannot detect that** — someone preparing for an interview does not yet know
 * enough to catch it — so it lands in the interview instead.
 *
 * ## Every passage carries a date and a source, and that is the point
 *
 * Not decoration. A claim with no date cannot be found later and cannot be replaced: you would
 * have to re-derive whether it is still true from scratch. `asOf` says when the claim was checked
 * and `source` says against what, so a stale entry is a grep away rather than an archaeology
 * project. This is the whole reason the corpus exists rather than fine-tuning the facts in.
 *
 * ## What belongs here
 *
 * Durable technical facts with a citable origin — the definition in the paper, the arithmetic,
 * the rule. **Not** benchmark numbers, model release details, or anything phrased as "currently
 * the best", all of which are stale before they are committed and cannot be checked by anyone
 * reading this file.
 *
 * Sections are the unit because they are both the retrieval unit and the citation unit. "Attention
 * — the scale factor" is a thing a tutor can point at; a whole document is not.
 *
 * Concepts tie each document to `concepts.ts`, which `reference-search.ts` uses to prefer passages
 * about what the learner is actually doing. `validateReference` checks those ids against the
 * taxonomy, so a concept rename cannot quietly orphan a document.
 */

export interface ReferenceSection {
  /** Stable and citable. Appears in the tutor's answer, so it must not churn. */
  id: string;
  heading: string;
  body: string;
}

export interface ReferenceDoc {
  id: string;
  title: string;
  /** What the claim rests on — a paper, a spec, a vendor guide. Named so it can be checked. */
  source: string;
  /**
   * When the content was last checked against the source, ISO date.
   *
   * Of the *claim*, not of the file. A passage edited for wording keeps its date; a passage whose
   * fact was re-verified gets a new one. Getting this backwards would make every reformat look
   * like a fresh check.
   */
  asOf: string;
  /** Concept ids from `concepts.ts`. Validated, so a rename cannot orphan this silently. */
  concepts: string[];
  sections: ReferenceSection[];
}

export const REFERENCE: readonly ReferenceDoc[] = [
  {
    id: "attention",
    title: "Scaled Dot-Product Attention",
    source: "Vaswani et al., Attention Is All You Need (2017), §3.2.1",
    asOf: "2026-08-06",
    concepts: ["attention", "causal-masking"],
    sections: [
      {
        id: "attention-definition",
        heading: "The definition",
        body: "Attention(Q, K, V) = softmax(QKᵀ / √d_k) V. Q is (n_q × d_k), K is (n_k × d_k), V is (n_k × d_v). The product QKᵀ is (n_q × n_k) — one score per query-key pair — and the softmax is taken over the key axis, so each query's weights sum to one.",
      },
      {
        id: "attention-scaling",
        heading: "The scaling factor: why divide by √d_k",
        body: "If the components of q and k are independent with mean 0 and variance 1, their dot product has mean 0 and variance d_k. Without the scale, the logits grow with d_k, the softmax saturates, and the gradient through it vanishes. Dividing by √d_k — the scaling factor — returns the variance to 1 regardless of head width. The paper gives exactly this argument in a footnote to §3.2.1.",
      },
      {
        id: "attention-causal",
        heading: "Causal masking",
        body: "A decoder forbids attending to future positions by setting those logits to −∞ before the softmax, so their weights become exactly zero. During incremental decoding the score matrix is rectangular — one query row against all cached keys — and the mask must be built from absolute positions, not from the matrix shape. Assuming a square lower-triangular mask is the standard bug.",
      },
    ],
  },
  {
    id: "positional-encoding",
    title: "Positional Encoding and RoPE",
    source: "Su et al., RoFormer: Enhanced Transformer with Rotary Position Embedding (2021)",
    asOf: "2026-08-06",
    concepts: ["positional-encoding", "positional-interpolation"],
    sections: [
      {
        id: "rope-relative",
        heading: "Why RoPE is relative",
        body: "RoPE rotates each 2-dimensional pair of a query or key by an angle proportional to its absolute position. Because a rotation by mθ applied to q and by nθ applied to k leaves the inner product depending only on (m − n), the attention score is a function of relative distance even though the transform is applied absolutely. The pairing and the frequency schedule are both load-bearing: get either wrong and the score stops depending only on m − n, which is what shifting both positions by the same amount tests.",
      },
      {
        id: "positional-interpolation",
        heading: "Changing resolution",
        body: "A learned positional grid is tied to the sequence or patch layout it was trained on. Serving a different input resolution requires interpolating that grid rather than truncating or padding it — for a vision transformer, reshaping the position table to its 2-D grid and resampling it to the new grid. Truncation silently discards the positions the model learned for the far edge of the image.",
      },
    ],
  },
  {
    id: "sampling",
    title: "Sampling and Decoding",
    source: "Holtzman et al., The Curious Case of Neural Text Degeneration (2019)",
    asOf: "2026-08-06",
    concepts: ["sampling"],
    sections: [
      {
        id: "nucleus-sampling",
        heading: "Top-p (nucleus) sampling",
        body: "Sort tokens by probability descending and take the shortest prefix whose cumulative probability is at least p, then renormalise over that set. The boundary token — the one that takes the sum to or past p — is included, which is what makes the set never empty even when a single token exceeds p on its own. Excluding it is the common off-by-one and produces an empty candidate set for confident distributions.",
      },
      {
        id: "temperature",
        heading: "Temperature",
        body: "Temperature divides the logits before the softmax. Below 1 it sharpens the distribution, above 1 it flattens it, and at 0 the sampler degenerates to argmax — which must be special-cased rather than computed, since dividing by zero produces infinities rather than a peaked distribution.",
      },
    ],
  },
  {
    id: "normalisation",
    title: "Normalisation Layers",
    source: "Ba et al., Layer Normalization (2016); Ioffe & Szegedy, Batch Normalization (2015)",
    asOf: "2026-08-06",
    concepts: ["normalisation-layers"],
    sections: [
      {
        id: "layernorm-axis",
        heading: "What LayerNorm normalises over",
        body: "LayerNorm computes mean and variance across the feature axis of a single example, so it is independent of batch size and behaves identically at training and inference. BatchNorm computes them across the batch for each feature, which is why it needs running estimates and behaves differently once training stops.",
      },
      {
        id: "layernorm-epsilon",
        heading: "Where epsilon goes",
        body: "The epsilon is added to the variance before the square root, not to the standard deviation after it: (x − μ) / √(σ² + ε). Adding it afterwards changes the value for small variances and is a difference that only shows on near-constant inputs — which is exactly where a test should look.",
      },
      {
        id: "batchnorm-inference",
        heading: "BatchNorm at inference",
        body: "At inference BatchNorm uses the running mean and variance accumulated during training, not the statistics of the incoming batch. Using batch statistics at inference makes a prediction depend on what else happened to be in the batch, which is a correctness bug rather than a performance one.",
      },
    ],
  },
  {
    id: "numerical-stability",
    title: "Numerical Stability",
    source: "Goodfellow, Bengio & Courville, Deep Learning (2016), §4.1",
    asOf: "2026-08-06",
    concepts: ["numerical-stability", "perplexity"],
    sections: [
      {
        id: "stable-softmax",
        heading: "The softmax shift",
        body: "softmax(x) is invariant to subtracting a constant from every element, so subtracting max(x) before exponentiating removes the overflow without changing the result. Without it, a logit around 89 overflows float32's exp and the whole row becomes NaN. The shift costs one pass and is not optional at any realistic scale.",
      },
      {
        id: "logsumexp",
        heading: "log-sum-exp",
        body: "log Σ exp(xᵢ) = m + log Σ exp(xᵢ − m) where m = max(x). The identity is what lets a cross-entropy be computed from logits without ever materialising the probabilities, which is why frameworks expose a fused logits-to-loss op rather than a softmax followed by a log.",
      },
      {
        id: "perplexity-vs-loss",
        heading: "Perplexity, loss and bits per byte",
        body: "Perplexity exponentiates the per-token mean of the natural-log loss. Bits-per-byte divides the TOTAL negative log-likelihood by the number of bytes and converts to base 2. Two bases and two normalisers are in play, and swapping either produces a plausible-looking number — which is why they are reported separately rather than derived from one another at the call site.",
      },
    ],
  },
  {
    id: "kv-cache",
    title: "KV Cache and Decode Cost",
    source: "Pope et al., Efficiently Scaling Transformer Inference (2022)",
    asOf: "2026-08-06",
    concepts: ["kv-cache", "inference-throughput"],
    sections: [
      {
        id: "kv-cache-size",
        heading: "What the cache costs",
        body: "Per token, the cache holds a key and a value for every layer and every KV head: 2 × layers × kv_heads × head_dim × bytes_per_element. Multiply by sequence length and batch size for the total. Grouped-query attention reduces kv_heads below the number of query heads, and it is kv_heads that appears here — using the query head count overstates the cache, often by a large factor.",
      },
      {
        id: "decode-is-memory-bound",
        heading: "Decoding is memory-bound",
        body: "Generating one token reads the whole weight matrix to do a matrix-vector product, so single-stream decode throughput is set by memory bandwidth rather than by FLOPs: roughly bandwidth ÷ bytes-of-weights tokens per second. This is why batching raises throughput without raising per-token latency much, and why quantization speeds up decode — it moves fewer bytes.",
      },
    ],
  },
  {
    id: "gpu-execution",
    title: "GPU Execution and Occupancy",
    source: "NVIDIA CUDA C++ Programming Guide, chapters on the execution and memory models",
    asOf: "2026-08-06",
    concepts: ["gpu-execution-model", "occupancy", "memory-coalescing", "warp-primitives"],
    sections: [
      {
        id: "thread-indexing",
        heading: "Global index and the bounds check",
        body: "A thread's global index is blockIdx.x * blockDim.x + threadIdx.x. Grids are launched in whole blocks, so a problem size that is not a multiple of the block size leaves threads past the end — every kernel needs an explicit bounds check, and omitting it is an out-of-bounds write rather than a harmless no-op.",
      },
      {
        id: "coalescing",
        heading: "Coalescing",
        body: "Global memory is served in aligned transactions. When consecutive threads in a warp read consecutive addresses, their accesses coalesce into the minimum number of transactions; a stride multiplies that count, and a stride at least as large as the transaction size costs one transaction per thread. The count is a property of the access pattern, not of the total bytes moved.",
      },
      {
        id: "occupancy",
        heading: "Occupancy",
        body: "Occupancy is resident warps as a fraction of the maximum a streaming multiprocessor supports. Registers per thread and shared memory per block are budgets: whichever runs out first caps how many blocks are resident. Higher occupancy is not automatically faster — it buys latency hiding, and a kernel already bound by bandwidth gains nothing from it.",
      },
      {
        id: "warp-reduction",
        heading: "Warp-level reduction",
        body: "Threads within a warp can exchange registers directly with shuffle instructions, so a reduction within a warp needs no shared memory and no barrier. The standard form halves the offset each step — 16, 8, 4, 2, 1 — leaving the total in lane 0.",
      },
    ],
  },
  {
    id: "roofline",
    title: "Roofline and Arithmetic Intensity",
    source: "Williams, Waterman & Patterson, Roofline (2009)",
    asOf: "2026-08-06",
    concepts: ["roofline", "kernel-fusion"],
    sections: [
      {
        id: "arithmetic-intensity",
        heading: "Arithmetic intensity",
        body: "Arithmetic intensity is FLOPs performed per byte moved from memory. The ridge point is peak-compute ÷ peak-bandwidth: below it a kernel is memory-bound and its ceiling is bandwidth × intensity, above it the ceiling is peak compute. Which side a kernel sits on decides whether making the arithmetic cheaper will help at all.",
      },
      {
        id: "fusion",
        heading: "Why fusion helps",
        body: "Elementwise operations have very low arithmetic intensity, so running them as separate kernels pays the full memory round trip for each. Fusing them into one pass keeps the intermediate in registers and moves the bytes once, which is why frameworks fuse activation and normalisation chains rather than optimising the arithmetic inside them.",
      },
    ],
  },
  {
    id: "optimizers",
    title: "Adam and Mixed Precision",
    source: "Kingma & Ba, Adam (2014); Micikevicius et al., Mixed Precision Training (2017)",
    asOf: "2026-08-06",
    concepts: ["optimizers-adam", "mixed-precision", "gradient-clipping"],
    sections: [
      {
        id: "adam-bias-correction",
        heading: "Bias correction",
        body: "Adam's moment estimates start at zero, so early steps are biased towards zero. Dividing m by (1 − β₁ᵗ) and v by (1 − β₂ᵗ) corrects it. Without the correction the first updates are far too small — which is the same symptom a learning-rate warmup is often reaching for, and one reason the two are easy to confuse.",
      },
      {
        id: "fp16-underflow",
        heading: "FP16 update underflow",
        body: "In half precision the smallest normal magnitude is about 6e-5. An update smaller than roughly half an ULP of the weight it is added to rounds away entirely, so the weight never moves. This is why mixed-precision training keeps a master copy of the weights in fp32 and applies the update there, rather than trusting the half-precision addition.",
      },
      {
        id: "grad-clip-global",
        heading: "Clipping by global norm",
        body: "Clipping by global norm computes the norm across ALL parameters, then scales every gradient by the same factor if that norm exceeds the threshold. Clipping each tensor independently changes the update direction; clipping by global norm preserves it and only shortens the step.",
      },
    ],
  },
  {
    id: "tokenization",
    title: "Byte-Pair Encoding",
    source: "Sennrich, Haddow & Birch, Neural Machine Translation of Rare Words with Subword Units (2015)",
    asOf: "2026-08-06",
    concepts: ["tokenization"],
    sections: [
      {
        id: "bpe-merges",
        heading: "The merge loop",
        body: "BPE repeatedly counts adjacent symbol pairs and merges the most frequent one, recording the merge in an ordered list. At encode time merges are applied in that learned order, not by re-counting. Overlapping occurrences of the winning pair are consumed left to right, so 'aaaa' merging 'aa' yields two symbols rather than three — scanning without advancing past a consumed pair is the standard bug.",
      },
    ],
  },
];
