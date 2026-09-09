/**
 * The problem store, owned by main.
 *
 * Everything that decides whether an answer is correct lives here and is never
 * accepted from the renderer: the test cases, the import allowlist, and the time and
 * memory limits. `exec:run` takes a problem id and a source string, nothing more.
 *
 * That is not defensive habit, it is the whole point. If the renderer supplied its
 * own cases it could grade itself against one trivial input; if it supplied its own
 * `allowedImports` it could grant itself scipy on a NumPy-only exercise; if it
 * supplied its own `timeLimitMs` the stated 200 ms budget would mean nothing. In a
 * local-first app the user *can* patch the client — so the client must not be where
 * the answer key lives, or "solved" stops carrying information for the person whose
 * learning depends on it.
 *
 * `expectedOutput` is deliberately absent from these definitions. Expectations are
 * derived by executing `reference` (see `exec/grader.ts`), because a typed-in
 * expected value is a guess. This is the same rule the paper pipeline will need in
 * Phase 6, established here where it is cheap.
 */

import { TOP_P, BPE_MERGE, IOU_NMS, BROADCAST, BATCHNORM } from "./curriculum.js";
import { INTERVIEW_PROBLEMS } from "./interview-problems.js";

export interface ProblemCase {
  id: string;
  /** Positional arguments. Must be JSON-serialisable to cross into Pyodide. */
  args: unknown[];
  /** Shown in the UI. Hidden cases are graded but not displayed before submit. */
  visible: boolean;
  label: string;
}

export interface Problem {
  id: string;
  title: string;
  /** One-line statement of what to compute. Full prose belongs in the reader (Phase 6). */
  summary: string;
  entry: string;
  difficulty: "easy" | "medium" | "hard";
  /**
   * Topic tags, e.g. ML / DL / LLM.
   *
   * Deliberately many-to-one: a problem tagged both DL and LLM counts once in each, so
   * category totals overlap and summing them exceeds the problem count. They answer
   * different questions, and the dashboard client documents the same thing.
   */
  categories: string[];
  /** Package roots user code may import, beyond the always-tolerated stdlib. */
  allowedImports: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  cases: ProblemCase[];
  /**
   * The reference implementation. Never sent to the renderer — it is the answer.
   *
   * The Study window's context assembler must not be able to reach this either
   * (spec §2.2); when the tutor lands, that is enforced by which module it can
   * import, not by asking it nicely.
   */
  reference: string;
  /** Starting buffer. The tutor compares against this to know if anything was written. */
  template: string;
  /**
   * The definition, as LaTeX.
   *
   * **Authored, unlike shapes and expected outputs.** Those are derived because they have to
   * agree with what the reference does; a definition has nothing to disagree with — it *is*
   * the specification the reference implements. Writing it by hand is therefore correct here
   * and wrong there.
   *
   * Optional, and absent for the exercises that are genuinely procedures rather than
   * formulas: BPE merging and broadcast-shape compatibility are rules you apply, and dressing
   * either up as an equation would be decoration.
   */
  math?: string;
  /**
   * How this problem compares answers, as a Python expression in `_r`.
   *
   * Applied to the reference and the learner identically — see `ExecRequest.normalise`.
   * Absent for every curriculum problem here: they were authored against the global
   * normalisation and need nothing more. The interview problems carry one because the
   * web ran them through a per-problem driver that rounded, coerced and sorted before
   * anything was compared, and calling the entry point directly would otherwise discard
   * the problem's own definition of "equal".
   */
  normalise?: string;
}

const SIGMOID: Problem = {
  id: "sigmoid",
  math: "\\sigma(x) = \\frac{1}{1 + e^{-x}}",
  title: "Sigmoid activation",
  summary:
    "Return the logistic sigmoid of the input, elementwise. Must work on a scalar, a list, or a nested list.",
  entry: "sigmoid",
  difficulty: "easy",
  categories: ["ML", "DL"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "vector", label: "Vector", args: [[0, 2, -2]], visible: true },
    { id: "scalar", label: "Scalar", args: [0], visible: true },
    {
      id: "matrix",
      label: "Nested list",
      args: [[[-1, 0], [1, 2]]],
      visible: true,
    },
    // Hidden, and chosen to catch a specific wrong answer rather than to pad the
    // count: a solution written as `1/(1+exp(-x))` with a Python float overflows on
    // -800, where numpy underflows to 0.0 and is correct.
    { id: "large-negative", label: "Saturation", args: [[-800, 800]], visible: false },
  ],
  reference: `
import numpy as np

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=float)))
`,
  template: `import numpy as np


def sigmoid(x):
    # Return the logistic sigmoid, elementwise.
    ...
`,
};

const MIN_MAX: Problem = {
  id: "min-max-scale",
  math: "x'_i = \\frac{x_i - \\min(x)}{\\max(x) - \\min(x)}",
  title: "Min-max scaling",
  summary:
    "Scale values to [0, 1] using the observed minimum and maximum. When every value is identical, return zeros rather than dividing by zero.",
  entry: "min_max_scale",
  difficulty: "easy",
  categories: ["ML"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "simple", label: "Ascending", args: [[0, 5, 10]], visible: true },
    { id: "negatives", label: "Negative range", args: [[-4, 0, 4]], visible: true },
    // The degenerate case is visible on purpose. It is the entire difficulty of this
    // exercise, and hiding it would make a learner fail on a rule nobody told them.
    { id: "constant", label: "All equal", args: [[7, 7, 7]], visible: true },
    { id: "single", label: "One element", args: [[3]], visible: false },
  ],
  reference: `
import numpy as np

def min_max_scale(values):
    a = np.asarray(values, dtype=float)
    lo = a.min()
    span = a.max() - lo
    if span == 0:
        return np.zeros_like(a)
    return (a - lo) / span
`,
  template: `import numpy as np


def min_max_scale(values):
    # Scale to [0, 1]. Watch the case where every value is the same.
    ...
`,
};

