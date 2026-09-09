/**
 * What this curriculum teaches, and what has to come first.
 *
 * Before this, content carried flat tags: `Problem.categories` was free-form strings and
 * `Question.domain` was one of six labels. Both are facets for filtering, and neither says
 * anything about order — so "what should I do next" was `dashboard.ts` picking the first unsolved
 * item in array order, which is the entire recommender the app had.
 *
 * **The prerequisite edges are the point, not the concept names.** A list of topics is a tag
 * rename. Edges are what let the app say "you have not done X, and Y needs it" — and that
 * sentence is the whole difference between a curriculum and a pile of problems.
 *
 * ## What is deliberately not here
 *
 * **No difficulty, no time estimate, no mastery threshold.** Those are properties of a learner
 * meeting a concept, not of the concept, and inventing numbers for them here would put a
 * fabricated scale into the one file everything downstream trusts.
 *
 * **No concept without content, except where marked.** `teaches` lists the items that actually
 * exercise a concept. A concept with an empty `teaches` is a hole — a thing the taxonomy claims
 * to cover and cannot — and `taxonomy.ts` reports those rather than letting them look covered.
 * They are kept rather than deleted because the hole is the argument for the next authoring
 * batch; deleting them would make the curriculum look complete by forgetting what is missing.
 *
 * ## Mapped from the concept side
 *
 * `teaches` points at content ids rather than each problem naming its concepts. Two reasons: the
 * content files are large authored literals where adding a field to 52 entries is a wide diff for
 * no behavioural gain, and the query D5 actually needs — "which items teach this concept" — is
 * this direction. `taxonomy.ts` validates both ways, so a rename on either side fails loudly.
 */

export const CONCEPT_CATEGORIES = {
  foundations: "Foundations",
  "classical-ml": "Classical ML",
  "deep-learning": "Deep Learning",
  transformers: "Transformers and LLMs",
  "vision-language": "Vision and Multimodal",
  "gpu-systems": "GPU and Systems",
} as const;

export type ConceptCategory = keyof typeof CONCEPT_CATEGORIES;

export interface Concept {
  id: string;
  name: string;
  category: ConceptCategory;
  /** One line: what it is, in the words an interviewer would use. */
  summary: string;
  /** Concept ids that must come first. Empty only for genuine roots. */
  prerequisites: string[];
  /**
   * Content ids that exercise this concept — curriculum problem ids and interview question
   * slugs alike, since both are things a learner does.
   *
   * Empty means a known hole. See the header.
   */
  teaches: string[];
}

