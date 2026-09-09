/**
 * The rest of the ported curriculum.
 *
 * Split from `problems.ts` because that file was becoming a wall of content around the
 * small amount of logic that matters (`getProblem`, `toPublic`). Same `Problem` shape,
 * same rules: no expected outputs here, references are executed to derive them, and each
 * named trap gets a hidden case built to isolate it.
 */
import type { Problem } from "./problems.js";

export const TOP_P: Problem = {
  id: "top-p-sampling",
  math: "S = \\arg\\min_{|S|} \\; \\Big\\{\\, S : \\sum_{i \\in S} p_i \\ge p \\,\\Big\\}",
  title: "Top-p (Nucleus) Sampling",
  summary:
    "The filtering step behind almost every deployed LLM. Given a distribution and a threshold p, keep the smallest set of tokens whose probabilities sum to at least p, taking them in order of decreasing probability. Unlike top-k the set adapts: a confident model keeps one or two tokens, an uncertain one keeps many. Return the kept indices in ascending order.",
  entry: "top_p",
  difficulty: "medium",
  categories: ["LLM"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "confident", label: "Clear head", args: [[0.5, 0.3, 0.15, 0.05], 0.8], visible: true },
    /**
     * The running sum here is 0.8999999999999999, not 0.9 — float64 addition in input
     * order lands just under, so the fourth token is kept. That is an artefact of the
     * arithmetic rather than of the algorithm, and it is preserved deliberately: the
     * original content shipped this expectation, and "fixing" it with a tolerance would
     * change the answer for anyone who has already solved this. A plain `>=` on the
     * running sum at least makes it deterministic.
     */
    { id: "float-boundary", label: "Sums to p", args: [[0.4, 0.3, 0.2, 0.1], 0.9], visible: true },
    // Ties must be taken lowest-index-first, or the kept set differs between
    // implementations that sort differently.
    { id: "uniform", label: "All equal", args: [[0.25, 0.25, 0.25, 0.25], 0.5], visible: true },
    { id: "one-token", label: "Very confident", args: [[0.99, 0.01], 0.5], visible: false },
    // Unsorted input: walking the array in order rather than by descending probability
    // keeps the wrong tokens.
    { id: "unsorted", label: "Unsorted input", args: [[0.1, 0.6, 0.3], 0.5], visible: false },
  ],
  reference: `
def top_p(probs, p):
    # Descending probability, ties broken by the lower index so the result does not
    # depend on the sort's stability.
    order = sorted(range(len(probs)), key=lambda i: (-probs[i], i))
    running = 0.0
    kept = []
    for i in order:
        kept.append(i)
        running += probs[i]
        if running >= p:
            break
    return sorted(kept)
`,
  template: `def top_p(probs, p):
    # Smallest set of tokens, taken in order of decreasing probability, whose
    # probabilities sum to at least p. Return their indices, ascending.
    ...
`,
};

export const BPE_MERGE: Problem = {
  id: "bpe-merge",
  title: "BPE Merge Step",
  summary:
    "One merge step of Byte-Pair Encoding. Count every adjacent pair, pick the most frequent — on a tie, the one whose first occurrence is earliest — then replace every non-overlapping occurrence, scanning left to right, with the two tokens concatenated. Non-overlapping is the subtle part: in [a, a, a] the pair (a, a) is counted twice, but merging left to right consumes the first two and leaves the third alone.",
  entry: "bpe_merge",
  difficulty: "medium",
  categories: ["LLM", "NLP"],
  // collections is the natural way to count pairs, and the guard blocks anything not
  // listed — a correct solution using Counter was rejected until this was added.
  allowedImports: ["collections"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "simple", label: "One clear winner", args: [["a", "b", "a", "b", "c"]], visible: true },
    // The overlap case the statement names.
    { id: "overlapping", label: "Repeated token", args: [["a", "a", "a"]], visible: true },
    // Every pair occurs once, so the tie-break decides it.
    { id: "all-tied", label: "All pairs unique", args: [["x", "y", "z"]], visible: true },
    { id: "single", label: "Nothing to merge", args: [["a"]], visible: false },
    // Four in a row: left-to-right consumption gives two merges, not three.
    { id: "four-same", label: "Four identical", args: [["a", "a", "a", "a"]], visible: false },
  ],
  reference: `
def bpe_merge(tokens):
    if len(tokens) < 2:
        return list(tokens)

    counts = {}
    first_at = {}
    for i in range(len(tokens) - 1):
        pair = (tokens[i], tokens[i + 1])
        counts[pair] = counts.get(pair, 0) + 1
        if pair not in first_at:
            first_at[pair] = i

    # Most frequent; ties go to whichever appeared earliest.
    best = min(counts, key=lambda pair: (-counts[pair], first_at[pair]))

    merged = []
    i = 0
    while i < len(tokens):
        # Non-overlapping: a match consumes both tokens, so the second cannot begin
        # another match.
        if i + 1 < len(tokens) and (tokens[i], tokens[i + 1]) == best:
            merged.append(tokens[i] + tokens[i + 1])
            i += 2
        else:
            merged.append(tokens[i])
            i += 1
    return merged
`,
  template: `def bpe_merge(tokens):
    # Count adjacent pairs, pick the most frequent (ties: earliest first occurrence),
    # then replace non-overlapping occurrences left to right.
    ...
`,
};