/**
 * Ported from `apps/api/scripts/problem_content.py`, with one deliberate difference:
 * the seed carried `expected_output` strings typed in by hand. Those are not imported.
 * The reference below is executed to derive them (see `exec/grader.ts`), because a
 * written-down expectation is a guess that looks like a fact — and rounded to 6dp, the
 * seed's values would not even match this harness's 8dp normalisation.
 */
const STABLE_SOFTMAX: Problem = {
  id: "stable-softmax",
  math: "\\mathrm{softmax}(x)_i = \\frac{e^{\\,x_i - \\max(x)}}{\\sum_j e^{\\,x_j - \\max(x)}}",
  title: "Numerically Stable Softmax",
  summary:
    "Implement softmax over a vector of logits. The textbook form overflows on real model outputs: a logit of 1000 makes exp() infinite and the result NaN. Softmax is shift-invariant, so subtracting the maximum leaves the answer unchanged and makes it safe.",
  entry: "softmax",
  difficulty: "easy",
  categories: ["ML", "DL"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "basic", label: "Three logits", args: [[1.0, 2.0, 3.0]], visible: true },
    // The whole point of the exercise. A naive exp() overflows to inf here and returns
    // NaN; the shifted form returns a uniform distribution.
    { id: "overflow", label: "Large equal logits", args: [[1000.0, 1000.0, 1000.0]], visible: true },
    // Same answer as "basic", shifted by -2. Shift-invariance made visible rather than
    // only asserted in the prose.
    { id: "shift-invariant", label: "Shifted by a constant", args: [[-1.0, 0.0, 1.0]], visible: true },
    { id: "single", label: "One logit", args: [[0.0]], visible: false },
    // Catches the other half of the failure: shifting by the max sends the small logits
    // to exp(-2000), which underflows to 0. That is correct — but an implementation that
    // shifts by the *mean*, or clips, gets this wrong while passing every visible case.
    { id: "wide-range", label: "Extreme spread", args: [[-1000.0, 0.0, 1000.0]], visible: false },
  ],
  reference: `
import numpy as np

def softmax(logits):
    x = np.asarray(logits, dtype=float)
    shifted = x - x.max()
    e = np.exp(shifted)
    return e / e.sum()
`,
  template: `import numpy as np


def softmax(logits):
    # exp(x_i) / sum_j exp(x_j), but safe for any input.
    # Softmax is shift-invariant: subtracting a constant from every logit
    # leaves the result unchanged.
    ...
`,
};

// Catalogue order is the order a learner meets them.
/**
 * Ported from the same seed, expectations derived rather than imported.
 *
 * The seed's hidden case is the entire exercise and its value gives the lesson away once
 * you look at it: a probability of 0.0 was expected to score 27.631021, which is
 * -ln(1e-12). So the reference clamps, and the epsilon is 1e-12 because that is the value
 * the original content was written against — changing it would silently change what
 * counts as correct for anyone who already solved this.
 */
const CROSS_ENTROPY: Problem = {
  id: "cross-entropy-loss",
  math: "L = -\\frac{1}{N} \\sum_{i=1}^{N} \\log p_{i,\\,y_i}",
  title: "Cross-Entropy Loss",
  summary:
    "Given per-row class probabilities and the index of the correct class in each row, return the mean negative log-likelihood. A predicted probability of exactly zero makes log() infinite, so clamp before taking the logarithm.",
  entry: "cross_entropy",
  difficulty: "easy",
  categories: ["ML", "DL"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "two-rows",
      label: "Two rows",
      args: [[[0.7, 0.2, 0.1], [0.1, 0.8, 0.1]], [0, 1]],
      visible: true,
    },
    { id: "uniform", label: "Uniform over four", args: [[[0.25, 0.25, 0.25, 0.25]], [2]], visible: true },
    // A perfect prediction costs nothing. Useful as an anchor: if this is not exactly 0,
    // the mean or the sign is wrong.
    { id: "perfect", label: "Perfect prediction", args: [[[1.0, 0.0], [0.0, 1.0]], [0, 1]], visible: true },
    // The exercise. -log(0) is infinity, and an unclamped implementation returns inf here
    // while passing all three visible cases.
    { id: "zero-probability", label: "Zero probability", args: [[[0.0, 1.0]], [0]], visible: false },
    // Catches clamping applied to the wrong side: clipping the upper bound as well is
    // harmless, but clamping to something far larger than 1e-12 changes this answer.
    { id: "tiny-probability", label: "Very small probability", args: [[[1e-9, 1.0]], [0]], visible: false },
  ],
  reference: `
import numpy as np

# The floor the original content was written against. -log(1e-12) = 27.631021.
EPS = 1e-12

def cross_entropy(probs, targets):
    p = np.asarray(probs, dtype=float)
    t = np.asarray(targets, dtype=int)
    chosen = p[np.arange(len(t)), t]
    return float(-np.log(np.clip(chosen, EPS, 1.0)).mean())
`,
  template: `import numpy as np


def cross_entropy(probs, targets):
    # Mean of -log(probability assigned to the correct class).
    # log(0) is -infinity, so clamp before taking the logarithm.
    ...
`,
};