export const CONCEPTS: readonly Concept[] = [
  // ── Foundations ────────────────────────────────────────────────────────────────────────
  {
    id: "tensor-shapes",
    name: "Tensor Shapes and Broadcasting",
    category: "foundations",
    summary: "How shapes align, when they stretch, and when they refuse.",
    prerequisites: [],
    teaches: ["broadcast-shapes"],
  },
  {
    id: "floating-point",
    name: "Floating Point",
    category: "foundations",
    summary: "Finite precision: representable range, and where a value silently becomes zero.",
    prerequisites: [],
    // `fp16-update-underflow` is co-taught with `mixed-precision`, which left this root
    // undemonstrable until unrelated work was done — the shape `gatedConcepts()` reports.
    // `ulp-and-absorption` teaches only floating point.
    teaches: ["fp16-update-underflow", "ulp-and-absorption"],
  },
  {
    id: "numerical-stability",
    name: "Numerical Stability",
    category: "foundations",
    summary: "Rewriting an expression so it survives the exponentials and the tiny logs.",
    prerequisites: ["floating-point"],
    teaches: ["stable-softmax", "logsumexp-stability"],
  },
  {
    id: "probability-basics",
    name: "Probability and Expectation",
    category: "foundations",
    summary: "Distributions, expectation, and what a probability has to sum to.",
    prerequisites: [],
    // A standalone item, deliberately. `expectation-of-dropout` is co-taught with
    // `regularisation`, so this root could not be demonstrated until unrelated work was done —
    // the shape `gatedConcepts()` reports. This one teaches only probability.
    teaches: ["expectation-of-dropout", "weighted-distribution-moments"],
  },
  {
    id: "information-theory",
    name: "Entropy and Divergence",
    category: "foundations",
    summary: "Cross-entropy, KL, and why one of them is not a distance.",
    prerequisites: ["probability-basics", "numerical-stability"],
    teaches: ["kl-divergence-asymmetry", "cross-entropy-loss"],
  },
  {
    id: "linear-algebra",
    name: "Linear Algebra",
    category: "foundations",
    summary: "Matrix products, transposes, and the shapes that make them legal.",
    prerequisites: ["tensor-shapes"],
    teaches: ["matmul-chain-order"],
  },
  {
    id: "matrix-calculus",
    name: "Matrix Calculus",
    category: "foundations",
    summary: "Differentiating through matrix expressions without losing track of the shapes.",
    prerequisites: ["linear-algebra"],
    teaches: ["matrix-calculus-backprop"],
  },
  {
    id: "eigen-decomposition",
    name: "Eigenvalues and Curvature",
    category: "foundations",
    summary: "What the spectrum of a Hessian says about the surface you are descending.",
    prerequisites: ["linear-algebra"],
    teaches: ["eigenvalues-of-the-hessian"],
  },
  {
    id: "feature-scaling",
    name: "Feature Scaling",
    category: "foundations",
    summary: "Putting features on one scale, and what happens at the degenerate ends.",
    prerequisites: ["tensor-shapes"],
    teaches: ["min-max-scale"],
  },

  // ── Classical ML ───────────────────────────────────────────────────────────────────────
  {
    id: "logistic-regression",
    name: "Logistic Regression",
    category: "classical-ml",
    summary: "The linear model whose gradient every deep framework reduces to.",
    prerequisites: ["matrix-calculus", "information-theory"],
    teaches: ["derive-logistic-gradient"],
  },
  {
    id: "classification-metrics",
    name: "Confusion Matrix Metrics",
    category: "classical-ml",
    summary: "Precision, recall, and which one a confusion matrix will not give you.",
    prerequisites: ["probability-basics"],
    teaches: ["compute-metrics-from-confusion"],
  },
  {
    id: "ranking-metrics",
    name: "Ranking Metrics and AUC",
    category: "classical-ml",
    summary: "AUC as a rank statistic, which is how you compute it without an ROC curve.",
    prerequisites: ["classification-metrics"],
    teaches: ["implement-auc"],
  },
  {
    id: "decision-thresholds",
    name: "Decision Thresholds",
    category: "classical-ml",
    summary: "Choosing the cut point that minimises the cost you actually care about.",
    prerequisites: ["classification-metrics", "probability-basics"],
    teaches: ["bayes-optimal-threshold"],
  },
  {
    id: "class-imbalance",
    name: "Class Imbalance",
    category: "classical-ml",
    summary: "What resampling does to your predicted odds, and how to undo it.",
    prerequisites: ["decision-thresholds"],
    teaches: ["resampling-odds-correction"],
  },
  {
    id: "data-splitting",
    name: "Train and Test Splits",
    category: "classical-ml",
    summary: "Splitting so the held-out set answers the question you are asking.",
    prerequisites: ["probability-basics"],
    teaches: ["implement-stratified-split"],
  },
  {
    id: "bias-variance",
    name: "Bias and Variance",
    category: "classical-ml",
    summary: "Decomposing error into the part you can train away and the part you cannot.",
    prerequisites: ["data-splitting", "probability-basics"],
    teaches: ["bias-variance-decomposition"],
  },

  // ── Deep learning ──────────────────────────────────────────────────────────────────────
  {
    id: "activations",
    name: "Activation Functions",
    category: "deep-learning",
    summary: "Nonlinearities, their saturation, and where they cost you a gradient.",
    prerequisites: ["numerical-stability"],
    teaches: ["sigmoid"],
  },
  {
    id: "loss-functions",
    name: "Loss Functions",
    category: "deep-learning",
    summary: "What a loss assumes about the output distribution it is scoring.",
    prerequisites: ["information-theory", "activations"],
    teaches: ["why-cross-entropy-not-mse"],
  },
  {
    id: "backpropagation",
    name: "Backpropagation",
    category: "deep-learning",
    summary: "The chain rule as an algorithm, and the shapes it has to preserve.",
    prerequisites: ["matrix-calculus", "loss-functions"],
    teaches: ["reverse-mode-fan-out"],
  },
  {
    id: "normalisation-layers",
    name: "Normalisation Layers",
    category: "deep-learning",
    summary: "LayerNorm and BatchNorm: what is normalised over, and what changes at inference.",
    prerequisites: ["feature-scaling", "backpropagation"],
    // `derive-layernorm-backward` asks a learner to derive it on a whiteboard;
    // `layer-norm-backward` makes them implement it and grades the term everyone drops.
    teaches: [
      "layer-norm",
      "batchnorm-inference",
      "derive-layernorm-backward",
      "layer-norm-backward",
    ],
  },
  {
    id: "residual-connections",
    name: "Residual Connections",
    category: "deep-learning",
    summary: "Why an identity path changes the Jacobian, and what that buys at depth.",
    prerequisites: ["backpropagation"],
    teaches: ["residual-jacobian"],
  },
  {
    id: "optimizers-sgd",
    name: "SGD and Momentum",
    category: "deep-learning",
    summary: "The update rule, and where weight decay actually enters it.",
    prerequisites: ["backpropagation"],
    teaches: ["sgd-momentum-step"],
  },
  {
    id: "optimizers-adam",
    name: "Adam and Adaptive Methods",
    category: "deep-learning",
    summary: "Moment estimates, bias correction, and why the first steps are unstable.",
    prerequisites: ["optimizers-sgd"],
    teaches: ["implement-adam-update", "warmup-adam-variance"],
  },
  {
    id: "gradient-clipping",
    name: "Gradient Clipping",
    category: "deep-learning",
    summary: "Rescaling by global norm, which is not the same as clipping each element.",
    prerequisites: ["optimizers-sgd"],
    teaches: ["implement-grad-clip"],
  },
  {
    id: "regularisation",
    name: "Regularisation",
    category: "deep-learning",
    summary: "Dropout and weight decay, and what they do to the expected activation.",
    prerequisites: ["probability-basics", "optimizers-sgd"],
    teaches: ["expectation-of-dropout"],
  },
  {
    id: "mixed-precision",
    name: "Mixed Precision Training",
    category: "deep-learning",
    summary: "Half precision, loss scaling, and the update that rounds to nothing.",
    prerequisites: ["floating-point", "optimizers-adam"],
    teaches: ["fp16-update-underflow"],
  },
  {
    id: "parameter-counting",
    name: "Parameter Counting",
    category: "deep-learning",
    summary: "Counting a model's weights from its dimensions, exactly, including the biases.",
    prerequisites: ["linear-algebra"],
    teaches: ["count-transformer-params"],
  },
  {
    id: "activation-memory",
    name: "Activation Memory",
    category: "deep-learning",
    summary: "What training holds in memory besides the weights, and how it scales.",
    prerequisites: ["parameter-counting", "backpropagation"],
    teaches: ["activation-memory-budget"],
  },

  // ── Transformers and LLMs ──────────────────────────────────────────────────────────────
  {
    id: "attention",
    name: "Scaled Dot-Product Attention",
    category: "transformers",
    summary: "Queries against keys, and the scale factor that keeps the softmax alive.",
    prerequisites: ["linear-algebra", "numerical-stability"],
    teaches: ["scaled-dot-product-attention", "why-scale-by-sqrt-dk"],
  },
  {
    id: "causal-masking",
    name: "Causal Masking",
    category: "transformers",
    summary: "Forbidding the future, including in the rectangular case decoding produces.",
    prerequisites: ["attention"],
    teaches: ["implement-causal-mask"],
  },
  {
    id: "positional-encoding",
    name: "Positional Encoding",
    category: "transformers",
    summary: "How position enters attention, and what makes RoPE relative.",
    prerequisites: ["attention"],
    teaches: ["derive-rope-relative"],
  },
  {
    id: "tokenization",
    name: "Tokenization",
    category: "transformers",
    summary: "Sub-word merges, the tie-break rule, and the off-by-one that ruins them.",
    prerequisites: [],
    teaches: ["bpe-merge"],
  },
  {
    id: "sampling",
    name: "Sampling and Decoding",
    category: "transformers",
    summary: "Temperature, top-k and nucleus, and where the cumulative boundary lands.",
    prerequisites: ["probability-basics", "numerical-stability"],
    teaches: ["top-p-sampling"],
  },
  {
    id: "perplexity",
    name: "Perplexity and Loss",
    category: "transformers",
    summary: "Two bases and two normalisers, and how swapping either looks plausible.",
    prerequisites: ["information-theory", "tokenization"],
    teaches: ["perplexity-and-loss"],
  },
  {
    id: "kv-cache",
    name: "KV Cache",
    category: "transformers",
    summary: "What decoding stores per token, and what it costs at a given context length.",
    prerequisites: ["attention", "parameter-counting"],
    teaches: ["kv-cache-memory"],
  },
  {
    id: "transformer-scaling",
    name: "Attention and FFN Cost",
    category: "transformers",
    summary: "Where quadratic attention overtakes the feed-forward block.",
    prerequisites: ["attention", "parameter-counting"],
    teaches: ["attention-vs-ffn-crossover"],
  },
  {
    id: "inference-throughput",
    name: "Decode Throughput",
    category: "transformers",
    summary: "Tokens per second from memory bandwidth, not from FLOPs.",
    prerequisites: ["kv-cache", "roofline"],
    teaches: ["decode-throughput-arithmetic"],
  },

  // ── Vision and multimodal ──────────────────────────────────────────────────────────────
  {
    id: "vision-transformer",
    name: "Vision Transformers",
    category: "vision-language",
    summary: "Images as token sequences, and how the patch grid sets the budget.",
    prerequisites: ["attention"],
    teaches: ["vit-token-budget"],
  },
  {
    id: "patch-embedding",
    name: "Patch Embedding",
    category: "vision-language",
    summary: "The convolution that turns pixels into tokens, and what it costs.",
    prerequisites: ["vision-transformer", "parameter-counting"],
    teaches: ["patch-embedding-cost"],
  },
  {
    id: "positional-interpolation",
    name: "Positional Interpolation",
    category: "vision-language",
    summary: "Resizing a learned position grid when the input resolution changes.",
    prerequisites: ["positional-encoding", "vision-transformer"],
    teaches: ["interpolate-pos-embed"],
  },
  {
    id: "contrastive-learning",
    name: "Contrastive Objectives",
    category: "vision-language",
    summary: "InfoNCE, its temperature, and what the negatives are doing.",
    prerequisites: ["information-theory", "numerical-stability"],
    teaches: ["derive-infonce"],
  },
  {
    id: "modality-alignment",
    name: "Modality Alignment",
    category: "vision-language",
    summary: "The gap between two encoders' spaces, and which transforms do not close it.",
    prerequisites: ["contrastive-learning"],
    teaches: ["modality-gap-invariance"],
  },
  {
    id: "object-detection",
    name: "Detection and NMS",
    category: "vision-language",
    summary: "IoU, and the suppression order that decides which box survives.",
    prerequisites: ["tensor-shapes"],
    teaches: ["iou-nms"],
  },

  // ── GPU and systems ────────────────────────────────────────────────────────────────────
  {
    id: "gpu-execution-model",
    name: "GPU Execution Model",
    category: "gpu-systems",
    summary: "Grids, blocks, warps, and the bounds check every kernel needs.",
    prerequisites: [],
    teaches: ["thread-index-mapping"],
  },
  {
    id: "parallel-reduction",
    name: "Parallel Reduction",
    category: "gpu-systems",
    summary: "The tree that turns an array into a scalar, and the ragged last step.",
    prerequisites: ["gpu-execution-model"],
    teaches: ["parallel-reduction"],
  },
  {
    id: "warp-primitives",
    name: "Warp-Level Primitives",
    category: "gpu-systems",
    summary: "Shuffles within a warp, which is a reduction with no shared memory at all.",
    prerequisites: ["parallel-reduction"],
    teaches: ["implement-warp-reduction"],
  },
  {
    id: "memory-coalescing",
    name: "Memory Coalescing",
    category: "gpu-systems",
    summary: "How an access pattern becomes transactions, and what strides cost.",
    prerequisites: ["gpu-execution-model"],
    teaches: ["coalescing-transaction-count"],
  },
  {
    id: "occupancy",
    name: "Occupancy",
    category: "gpu-systems",
    summary: "Registers and shared memory as the budget that caps resident warps.",
    prerequisites: ["gpu-execution-model"],
    teaches: ["occupancy-from-resources"],
  },
  {
    id: "roofline",
    name: "Roofline and Arithmetic Intensity",
    category: "gpu-systems",
    summary: "FLOPs per byte, and which side of the ridge a kernel sits on.",
    prerequisites: ["memory-coalescing"],
    teaches: ["arithmetic-intensity-roofline"],
  },
  {
    id: "pipeline-parallelism",
    name: "Pipeline Parallelism",
    category: "gpu-systems",
    summary: "Splitting a model across devices, and the bubble that costs you.",
    prerequisites: ["activation-memory"],
    teaches: ["pipeline-bubble-fraction"],
  },
  {
    id: "quantization",
    name: "Quantization",
    category: "gpu-systems",
    summary: "Lower-precision weights: what is lost, and where the error shows up.",
    prerequisites: ["floating-point", "mixed-precision"],
    teaches: ["int8-scale-and-zero-point"],
  },
  {
    id: "kernel-fusion",
    name: "Kernel Fusion",
    category: "gpu-systems",
    summary: "Merging passes to stop paying for the same memory traffic twice.",
    prerequisites: ["roofline"],
    // Online softmax is the canonical instance: the score row is never materialised, which is
    // what lets attention stay in SRAM. `fusion-memory-traffic` argues it; this one is it.
    teaches: ["fusion-memory-traffic", "online-softmax"],
  },
];