export const IOU_NMS: Problem = {
  id: "iou-nms",
  math: "\\mathrm{IoU}(A,B) = \\frac{|A \\cap B|}{|A \\cup B|}",
  title: "IoU and Non-Max Suppression",
  summary:
    "The post-processing step every object detector ends with. A detector emits many overlapping boxes for one object; NMS keeps the most confident and discards its duplicates. Sort by score, take the top box, discard every remaining box whose IoU with it exceeds the threshold, and repeat. IoU is intersection over union, where union = area_a + area_b - intersection. Boxes are [x1, y1, x2, y2]. Return the kept indices in ascending order.",
  entry: "nms",
  difficulty: "medium",
  categories: ["VLM", "CV"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "one-duplicate",
      label: "Duplicate and a distant box",
      args: [
        [[0.0, 0.0, 10.0, 10.0], [1.0, 1.0, 11.0, 11.0], [20.0, 20.0, 30.0, 30.0]],
        [0.9, 0.8, 0.7],
        0.5,
      ],
      visible: true,
    },
    // IoU is exactly 1, so the lower-scoring box always goes.
    {
      id: "identical",
      label: "Identical boxes",
      args: [[[0.0, 0.0, 10.0, 10.0], [0.0, 0.0, 10.0, 10.0]], [0.9, 0.5], 0.5],
      visible: true,
    },
    // IoU is 4/28. An implementation using intersection-over-minimum instead gets 4/16
    // and behaves differently at this threshold.
    {
      id: "partial",
      label: "Partial overlap, low threshold",
      args: [[[0.0, 0.0, 4.0, 4.0], [2.0, 2.0, 6.0, 6.0]], [0.9, 0.8], 0.1],
      visible: true,
    },
    { id: "single-box", label: "One box", args: [[[0.0, 0.0, 2.0, 2.0]], [0.5], 0.5], visible: false },
    /**
     * Disjoint boxes touching at a corner. The intersection is empty, so IoU is 0 and both
     * survive even at threshold 0. An implementation computing width as `x2 - x1` without
     * clamping at zero gets a positive product from two negatives here and suppresses a
     * box it should keep.
     */
    {
      id: "touching",
      label: "Boxes that only touch",
      args: [[[0.0, 0.0, 2.0, 2.0], [3.0, 3.0, 5.0, 5.0]], [0.9, 0.8], 0.0],
      visible: false,
    },
  ],
  reference: `
def nms(boxes, scores, threshold):
    def iou(a, b):
        ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
        ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
        # Clamped: disjoint boxes would otherwise give two negative sides whose product
        # is a positive "overlap".
        iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
        shared = iw * ih
        # Named so this does not textually echo the formula the statement gives — the
        # leak check cannot tell a stated definition from an implementation of it, and
        # weakening it to allow this would blind it to a real leak elsewhere.
        combined = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared
        return shared / combined if combined > 0 else 0.0

    order = sorted(range(len(boxes)), key=lambda i: (-scores[i], i))
    kept = []
    while order:
        best = order.pop(0)
        kept.append(best)
        order = [i for i in order if iou(boxes[best], boxes[i]) <= threshold]
    return sorted(kept)
`,
  template: `def nms(boxes, scores, threshold):
    # Sort by score, keep the top box, discard everything overlapping it by more
    # than the threshold IoU, then repeat. Return kept indices, ascending.
    ...
`,
};