/**
 * Ported from the same seed, expectations derived. The statement names two traps
 * explicitly — biased variance, and eps inside the square root — so each gets a hidden
 * case that isolates it rather than relying on the visible cases to catch them
 * incidentally.
 */
const LAYER_NORM: Problem = {
  id: "layer-norm",
  math: "y = \\frac{x - \\mu}{\\sqrt{\\sigma^2 + \\varepsilon}} \\cdot \\gamma + \\beta",
  title: "Layer Normalisation",
  summary:
    "y_i = (x_i - mean) / sqrt(var + eps) * gamma_i + beta_i. Mean and variance are taken across the features of this one vector, not across a batch — which is why LayerNorm works at batch size 1 and needs no running statistics. Use the biased variance (divide by n), and note that eps sits inside the square root.",
  entry: "layer_norm",
  difficulty: "medium",
  categories: ["DL", "PyTorch"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "basic",
      label: "Unit gain, no shift",
      args: [[1.0, 2.0, 3.0, 4.0], [1.0, 1.0, 1.0, 1.0], [0.0, 0.0, 0.0, 0.0], 1e-5],
      visible: true,
    },
    // Zero variance. Without eps this is 0/0; the whole reason eps exists.
    {
      id: "constant",
      label: "Constant input",
      args: [[2.0, 2.0, 2.0], [1.0, 1.0, 1.0], [0.0, 0.0, 0.0], 1e-5],
      visible: true,
    },
    {
      id: "affine",
      label: "With gain and shift",
      args: [[1.0, -1.0], [2.0, 2.0], [0.5, -0.5], 1e-5],
      visible: true,
    },
    {
      id: "per-feature-affine",
      label: "Per-feature gain",
      args: [[10.0, 20.0, 30.0], [0.5, 1.0, 1.5], [1.0, 1.0, 1.0], 1e-5],
      visible: false,
    },
    /**
     * Isolates eps placement.
     *
     * Variance here is 2.5e-9, so eps dominates it. `sqrt(var + eps)` is ~0.00316 while
     * `sqrt(var) + eps` is ~0.00006 — a factor of fifty. On the visible cases the two
     * spellings differ in the sixth decimal and could plausibly be missed; here they
     * cannot be.
     */
    {
      id: "eps-placement",
      label: "Near-constant input",
      args: [[1.0, 1.0001], [1.0, 1.0], [0.0, 0.0], 1e-5],
      visible: false,
    },
  ],
  reference: `
import numpy as np

def layer_norm(x, gamma, beta, eps):
    a = np.asarray(x, dtype=float)
    mean = a.mean()
    # np.var defaults to ddof=0, which is the biased variance the statement asks for.
    var = a.var()
    normalised = (a - mean) / np.sqrt(var + eps)
    return normalised * np.asarray(gamma, dtype=float) + np.asarray(beta, dtype=float)
`,
  template: `import numpy as np


def layer_norm(x, gamma, beta, eps):
    # (x - mean) / sqrt(var + eps) * gamma + beta
    # Statistics are over this vector's own features. Biased variance; eps inside
    # the square root.
    ...
`,
};

/**
 * The two CUDA problems, reformulated to run in the Pyodide tier.
 *
 * Neither can execute as written: Tier A is WASM CPython with no GPU. Reformulating rather
 * than dropping them is defensible because the lesson in both is *index arithmetic*, not
 * touching hardware — the stride that rounds up, and the bounds guard whose absence is the
 * classic way a kernel corrupts memory. Both survive translation exactly.
 *
 * What is honestly lost: no actual parallelism, no memory coalescing, no occupancy. These
 * teach the shape of the computation, and the statements say so rather than implying a
 * learner has written CUDA.
 */
const PARALLEL_REDUCTION: Problem = {
  id: "parallel-reduction",
  math: "s^{(k+1)}_i = s^{(k)}_i + s^{(k)}_{i + \\mathrm{stride}}, \\qquad \\mathrm{stride} = \\tfrac{n}{2^{k+1}}",
  title: "Parallel Reduction",
  summary:
    "Sum an array the way a GPU does. A tree reduction halves the active range each step: every thread in the lower half adds the element `stride` positions above it. Return the active range after each step, so the halving is visible. The interesting case is a length that is not a power of two — the stride rounds up, and a thread whose partner falls past the end must do nothing rather than read out of bounds.",
  entry: "reduce_steps",
  difficulty: "medium",
  categories: ["CUDA"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "power-of-two", label: "Length 8", args: [[1, 2, 3, 4, 5, 6, 7, 8]], visible: true },
    // Odd length: stride is (5+1)//2 = 3, and index 2 has no partner.
    { id: "odd-length", label: "Length 5", args: [[1, 2, 3, 4, 5]], visible: true },
    { id: "six", label: "Length 6", args: [[3, 1, 4, 1, 5, 9]], visible: true },
    // Already reduced. No steps at all — an implementation looping `while len > 0` or
    // emitting an initial state returns something here instead of nothing.
    { id: "single", label: "Single element", args: [[42]], visible: false },
    // Rounding down instead of up drops the tail element silently on length 7.
    { id: "seven", label: "Length 7", args: [[1, 1, 1, 1, 1, 1, 1]], visible: false },
  ],
  reference: `
def reduce_steps(values):
    active = list(values)
    steps = []
    while len(active) > 1:
        # Rounds up, so an odd length leaves the middle element unpaired rather than
        # dropping it.
        stride = (len(active) + 1) // 2
        nxt = []
        for i in range(stride):
            partner = i + stride
            # The guard. Past the end, the thread contributes only its own value.
            nxt.append(active[i] + active[partner] if partner < len(active) else active[i])
        active = nxt
        steps.append(active)
    return steps
`,
  template: `def reduce_steps(values):
    # Halve the active range each step until one value remains.
    # Return the range after each step. Stride rounds up; a thread whose
    # partner is past the end must not read it.
    ...
`,
};

