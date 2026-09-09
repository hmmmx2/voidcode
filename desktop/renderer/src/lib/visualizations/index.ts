import type { Visualization } from "./types";

/**
 * Step data per problem, keyed by slug.
 *
 * Every number here was taken from the problem's own test cases, so what the
 * learner watches is the case they are about to run. See `types.ts` for why the
 * values are pre-computed strings rather than arithmetic done at render time.
 */

const c = (value: string, state?: "idle" | "active" | "changed" | "muted", label?: string) => ({
  value,
  state,
  label,
});

export const VISUALIZATIONS: Record<string, Visualization> = {
  // ── ML / DL ───────────────────────────────────────────────────────────
  "stable-softmax": {
    kind: "vector",
    title: "Why subtracting the max matters",
    steps: [
      {
        caption: "Start with logits that a real model could produce.",
        detail: "A language model's logits routinely reach the hundreds.",
        rows: [{ title: "logits", cells: [c("1000"), c("1000"), c("1000")] }],
      },
      {
        caption: "The naive formula exponentiates them directly.",
        detail: "exp(1000) exceeds the largest representable float.",
        rows: [
          { title: "logits", cells: [c("1000"), c("1000"), c("1000")] },
          { title: "exp(x)", cells: [c("inf", "muted"), c("inf", "muted"), c("inf", "muted")] },
        ],
      },
      {
        caption: "Dividing inf by inf gives nan — the whole output is destroyed.",
        detail: "And nan propagates through every layer downstream.",
        rows: [
          { title: "exp(x)", cells: [c("inf", "muted"), c("inf", "muted"), c("inf", "muted")] },
          { title: "result", cells: [c("nan", "muted"), c("nan", "muted"), c("nan", "muted")] },
        ],
      },
      {
        caption: "Instead, subtract the maximum from every logit first.",
        detail: "softmax(x) == softmax(x − c) for any c, so this changes nothing.",
        rows: [
          { title: "logits", cells: [c("1000"), c("1000"), c("1000")] },
          { title: "x − max", cells: [c("0", "changed"), c("0", "changed"), c("0", "changed")] },
        ],
      },
      {
        caption: "Now every exponent is at most 0, so exp() is always safe.",
        detail: "The largest becomes exp(0) = 1; the rest land in (0, 1].",
        rows: [
          { title: "x − max", cells: [c("0"), c("0"), c("0")] },
          { title: "exp", cells: [c("1", "active"), c("1", "active"), c("1", "active")] },
        ],
      },
      {
        caption: "Divide by the sum. The denominator is never below 1.",
        detail: "sum = 3, so each probability is 1/3.",
        rows: [
          { title: "exp", cells: [c("1"), c("1"), c("1")] },
          {
            title: "softmax",
            cells: [c("0.333333", "changed"), c("0.333333", "changed"), c("0.333333", "changed")],
          },
        ],
      },
    ],
  },

  "cross-entropy-loss": {
    kind: "vector",
    title: "Only the true class contributes",
    steps: [
      {
        caption: "A batch of two predictions over three classes.",
        rows: [
          { title: "row 0", cells: [c("0.7", undefined, "0"), c("0.2", undefined, "1"), c("0.1", undefined, "2")] },
          { title: "row 1", cells: [c("0.1", undefined, "0"), c("0.8", undefined, "1"), c("0.1", undefined, "2")] },
        ],
      },
      {
        caption: "The labels select one probability per row. Everything else is ignored.",
        detail: "labels = [0, 1]",
        rows: [
          { title: "row 0", cells: [c("0.7", "active", "0"), c("0.2", "muted", "1"), c("0.1", "muted", "2")] },
          { title: "row 1", cells: [c("0.1", "muted", "0"), c("0.8", "active", "1"), c("0.1", "muted", "2")] },
        ],
      },
      {
        caption: "Take the negative log of each selected probability.",
        detail: "Confident and correct → near 0. Confident and wrong → large.",
        rows: [
          { title: "p", cells: [c("0.7", "active"), c("0.8", "active")] },
          { title: "−log(p)", cells: [c("0.356675", "changed"), c("0.223144", "changed")] },
        ],
      },
      {
        caption: "Average over the batch.",
        detail: "(0.356675 + 0.223144) / 2",
        rows: [{ title: "loss", cells: [c("0.289909", "changed")] }],
      },
      {
        caption: "The clamp exists for this case: a probability of exactly 0.",
        detail: "log(0) is undefined, so p is floored at 1e-12 → loss 27.63, not a crash.",
        rows: [
          { title: "p", cells: [c("0.0", "muted")] },
          { title: "max(p, 1e-12)", cells: [c("1e-12", "changed")] },
          { title: "−log(p)", cells: [c("27.631021", "changed")] },
        ],
      },
    ],
  },

  "layer-norm": {
    kind: "matrix",
    title: "LayerNorm normalises across features, per sample",
    steps: [
      {
        caption: "One sample, four features.",
        detail: "There is no batch here — every statistic comes from this row.",
        grid: [[c("1"), c("2"), c("3"), c("4")]],
        rowLabels: ["x"],
      },
      {
        caption: "Compute the mean across this row.",
        detail: "(1 + 2 + 3 + 4) / 4 = 2.5",
        grid: [[c("1", "active"), c("2", "active"), c("3", "active"), c("4", "active")]],
        rowLabels: ["x"],
      },
      {
        caption: "Subtract it, then compute the biased variance.",
        detail: "Divide the squared deviations by n, not n − 1.",
        grid: [
          [c("−1.5", "changed"), c("−0.5", "changed"), c("0.5", "changed"), c("1.5", "changed")],
        ],
        rowLabels: ["x − mean"],
      },
      {
        caption: "Divide by sqrt(var + eps). eps sits inside the root.",
        detail: "var = 1.25, so the divisor is ≈ 1.118034.",
        grid: [
          [c("−1.341635"), c("−0.447212"), c("0.447212"), c("1.341635")],
        ],
        rowLabels: ["normalised"],
      },
      {
        caption: "Finally scale by gamma and shift by beta.",
        detail: "With gamma = 1 and beta = 0 the output is unchanged.",
        grid: [
          [
            c("−1.341635", "changed"),
            c("−0.447212", "changed"),
            c("0.447212", "changed"),
            c("1.341635", "changed"),
          ],
        ],
        rowLabels: ["y"],
      },
    ],
  },

  "sgd-momentum-step": {
    kind: "vector",
    title: "One optimiser step, in the order that matters",
    steps: [
      {
        caption: "Start with the parameters, their gradients and the momentum buffer.",
        rows: [
          { title: "param", cells: [c("1.0"), c("2.0")] },
          { title: "grad", cells: [c("0.1"), c("0.2")] },
          { title: "velocity", cells: [c("0.0"), c("0.0")] },
        ],
      },
      {
        caption: "Step 1 — fold weight decay into the gradient.",
        detail: "g = grad + weight_decay × param. Here weight_decay is 0, so g is unchanged.",
        rows: [
          { title: "g", cells: [c("0.1", "changed"), c("0.2", "changed")] },
        ],
      },
      {
        caption: "Step 2 — update the velocity buffer with momentum.",
        detail: "v = momentum × v + g = 0.9 × 0 + 0.1",
        rows: [
          { title: "velocity", cells: [c("0.1", "changed"), c("0.2", "changed")] },
        ],
      },
      {
        caption: "Step 3 — step the parameter using the NEW velocity.",
        detail: "param = param − lr × v = 1.0 − 0.1 × 0.1",
        rows: [
          { title: "param", cells: [c("0.99", "changed"), c("1.98", "changed")] },
          { title: "velocity", cells: [c("0.1"), c("0.2")] },
        ],
      },
      {
        caption: "The buffer carries direction into the next step.",
        detail: "Next time, v starts at 0.1 rather than 0 — that is what momentum is.",
        rows: [
          { title: "velocity", cells: [c("0.1", "active"), c("0.2", "active")] },
        ],
      },
    ],
  },

  // ── LLM / VLM ─────────────────────────────────────────────────────────
  "scaled-dot-product-attention": {
    kind: "matrix",
    title: "The causal mask, applied before the softmax",
    steps: [
      {
        caption: "Score every query against every key: Q · Kᵀ.",
        detail: "Row i is what query i thinks of each key.",
        grid: [
          [c("1.0"), c("0.0")],
          [c("0.0"), c("1.0")],
        ],
        rowLabels: ["q0", "q1"],
        colLabels: ["k0", "k1"],
      },
      {
        caption: "Divide by sqrt(d_k) so the softmax does not saturate.",
        detail: "d_k = 2, so every score is divided by ≈ 1.414214.",
        grid: [
          [c("0.707107", "changed"), c("0.0", "changed")],
          [c("0.0", "changed"), c("0.707107", "changed")],
        ],
        rowLabels: ["q0", "q1"],
        colLabels: ["k0", "k1"],
      },
      {
        caption: "Mask the future: position i may only see j ≤ i.",
        detail: "This happens BEFORE the softmax, so masked cells get exactly zero weight.",
        grid: [
          [c("0.707107"), c("−inf", "muted")],
          [c("0.0"), c("0.707107")],
        ],
        rowLabels: ["q0", "q1"],
        colLabels: ["k0", "k1"],
      },
      {
        caption: "Softmax each row. Row 0 sees one key, so its weight is exactly 1.",
        detail: "Zeroing the weights after the softmax instead would leave row 0 un-normalised.",
        grid: [
          [c("1.0", "changed"), c("0.0", "muted")],
          [c("0.330238", "changed"), c("0.669762", "changed")],
        ],
        rowLabels: ["q0", "q1"],
        colLabels: ["k0", "k1"],
      },
      {
        caption: "Multiply by V to get the output.",
        detail: "Each output row is a weighted blend of the value rows it was allowed to see.",
        grid: [
          [c("1.0", "changed"), c("0.0", "changed")],
          [c("0.330238", "changed"), c("0.669762", "changed")],
        ],
        rowLabels: ["out0", "out1"],
        colLabels: ["d0", "d1"],
      },
    ],
  },

  "top-p-sampling": {
    kind: "vector",
    title: "The nucleus grows only as far as it must",
    steps: [
      {
        caption: "A probability distribution over four tokens.",
        rows: [
          {
            title: "probs",
            cells: [c("0.5", undefined, "0"), c("0.3", undefined, "1"), c("0.15", undefined, "2"), c("0.05", undefined, "3")],
          },
        ],
      },
      {
        caption: "Sort by probability, largest first. Ties prefer the lower index.",
        rows: [
          {
            title: "sorted",
            cells: [c("0.5", "active", "0"), c("0.3", undefined, "1"), c("0.15", undefined, "2"), c("0.05", undefined, "3")],
          },
        ],
      },
      {
        caption: "Accumulate. 0.5 alone does not reach p = 0.8.",
        detail: "cumulative = 0.5",
        rows: [
          {
            title: "kept",
            cells: [c("0.5", "changed", "0"), c("0.3", undefined, "1"), c("0.15", undefined, "2"), c("0.05", undefined, "3")],
          },
        ],
      },
      {
        caption: "Add the next. 0.5 + 0.3 = 0.8, which reaches the threshold.",
        detail: "The token that crosses p is included.",
        rows: [
          {
            title: "kept",
            cells: [c("0.5", "changed", "0"), c("0.3", "changed", "1"), c("0.15", undefined, "2"), c("0.05", undefined, "3")],
          },
        ],
      },
      {
        caption: "Everything else is discarded before sampling.",
        detail: "Result: indices [0, 1]. A more confident model would keep fewer.",
        rows: [
          {
            title: "nucleus",
            cells: [c("0.5", "active", "0"), c("0.3", "active", "1"), c("0.15", "muted", "2"), c("0.05", "muted", "3")],
          },
        ],
      },
    ],
  },

  "bpe-merge": {
    kind: "tokens",
    title: "One merge, applied to every non-overlapping occurrence",
    steps: [
      {
        caption: "The token sequence before the merge.",
        tokens: [c("l"), c("o"), c("w"), c("l"), c("o"), c("w")],
      },
      {
        caption: "Count adjacent pairs. (l,o) appears twice.",
        tokens: [c("l", "active"), c("o", "active"), c("w"), c("l", "active"), c("o", "active"), c("w")],
        bracket: [0, 1],
      },
      {
        caption: "(o,w) also appears twice — a tie.",
        detail: "The tie is broken by whichever pair occurs earliest.",
        tokens: [c("l"), c("o", "active"), c("w", "active"), c("l"), c("o", "active"), c("w", "active")],
        bracket: [1, 2],
      },
      {
        caption: "(l,o) starts at index 0, so it wins.",
        tokens: [c("l", "changed"), c("o", "changed"), c("w"), c("l", "changed"), c("o", "changed"), c("w")],
        bracket: [0, 1],
      },
      {
        caption: "Merge every non-overlapping occurrence, scanning left to right.",
        detail: "Merging at i consumes two tokens, so the scan advances by 2.",
        tokens: [c("lo", "changed"), c("w"), c("lo", "changed"), c("w")],
      },
    ],
  },

  "iou-nms": {
    kind: "boxes",
    title: "Greedy suppression, highest score first",
    steps: [
      {
        caption: "Three detections, with scores 0.9, 0.8 and 0.7.",
        extent: { width: 32, height: 32 },
        boxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, label: "0 · 0.9" },
          { x1: 1, y1: 1, x2: 11, y2: 11, label: "1 · 0.8" },
          { x1: 20, y1: 20, x2: 30, y2: 30, label: "2 · 0.7" },
        ],
      },
      {
        caption: "Take the highest-scoring box and keep it.",
        extent: { width: 32, height: 32 },
        boxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, label: "0 · kept", state: "changed" },
          { x1: 1, y1: 1, x2: 11, y2: 11, label: "1 · 0.8" },
          { x1: 20, y1: 20, x2: 30, y2: 30, label: "2 · 0.7" },
        ],
      },
      {
        caption: "Measure IoU against everything still in play.",
        detail: "Box 1 overlaps by 81; union is 100 + 100 − 81 = 119. IoU = 0.68.",
        extent: { width: 32, height: 32 },
        boxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, label: "0 · kept", state: "changed" },
          { x1: 1, y1: 1, x2: 11, y2: 11, label: "1 · IoU 0.68", state: "active" },
          { x1: 20, y1: 20, x2: 30, y2: 30, label: "2 · IoU 0.00" },
        ],
      },
      {
        caption: "0.68 exceeds the 0.5 threshold, so box 1 is suppressed.",
        detail: "It is a duplicate detection of the same object.",
        extent: { width: 32, height: 32 },
        boxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, label: "0 · kept", state: "changed" },
          { x1: 1, y1: 1, x2: 11, y2: 11, label: "1 · suppressed", state: "muted" },
          { x1: 20, y1: 20, x2: 30, y2: 30, label: "2 · 0.7" },
        ],
      },
      {
        caption: "Repeat with what is left. Box 2 does not overlap, so it survives.",
        detail: "Result: [0, 2], in the order they were selected.",
        extent: { width: 32, height: 32 },
        boxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, label: "0 · kept", state: "changed" },
          { x1: 1, y1: 1, x2: 11, y2: 11, label: "1 · suppressed", state: "muted" },
          { x1: 20, y1: 20, x2: 30, y2: 30, label: "2 · kept", state: "changed" },
        ],
      },
    ],
  },

  // ── CUDA / frameworks ─────────────────────────────────────────────────
  "parallel-reduction": {
    kind: "vector",
    title: "A tree reduction halves the range each step",
    steps: [
      {
        caption: "Eight elements. A CPU would take eight sequential additions.",
        rows: [{ title: "data", cells: [c("1"), c("2"), c("3"), c("4"), c("5"), c("6"), c("7"), c("8")] }],
      },
      {
        caption: "Stride 4: each thread adds the element four positions above it.",
        detail: "All four additions happen at once.",
        rows: [
          {
            title: "data",
            cells: [
              c("1", "active"), c("2", "active"), c("3", "active"), c("4", "active"),
              c("5", "active"), c("6", "active"), c("7", "active"), c("8", "active"),
            ],
          },
          { title: "after", cells: [c("6", "changed"), c("8", "changed"), c("10", "changed"), c("12", "changed")] },
        ],
      },
      {
        caption: "Stride 2 over the surviving four.",
        rows: [
          { title: "active", cells: [c("6", "active"), c("8", "active"), c("10", "active"), c("12", "active")] },
          { title: "after", cells: [c("16", "changed"), c("20", "changed")] },
        ],
      },
      {
        caption: "Stride 1. One addition left.",
        rows: [
          { title: "active", cells: [c("16", "active"), c("20", "active")] },
          { title: "after", cells: [c("36", "changed")] },
        ],
      },
      {
        caption: "Three steps instead of eight — log₂(n), not n.",
        detail: "With an odd length, a thread whose partner is past the end simply carries its value forward.",
        rows: [{ title: "total", cells: [c("36", "changed")] }],
      },
    ],
  },

  "thread-index-mapping": {
    kind: "matrix",
    title: "Why every kernel needs a bounds check",
    steps: [
      {
        caption: "A grid of 3 blocks × 4 threads, for an array of 10 elements.",
        detail: "Launches are sized in whole blocks, so 12 threads cover 10 elements.",
        grid: [
          [c("t0"), c("t1"), c("t2"), c("t3")],
          [c("t0"), c("t1"), c("t2"), c("t3")],
          [c("t0"), c("t1"), c("t2"), c("t3")],
        ],
        rowLabels: ["block 0", "block 1", "block 2"],
      },
      {
        caption: "Each thread computes blockIdx × blockDim + threadIdx.",
        grid: [
          [c("0", "changed"), c("1", "changed"), c("2", "changed"), c("3", "changed")],
          [c("4", "changed"), c("5", "changed"), c("6", "changed"), c("7", "changed")],
          [c("8", "changed"), c("9", "changed"), c("10", "changed"), c("11", "changed")],
        ],
        rowLabels: ["block 0", "block 1", "block 2"],
      },
      {
        caption: "Indices 10 and 11 are past the end of the array.",
        detail: "Without a guard, these two threads read and write memory that is not theirs.",
        grid: [
          [c("0"), c("1"), c("2"), c("3")],
          [c("4"), c("5"), c("6"), c("7")],
          [c("8"), c("9"), c("10", "active"), c("11", "active")],
        ],
        rowLabels: ["block 0", "block 1", "block 2"],
      },
      {
        caption: "The guard masks them off.",
        detail: "if (i < n) — the single most commonly forgotten line in a kernel.",
        grid: [
          [c("0"), c("1"), c("2"), c("3")],
          [c("4"), c("5"), c("6"), c("7")],
          [c("8"), c("9"), c("−1", "muted"), c("−1", "muted")],
        ],
        rowLabels: ["block 0", "block 1", "block 2"],
      },
    ],
  },

  "broadcast-shapes": {
    kind: "vector",
    title: "Align from the right, stretch the 1s",
    steps: [
      {
        caption: "Two shapes of different rank.",
        rows: [
          { title: "a", cells: [c("256"), c("256"), c("3")] },
          { title: "b", cells: [c("3")] },
        ],
      },
      {
        caption: "Align them from the RIGHT, not the left.",
        detail: "b's single dimension lines up with a's last one.",
        rows: [
          { title: "a", cells: [c("256"), c("256"), c("3", "active")] },
          { title: "b", cells: [c(" "), c(" "), c("3", "active")] },
        ],
      },
      {
        caption: "Missing leading dimensions count as 1.",
        rows: [
          { title: "a", cells: [c("256"), c("256"), c("3")] },
          { title: "b", cells: [c("1", "changed"), c("1", "changed"), c("3")] },
        ],
      },
      {
        caption: "Compare each pair: equal, or one of them is 1.",
        detail: "1 stretches to match; anything else is incompatible.",
        rows: [
          { title: "a", cells: [c("256", "active"), c("256", "active"), c("3", "active")] },
          { title: "b", cells: [c("1", "active"), c("1", "active"), c("3", "active")] },
        ],
      },
      {
        caption: "The result takes the larger of each pair.",
        detail: "An image and a per-channel constant broadcast cleanly.",
        rows: [
          { title: "result", cells: [c("256", "changed"), c("256", "changed"), c("3", "changed")] },
        ],
      },
      {
        caption: "When neither matches and neither is 1, there is no result.",
        detail: "[2, 3] against [4, 5] → incompatible.",
        rows: [
          { title: "a", cells: [c("2", "muted"), c("3", "muted")] },
          { title: "b", cells: [c("4", "muted"), c("5", "muted")] },
        ],
      },
    ],
  },

  "batchnorm-inference": {
    kind: "matrix",
    title: "BatchNorm normalises down the columns",
    steps: [
      {
        caption: "A batch of two samples, two features each.",
        detail: "Compare with LayerNorm, which works across each ROW.",
        grid: [
          [c("1"), c("2")],
          [c("3"), c("4")],
        ],
        rowLabels: ["sample 0", "sample 1"],
        colLabels: ["f0", "f1"],
      },
      {
        caption: "Each FEATURE has its own statistic, shared down the column.",
        detail: "running_mean = [2, 3], running_var = [1, 1]",
        grid: [
          [c("1", "active"), c("2")],
          [c("3", "active"), c("4")],
        ],
        rowLabels: ["sample 0", "sample 1"],
        colLabels: ["f0", "f1"],
      },
      {
        caption: "These come from training, not from this batch.",
        detail: "At inference the batch may be a single example — there is nothing to average.",
        grid: [
          [c("1"), c("2", "active")],
          [c("3"), c("4", "active")],
        ],
        rowLabels: ["sample 0", "sample 1"],
        colLabels: ["f0", "f1"],
      },
      {
        caption: "Subtract the column mean and divide by sqrt(var + eps).",
        detail: "Not exactly ±1, because eps sits inside the root.",
        grid: [
          [c("−0.999995", "changed"), c("−0.999995", "changed")],
          [c("0.999995", "changed"), c("0.999995", "changed")],
        ],
        rowLabels: ["sample 0", "sample 1"],
        colLabels: ["f0", "f1"],
      },
      {
        caption: "Scale by gamma and shift by beta, both per feature.",
        detail: "Forgetting model.eval() uses batch statistics here instead — and silently changes your predictions.",
        grid: [
          [c("−0.999995"), c("−0.999995")],
          [c("0.999995"), c("0.999995")],
        ],
        rowLabels: ["sample 0", "sample 1"],
        colLabels: ["f0", "f1"],
      },
    ],
  },
};

export function getVisualization(slug: string | undefined): Visualization | null {
  if (!slug) return null;
  return VISUALIZATIONS[slug] ?? null;
}