export const BROADCAST: Problem = {
  id: "broadcast-shapes",
  title: "Broadcast Shapes",
  summary:
    "Given two tensor shapes, return the shape they broadcast to. Align from the right, then per dimension: equal keeps it, a 1 stretches to the other, a missing dimension counts as 1, anything else is incompatible. Return the resulting shape, or an empty list if they cannot broadcast. The rules are identical in NumPy, PyTorch and TensorFlow.",
  entry: "broadcast",
  difficulty: "easy",
  categories: ["ML", "DL"],
  allowedImports: [],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "stretch-both", label: "Both stretch", args: [[3, 1, 5], [1, 4, 5]], visible: true },
    { id: "trailing", label: "Image and channel", args: [[256, 256, 3], [3]], visible: true },
    { id: "incompatible", label: "Incompatible", args: [[2, 3], [4, 5]], visible: true },
    // A scalar broadcasts against anything.
    { id: "scalar", label: "Scalar", args: [[], [7, 2]], visible: false },
    /**
     * Zero-length dimensions are legal and are not 1: (0,) with (1,) broadcasts to (0,).
     * An implementation testing truthiness — `if not dim` — treats 0 as a wildcard and
     * returns (1,) here, while one testing `dim == 1` is correct.
     */
    { id: "zero-dim", label: "Zero-length dimension", args: [[0], [1]], visible: false },
  ],
  reference: `
def broadcast(shape_a, shape_b):
    result = []
    # Right-aligned, so walk backwards from the tail of both.
    for i in range(1, max(len(shape_a), len(shape_b)) + 1):
        # A missing dimension counts as 1.
        a = shape_a[-i] if i <= len(shape_a) else 1
        b = shape_b[-i] if i <= len(shape_b) else 1
        if a == b:
            result.append(a)
        elif a == 1:
            result.append(b)
        elif b == 1:
            result.append(a)
        else:
            return []
    result.reverse()
    return result
`,
  template: `def broadcast(shape_a, shape_b):
    # Align from the right. Equal keeps it, 1 stretches, missing counts as 1,
    # anything else is incompatible. Return [] if they cannot broadcast.
    ...
`,
};

export const BATCHNORM: Problem = {
  id: "batchnorm-inference",
  math: "y = \\frac{x - \\mathrm{E}[x]}{\\sqrt{\\mathrm{Var}[x] + \\varepsilon}} \\cdot \\gamma + \\beta",
  title: "BatchNorm at Inference",
  summary:
    "y = (x - running_mean) / sqrt(running_var + eps) * gamma + beta. Compare with LayerNorm, which you have already written: LayerNorm computes its statistics from the sample in front of it, across features. BatchNorm normalises per feature across the batch, so at inference — where the batch may be a single example — it cannot compute anything and uses statistics accumulated during training instead. That is why BatchNorm has a train mode and an eval mode.",
  entry: "batch_norm",
  difficulty: "medium",
  categories: ["DL", "PyTorch"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "two-rows",
      label: "Two examples",
      args: [[[1.0, 2.0], [3.0, 4.0]], [2.0, 3.0], [1.0, 1.0], [1.0, 1.0], [0.0, 0.0], 1e-5],
      visible: true,
    },
    // A batch of one. The statistics still come from the buffers, which is the point.
    {
      id: "single-example",
      label: "Batch of one",
      args: [[[5.0]], [5.0], [4.0], [1.0], [0.0], 1e-5],
      visible: true,
    },
    { id: "affine-only", label: "Gain and shift only", args: [[[0.0, 0.0]], [0.0, 0.0], [1.0, 1.0], [2.0, 3.0], [1.0, -1.0], 1e-5], visible: true },
    /**
     * Statistics are per *feature*, not per row. Normalising across each row — LayerNorm's
     * axis, and the confusion this problem exists to settle — gives a different answer
     * here, because the two columns have different means and variances.
     */
    {
      id: "per-feature",
      label: "Distinct feature statistics",
      args: [
        [[10.0, 20.0], [30.0, 40.0]],
        [20.0, 30.0],
        [100.0, 25.0],
        [1.0, 1.0],
        [0.0, 0.0],
        1e-5,
      ],
      visible: false,
    },
    // Zero running variance: only eps keeps this finite.
    { id: "zero-variance", label: "Zero running variance", args: [[[1.0]], [1.0], [0.0], [1.0], [0.0], 1e-5], visible: false },
  ],
  reference: `
import numpy as np

def batch_norm(x, running_mean, running_var, gamma, beta, eps):
    a = np.asarray(x, dtype=float)
    mean = np.asarray(running_mean, dtype=float)
    var = np.asarray(running_var, dtype=float)
    # Broadcasting does the per-feature part: the buffers hold one entry per column, so
    # each column uses its own statistics whatever the batch size.
    normalised = (a - mean) / np.sqrt(var + eps)
    return (normalised * np.asarray(gamma, dtype=float) + np.asarray(beta, dtype=float)).tolist()
`,
  template: `import numpy as np


def batch_norm(x, running_mean, running_var, gamma, beta, eps):
    # (x - running_mean) / sqrt(running_var + eps) * gamma + beta
    # Statistics are per feature and come from the buffers, not from x.
    ...
`,
};