const THREAD_INDEX: Problem = {
  id: "thread-index-mapping",
  math: "i = \\mathrm{blockIdx} \\cdot \\mathrm{blockDim} + \\mathrm{threadIdx}",
  title: "Thread Index Mapping",
  summary:
    "Work out which element each thread is responsible for. A thread's global position is blockIdx * blockDim + threadIdx. Launches are sized in whole blocks, so the grid almost always covers more threads than there are elements — threads past the end must do nothing. Return one list per block of each thread's global index, with -1 wherever that index falls outside the array.",
  entry: "map_threads",
  difficulty: "easy",
  categories: ["CUDA"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    { id: "exact", label: "Grid fits exactly", args: [2, 4, 8], visible: true },
    // The usual case: the last block is partly out of range.
    { id: "ragged", label: "Partial last block", args: [3, 4, 10], visible: true },
    { id: "mostly-idle", label: "Mostly out of range", args: [1, 8, 3], visible: true },
    // Empty input. Every thread is out of bounds; a missing guard indexes into nothing.
    { id: "empty", label: "No elements", args: [2, 2, 0], visible: false },
    { id: "single-thread", label: "One thread per block", args: [3, 1, 2], visible: false },
  ],
  reference: `
def map_threads(num_blocks, block_dim, n):
    grid = []
    for block in range(num_blocks):
        row = []
        for thread in range(block_dim):
            index = block * block_dim + thread
            # The missing \`if (i < n)\` is the single most common way a kernel
            # corrupts memory. Here it is the difference between -1 and a wrong index.
            row.append(index if index < n else -1)
        grid.append(row)
    return grid
`,
  template: `def map_threads(num_blocks, block_dim, n):
    # global_index = blockIdx * blockDim + threadIdx
    # One list per block. -1 wherever the index falls outside the array.
    ...
`,
};

/**
 * Ported from the same seed. The statement is emphatic that the *order* is the lesson —
 * weight decay folds into the gradient before the momentum buffer updates, so the decay
 * accumulates in the buffer too. Applying it to the parameter afterwards is a different
 * algorithm (AdamW-style decoupled decay), not a rounding difference.
 *
 * Returning the velocity buffer as well as the parameters is what makes that testable: an
 * implementation that folds `lr` into the buffer produces identical parameters and a
 * different buffer, and would pass unnoticed if only the parameters came back.
 */
const SGD_MOMENTUM: Problem = {
  id: "sgd-momentum-step",
  math: "g \\leftarrow g + \\lambda\\theta, \\quad v \\leftarrow \\mu v + g, \\quad \\theta \\leftarrow \\theta - \\eta v",
  title: "SGD Step with Momentum",
  summary:
    "One optimiser step matching torch.optim.SGD. Per parameter, in this order: g = grad + weight_decay * param; v = momentum * v + g; param = param - lr * v. The order matters — decay is folded into the gradient before the buffer updates, so it accumulates there too. Return [params, velocity].",
  entry: "sgd_step",
  difficulty: "medium",
  categories: ["ML", "DL", "PyTorch"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "fresh-buffer",
      label: "Zero velocity",
      args: [[1.0, 2.0], [0.1, 0.2], [0.0, 0.0], 0.1, 0.9, 0.0],
      visible: true,
    },
    {
      id: "warm-buffer",
      label: "Existing velocity",
      args: [[1.0], [0.5], [0.3], 0.01, 0.9, 0.0],
      visible: true,
    },
    // weight_decay non-zero, momentum zero: isolates the decay term.
    {
      id: "decay-no-momentum",
      label: "Decay, no momentum",
      args: [[1.0, -1.0], [0.1, 0.1], [0.0, 0.0], 0.1, 0.0, 0.01],
      visible: true,
    },
    // Both non-zero, and the gradient is zero — so every bit of movement comes from decay
    // travelling through the buffer. Decoupled decay gets a different answer here.
    {
      id: "decay-through-buffer",
      label: "Decay with momentum",
      args: [[0.5], [0.0], [1.0], 0.1, 0.5, 0.1],
      visible: false,
    },
    // Plain SGD. Anchors the degenerate case: with no momentum and no decay the buffer is
    // just the gradient and the step is lr * grad.
    {
      id: "plain-sgd",
      label: "No momentum, no decay",
      args: [[2.0], [0.5], [0.0], 0.1, 0.0, 0.0],
      visible: false,
    },
  ],
  /**
   * Written so it does not textually echo the statement.
   *
   * The recurrence is given to the learner on purpose — this exercise is about
   * implementing it in the right order, not deriving it — so the summary and template both
   * spell it out. An earlier version of this reference used the same one-letter names, and
   * the "never includes the reference implementation" test flagged the payload as leaking.
   * It was right to: it cannot distinguish a stated formula from an implementation of it,
   * and weakening the check to accommodate this problem would blind it to a real leak in
   * the next one.
   */
  reference: `
def sgd_step(params, grads, velocity, lr, momentum, weight_decay):
    updated_params = []
    updated_velocity = []
    for param, grad, vel in zip(params, grads, velocity):
        # Decay folds into the gradient here, so it reaches the buffer — not onto the
        # parameter after the step, which would be decoupled decay.
        effective_grad = grad + weight_decay * param
        vel = momentum * vel + effective_grad
        updated_params.append(param - lr * vel)
        updated_velocity.append(vel)
    return [updated_params, updated_velocity]
`,
  template: `def sgd_step(params, grads, velocity, lr, momentum, weight_decay):
    # Per parameter, in this order:
    #   g = grad + weight_decay * param
    #   v = momentum * v + g
    #   param = param - lr * v
    # Return [params, velocity].
    ...
`,
};

/**
 * Ported from the same seed. Two traps are named in the statement and each gets a case and
 * a mutant: the sqrt(d_k) scale, and masking before the softmax rather than zeroing after.
 *
 * The reference is deliberately not written in the notation the statement uses, for the
 * reason sgd-momentum-step documents — the formula is given to the learner on purpose, so
 * an implementation that echoes it verbatim trips the leak check for no good reason.
 */
const ATTENTION: Problem = {
  id: "scaled-dot-product-attention",
  math: "\\mathrm{Attention}(Q,K,V) = \\mathrm{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right) V",
  title: "Scaled Dot-Product Attention",
  summary:
    "softmax(Q @ K.T / sqrt(d_k)) @ V. Two details carry most of the marks. The scale is not cosmetic: dot products grow with dimension, and without it the softmax saturates and the gradient vanishes. And when causal, position i may attend only to j <= i — masked positions must be excluded before the softmax so they receive exactly zero weight, not zeroed afterwards, which leaves the row un-normalised.",
  entry: "attention",
  difficulty: "medium",
  categories: ["DL", "LLM"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "single-query",
      label: "One query, no mask",
      args: [[[1.0, 0.0]], [[1.0, 0.0], [0.0, 1.0]], [[1.0, 2.0], [3.0, 4.0]], false],
      visible: true,
    },
    // Causal. Row 0 sees only itself, so it must return V[0] exactly.
    {
      id: "causal",
      label: "Causal mask",
      args: [
        [[1.0, 0.0], [0.0, 1.0]],
        [[1.0, 0.0], [0.0, 1.0]],
        [[1.0, 0.0], [0.0, 1.0]],
        true,
      ],
      visible: true,
    },
    // Zero query: every score is 0, so the weights are uniform and the answer is the mean
    // of V. Anchors the softmax independently of the scale.
    {
      id: "uniform",
      label: "Zero query",
      args: [[[0.0, 0.0]], [[1.0, 2.0], [3.0, 4.0]], [[5.0, 6.0], [7.0, 8.0]], false],
      visible: true,
    },
    {
      id: "causal-rectangular",
      label: "Three queries, causal",
      args: [
        [[1.0, 1.0], [2.0, 0.0], [0.0, 2.0]],
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
        true,
      ],
      visible: false,
    },
    /**
     * Isolates the scale.
     *
     * Large-magnitude queries in eight dimensions: unscaled, the softmax saturates to
     * one-hot and the answer is exactly V's argmax row. Scaled, it stays a genuine mixture.
     * On the small visible cases the two differ only slightly.
     */
    {
      id: "scale-matters",
      label: "Large scores",
      args: [
        [[3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]],
        [
          [3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0],
          [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
        ],
        [[1.0, 0.0], [0.0, 1.0]],
        false,
      ],
      visible: false,
    },
  ],
  reference: `
import numpy as np

def attention(queries, keys, values, causal):
    q = np.asarray(queries, dtype=float)
    k = np.asarray(keys, dtype=float)
    v = np.asarray(values, dtype=float)

    # Dot products grow with the key dimension; this is what keeps the softmax out of
    # saturation.
    logits = q @ k.T / np.sqrt(k.shape[-1])

    if causal:
        # Blocked strictly above the diagonal: query i may see key j only when j <= i.
        blocked = np.triu(np.ones(logits.shape, dtype=bool), k=1)
        # -inf before the softmax, so the weight is exactly zero and the row still sums to
        # one. Zeroing after the softmax would leave it un-normalised.
        logits = np.where(blocked, -np.inf, logits)

    stable = logits - logits.max(axis=-1, keepdims=True)
    weights = np.exp(stable)
    weights = weights / weights.sum(axis=-1, keepdims=True)
    return (weights @ v).tolist()
`,
  template: `import numpy as np


def attention(queries, keys, values, causal):
    # softmax(Q @ K.T / sqrt(d_k)) @ V
    # When causal, position i attends only to j <= i, and masked positions must be
    # excluded before the softmax rather than zeroed after it.
    ...
`,
};

/**
 * ── THE TWO HARD PROBLEMS ─────────────────────────────────────────────────────────────────────
 *
 * The catalogue had `easy` and `medium` and nothing above them, which
 * `tests/content-census.test.ts` pinned as a declared gap rather than leaving to memory. These close
 * it, and both are hard for the reason the pin wanted: **composition and a numerical trap**, not more
 * typing. Each sits at the summit of a track that already exists and reuses existing concepts, so
 * `CONCEPTS` stays at 52 and only `teaches` grows.
 *
 * A third was considered and dropped: multi-head attention with a causal mask. Two reasons, and the
 * second is the interesting one. `scaled-dot-product-attention` already teaches the scale and the
 * mask-before-softmax rule, so only head splitting would have been new. And the trap it was meant to
 * carry — a fully-masked row making softmax return NaN — **cannot occur under a causal mask at all**:
 * query i always sees key i, so no row is ever entirely blocked. Reaching that trap needs a padding
 * mask, which is a different problem than the one that was proposed. Better to say so than to ship an
 * exercise whose named trap its own cases cannot produce.
 */

/**
 * Layer normalisation, backwards.
 *
 * The best of the candidates for one reason: interviews ask for this derivation constantly, an
 * interview item already asks a learner to *derive* it (`derive-layernorm-backward`), and nothing in
 * the catalogue asks them to *implement* it. Forward LayerNorm is `medium` and already here, so this
 * is the same layer one level down.
 *
 * Hard because mean and variance couple every element to every other. `dx_i` depends on all of `dy`,
 * not just `dy_i`, and the term people drop is the one that comes from `std` itself depending on `x`.
 *
 * ── THE CASE THAT HAD TO BE DESIGNED, NOT BORROWED ────────────────────────────────────────────
 *
 * The variance term is `xhat_i * mean(dxhat * xhat)`, and it **vanishes whenever `dy * gamma` is
 * constant** — because `sum(xhat)` is zero by construction. So the obvious test (upstream gradient of
 * all ones, unit gain) passes with the term missing, and passes with `dx` exactly zero, which looks
 * like a satisfyingly clean answer. `uniform-upstream` is a visible case precisely so that trap is on
 * display; `variance-path` is the hidden one that varies both `dy` and `gamma` so the term cannot
 * cancel.
 */
const LAYER_NORM_BACKWARD: Problem = {
  id: "layer-norm-backward",
  math:
    "\\frac{\\partial L}{\\partial x_i} = \\frac{1}{\\sigma}\\left(g_i - \\overline{g} - \\hat{x}_i\\,\\overline{g\\hat{x}}\\right), \\quad g = \\frac{\\partial L}{\\partial y}\\odot\\gamma",
  title: "Layer Normalisation Backward",
  summary:
    "Given x, gamma, the upstream gradient dy, and eps, return [dx, dgamma, dbeta] for a single LayerNorm vector. dbeta is dy and dgamma is dy * xhat, where xhat is the normalised input — not x. dx is the one that bites: because the mean and the biased variance are both functions of every element, dx_i depends on all of dy. Writing dx = (dy * gamma) / std treats std as a constant and is wrong; the missing piece is the term that comes from std itself depending on x.",
  entry: "layer_norm_backward",
  difficulty: "hard",
  categories: ["DL", "PyTorch"],
  allowedImports: ["numpy"],
  timeLimitMs: 200,
  memoryLimitMb: 64,
  cases: [
    {
      id: "basic",
      label: "One-hot upstream gradient",
      args: [[1.0, 2.0, 3.0, 4.0], [1.0, 1.0, 1.0, 1.0], [1.0, 0.0, 0.0, 0.0], 1e-5],
      visible: true,
    },
    /**
     * The trap, in the open.
     *
     * `dy * gamma` is constant here, so `mean(dxhat * xhat)` is `mean(xhat)`, which is exactly zero —
     * the variance term disappears and `dx` is the zero vector. Correct, and reachable with the term
     * missing, which is why it cannot be the case that guards it.
     */
    {
      id: "uniform-upstream",
      label: "Constant upstream gradient",
      args: [[1.0, 2.0, 3.0, 4.0], [1.0, 1.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 1e-5],
      visible: true,
    },
    {
      id: "with-gain",
      label: "Non-unit gain",
      args: [[1.0, -1.0], [2.0, 3.0], [1.0, -1.0], 1e-5],
      visible: true,
    },
    /**
     * Isolates the variance path.
     *
     * Both `dy` and `gamma` vary, so `sum(dxhat * xhat)` is nowhere near zero and the dropped term
     * changes every component of `dx`. This is the case the spec's named mutant is paired with.
     */
    {
      id: "variance-path",
      label: "Varying gain and gradient",
      args: [
        [1.0, 2.0, 3.0, 4.0, 5.0],
        [0.5, 1.0, 1.5, 2.0, 2.5],
        [1.0, 2.0, 3.0, 4.0, 5.0],
        1e-5,
      ],
      visible: false,
    },
    /**
     * Isolates `dgamma` against the commonest slip: using `x` where `xhat` belongs.
     *
     * The input mean is 20, so `x` and `xhat` are nowhere near each other — `dgamma` would come back
     * as [10, 20, 30] instead of the normalised values. On a zero-mean input the two are much closer
     * and the error is easy to miss.
     */
    {
      id: "gain-gradient",
      label: "Large input mean",
      args: [[10.0, 20.0, 30.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0], 1e-5],
      visible: false,
    },
    /**
     * Isolates eps placement, the same way the forward problem's `eps-placement` case does — the
     * denominator is `sqrt(var + eps)` here too, and it appears cubed through the variance term, so
     * getting it wrong is amplified rather than damped.
     */
    {
      id: "near-constant",
      label: "Near-constant input",
      args: [[1.0, 1.0001], [1.0, 1.0], [1.0, -1.0], 1e-5],
      visible: false,
    },
  ],
  reference: `
import numpy as np

def layer_norm_backward(x, gamma, dy, eps):
    a = np.asarray(x, dtype=float)
    g = np.asarray(gamma, dtype=float)
    d = np.asarray(dy, dtype=float)

    # Biased variance, and eps inside the root — the same conventions as the forward problem.
    mean = a.mean()
    var = a.var()
    std = np.sqrt(var + eps)
    xhat = (a - mean) / std

    # beta is added, so its gradient is the upstream gradient untouched. gamma multiplies the
    # *normalised* input, so its gradient pairs dy with xhat rather than with x.
    dbeta = d
    dgamma = d * xhat

    # Through the affine, into the normalisation.
    dxhat = d * g

    # The two correction terms are the mean and the variance paths: subtracting the mean couples
    # every element, and std is itself a function of every element. Dropping the second is the
    # classic error and it hides whenever dxhat is constant, because sum(xhat) is zero.
    dx = (dxhat - dxhat.mean() - xhat * np.mean(dxhat * xhat)) / std

    return [dx.tolist(), dgamma.tolist(), dbeta.tolist()]
`,
  template: `import numpy as np


def layer_norm_backward(x, gamma, dy, eps):
    # Return [dx, dgamma, dbeta] for y = (x - mean) / sqrt(var + eps) * gamma + beta.
    #
    # dbeta and dgamma are the easy two; note dgamma pairs dy with the *normalised*
    # input. For dx, remember that both the mean and the variance depend on every
    # element of x, so dx_i is not simply (dy_i * gamma_i) / std.
    ...
`,
};

/**
 * Online (tiled) softmax — the arithmetic at the centre of FlashAttention.
 *
 * The one problem here that is about a *systems* idea rather than a layer. Attention's softmax
 * normally needs the whole score row in memory at once; the tiled form keeps a running maximum, a
 * running denominator and a running weighted sum, so a score row of any length can be consumed a
 * block at a time and never materialised. That is the whole reason attention fits in SRAM.
 *
 * `kernel-fusion` is the concept it teaches: "merging passes to stop paying for the same memory
 * traffic twice" is precisely what this is, and it had one item before this.
 *
 * Hard because the rescaling must be **exact compensation**. When a later block raises the running
 * maximum, every quantity already accumulated was scaled by the old maximum and has to be corrected
 * by the same factor — the denominator *and* the accumulator. Correcting one and not the other leaves
 * a result that is finite, plausible, and wrong by a factor nobody can eyeball.
 */
const ONLINE_SOFTMAX: Problem = {
  id: "online-softmax",
  math:
    "m_k = \\max(m_{k-1}, \\max s^{(k)}), \\quad \\ell_k = e^{m_{k-1}-m_k}\\ell_{k-1} + \\textstyle\\sum e^{s^{(k)}-m_k}, \\quad o_k = e^{m_{k-1}-m_k} o_{k-1} + \\textstyle\\sum e^{s^{(k)}-m_k} v",
  title: "Online Softmax",
  summary:
    "Compute softmax(scores) @ values one tile at a time, never holding the whole score row. Carry three running quantities: the maximum seen so far, the denominator, and the weighted sum of values. When a tile raises the maximum, everything accumulated under the old maximum is scaled by exp(old - new) — the denominator and the accumulator, by the same factor. Rescaling one and not the other gives a finite, plausible, wrong answer. Return the output vector, values.shape[1] long.",
  entry: "online_attention",
  difficulty: "hard",
  categories: ["LLM", "CUDA"],
  allowedImports: ["numpy"],
  timeLimitMs: 400,
  memoryLimitMb: 64,
  cases: [
    {
      id: "single-tile",
      label: "One tile, no rescaling",
      args: [[1.0, 2.0], [[1.0, 0.0], [0.0, 1.0]], 2],
      visible: true,
    },
    /**
     * The other trap on display: the maximum is in the *first* tile, so every later correction factor
     * is exactly 1 and an implementation that forgets to rescale the accumulator passes.
     */
    {
      id: "max-in-first-tile",
      label: "Descending scores",
      args: [[3.0, 2.0, 1.0, 0.0], [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [2.0, 0.0]], 2],
      visible: true,
    },
    {
      id: "ragged-tile",
      label: "Length not a multiple of the tile",
      args: [[1.0, 2.0, 3.0], [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], 2],
      visible: true,
    },
    /**
     * The case the named mutant is paired with.
     *
     * The maximum arrives in the second tile, so the correction factor is `exp(0 - 5)` — small enough
     * that an unrescaled accumulator is wrong by orders of magnitude rather than in the sixth decimal.
     */
    {
      id: "tile-boundary-max-increases",
      label: "Maximum in a later tile",
      args: [[0.0, 0.0, 5.0, 0.0], [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [2.0, 2.0]], 2],
      visible: false,
    },
    /**
     * Rescaling at every step, so a partially-correct correction compounds instead of appearing once.
     * Tile width 1 is the degenerate case a tiled implementation should still satisfy.
     */
    {
      id: "every-tile-raises-max",
      label: "Ascending scores, tile of one",
      args: [
        [0.0, 1.0, 2.0, 3.0, 4.0, 5.0],
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [2.0, 0.0], [0.0, 2.0], [1.0, 2.0]],
        1,
      ],
      visible: false,
    },
    /**
     * Isolates the reason the running maximum exists at all. `exp(900)` is `inf` in float64, so an
     * implementation that exponentiates the raw scores returns `nan` here and nothing else catches it —
     * every other case has scores small enough to survive naive exponentiation.
     */
    {
      id: "overflow-without-the-max",
      label: "Scores that overflow exp",
      args: [[800.0, 900.0], [[1.0, 0.0], [0.0, 1.0]], 1],
      visible: false,
    },
  ],
  reference: `
import numpy as np

def online_attention(scores, values, tile):
    s = np.asarray(scores, dtype=float)
    v = np.asarray(values, dtype=float)

    running_max = -np.inf
    denominator = 0.0
    accumulator = np.zeros(v.shape[1], dtype=float)

    for start in range(0, s.shape[0], tile):
        block_scores = s[start : start + tile]
        block_values = v[start : start + tile]

        new_max = max(running_max, float(block_scores.max()))
        # exp(-inf) is 0.0, which is what the first block wants: there is nothing to carry.
        correction = float(np.exp(running_max - new_max))

        weights = np.exp(block_scores - new_max)
        # Both carried quantities, by the same factor. This is the whole problem.
        denominator = denominator * correction + float(weights.sum())
        accumulator = accumulator * correction + weights @ block_values
        running_max = new_max

    return (accumulator / denominator).tolist()
`,
  template: `import numpy as np


def online_attention(scores, values, tile):
    # softmax(scores) @ values, computed one tile at a time.
    #
    # Carry three things across tiles: the maximum seen so far, the denominator, and
    # the weighted sum of values. When a tile raises the maximum, correct what you
    # have already accumulated by exp(old_max - new_max) — all of it.
    ...
`,
};

const PROBLEMS: readonly Problem[] = [
  STABLE_SOFTMAX,
  CROSS_ENTROPY,
  LAYER_NORM,
  SGD_MOMENTUM,
  ATTENTION,
  TOP_P,
  BPE_MERGE,
  IOU_NMS,
  BROADCAST,
  BATCHNORM,
  PARALLEL_REDUCTION,
  THREAD_INDEX,
  SIGMOID,
  MIN_MAX,
  // Appended, not inserted. `renderer/src/lib/curriculum.ts` mirrors this order and the workspace
  // resolves `/problems/9` by position, so inserting in the middle silently renumbers every problem
  // after it — which has already happened once, and opened the wrong problem successfully.
  LAYER_NORM_BACKWARD,
  ONLINE_SOFTMAX,
];

/**
 * Lookup covers the interview problems; the catalogue does not.
 *
 * Both halves are needed and they are different questions. `getProblem` answers "can this
 * id be graded?", which must include an interview question's executable form — the grader,
 * the workspace and `hasWorkspace` all go through it. `listProblems` answers "what is in
 * the curriculum?", and folding the interview problems into it would multiply the syllabus by
 * roughly four, double-count them on the dashboard, and put whiteboard exercises in a list that is
 * meant to be a course. (Exact counts deliberately absent — `tests/content-census.test.ts` owns
 * them. This sentence read "38 … into a 52-problem one" long after both numbers had moved.)
 *
 * The import is one-directional: `interview-problems.ts` imports only the `Problem` *type*
 * from here, so there is no runtime cycle.
 */
const BY_ID = new Map(
  [...PROBLEMS, ...INTERVIEW_PROBLEMS.map((ip) => ip.problem)].map((p) => [p.id, p])
);

export function getProblem(id: string): Problem | undefined {
  // Map, not object indexing: `id` arrives from the renderer, and `"__proto__"`
  // resolves through an object literal's prototype chain — the same bug the IPC
  // broker's gate 1 had.
  return BY_ID.get(id);
}

/**
 * What the renderer is allowed to see.
 *
 * Omits `reference` entirely, and omits the arguments of hidden cases. A learner
 * should know a hidden case exists — that is honest, and "4 tests, 3 shown" is
 * useful information — without being handed the input it checks.
 */
export interface PublicProblem {
  id: string;
  title: string;
  summary: string;
  entry: string;
  difficulty: Problem["difficulty"];
  categories: string[];
  allowedImports: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  template: string;
  /**
   * The definition, as LaTeX. Unlike `reference`, this is safe to expose: it is what the
   * learner is being asked to implement, not the answer to how.
   *
   * It was missing here while `toPublic` already spread it in — a conditional spread is not
   * subject to excess-property checking, so the field was silently dropped and nothing
   * complained.
   */
  math?: string;
  cases: Array<{ id: string; label: string; visible: boolean; args?: unknown[] }>;
}

export function toPublic(problem: Problem): PublicProblem {
  return {
    id: problem.id,
    title: problem.title,
    summary: problem.summary,
    entry: problem.entry,
    difficulty: problem.difficulty,
    categories: problem.categories,
    allowedImports: problem.allowedImports,
    timeLimitMs: problem.timeLimitMs,
    memoryLimitMb: problem.memoryLimitMb,
    template: problem.template,
    // Carried into the public projection: the definition is what the learner is asked to
    // implement, so unlike `reference` there is nothing to withhold.
    ...(problem.math !== undefined ? { math: problem.math } : {}),
    cases: problem.cases.map((c) =>
      c.visible
        ? { id: c.id, label: c.label, visible: true, args: c.args }
        : { id: c.id, label: c.label, visible: false }
    ),
  };
}

export function listProblems(): PublicProblem[] {
  return PROBLEMS.map(toPublic);
}
