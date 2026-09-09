/**
 * The porting gate's table, as data.
 *
 * Split out of `verify-curriculum.ts` for one concrete reason: that module imports
 * `verifyAgainstSpecs`, which imports the grader, which reaches Electron's `utilityProcess`. So the
 * table could not be read by anything outside a running app — including the catalogue export that
 * feeds the Python reward harness, whose whole purpose is to check a second grader against this
 * one using exactly these correct-variants and mutants.
 *
 * `verify-interview-specs.ts` was already shaped this way. This makes the two halves symmetric:
 * both spec tables are now plain data behind a type-only import, and both verifiers are three lines
 * that run them. Nothing about the specs themselves changed.
 *
 * See `verify-interview-specs.ts` for how to write one — `correct` is an independent second
 * implementation rather than a paraphrase, and a mutant names the case that must reject it.
 */
import type { Spec } from "./verify-spec.js";

export const CURRICULUM_SPECS: Record<string, Spec> = {
  "top-p-sampling": {
    correct: `
import numpy as np

def top_p(probs, p):
    order = np.argsort([-x for x in probs], kind="stable")
    total, kept = 0.0, []
    for i in order:
        kept.append(int(i))
        total += probs[int(i)]
        if total >= p:
            break
    return sorted(kept)
`,
    mutants: [
      [
        "unsorted traversal",
        `
def top_p(probs, p):
    total, kept = 0.0, []
    for i, x in enumerate(probs):
        kept.append(i)
        total += x
        if total >= p:
            break
    return sorted(kept)
`,
        "unsorted",
      ],
    ],
    seed: { confident: "[0, 1]", "float-boundary": "[0, 1, 2, 3]", uniform: "[0, 1]" },
  },

  "bpe-merge": {
    correct: `
from collections import Counter

def bpe_merge(tokens):
    if len(tokens) < 2:
        return list(tokens)
    pairs = [(tokens[i], tokens[i + 1]) for i in range(len(tokens) - 1)]
    counts = Counter(pairs)
    best = max(counts, key=lambda pr: (counts[pr], -pairs.index(pr)))
    out, i = [], 0
    while i < len(tokens):
        if i + 1 < len(tokens) and (tokens[i], tokens[i + 1]) == best:
            out.append(tokens[i] + tokens[i + 1])
            i += 2
        else:
            out.append(tokens[i])
            i += 1
    return out
`,
    mutants: [
      // Advances by one after a merge, so the pair can overlap itself.
      [
        "overlapping replacement",
        `
from collections import Counter

def bpe_merge(tokens):
    if len(tokens) < 2:
        return list(tokens)
    pairs = [(tokens[i], tokens[i + 1]) for i in range(len(tokens) - 1)]
    counts = Counter(pairs)
    best = max(counts, key=lambda pr: (counts[pr], -pairs.index(pr)))
    out, i = [], 0
    while i < len(tokens):
        if i + 1 < len(tokens) and (tokens[i], tokens[i + 1]) == best:
            out.append(tokens[i] + tokens[i + 1])
            i += 1
        else:
            out.append(tokens[i])
            i += 1
    return out
`,
        "overlapping",
      ],
    ],
  },

  "iou-nms": {
    correct: `
def nms(boxes, scores, threshold):
    def overlap(a, b):
        w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = w * h
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / ua if ua > 0 else 0.0

    remaining = sorted(range(len(boxes)), key=lambda i: (-scores[i], i))
    keep = []
    while remaining:
        top = remaining.pop(0)
        keep.append(top)
        remaining = [i for i in remaining if overlap(boxes[top], boxes[i]) <= threshold]
    return sorted(keep)
`,
    mutants: [
      // No clamp: two negative sides multiply to a positive "intersection".
      [
        "unclamped intersection",
        `
def nms(boxes, scores, threshold):
    def overlap(a, b):
        w = min(a[2], b[2]) - max(a[0], b[0])
        h = min(a[3], b[3]) - max(a[1], b[1])
        inter = w * h
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / ua if ua > 0 else 0.0

    remaining = sorted(range(len(boxes)), key=lambda i: (-scores[i], i))
    keep = []
    while remaining:
        top = remaining.pop(0)
        keep.append(top)
        remaining = [i for i in remaining if overlap(boxes[top], boxes[i]) <= threshold]
    return sorted(keep)
`,
        "touching",
      ],
    ],
    seed: { "one-duplicate": "[0, 2]", identical: "[0]", partial: "[0]" },
  },

  "broadcast-shapes": {
    correct: `
def broadcast(shape_a, shape_b):
    a, b = list(reversed(shape_a)), list(reversed(shape_b))
    out = []
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else 1
        y = b[i] if i < len(b) else 1
        if x == y or y == 1:
            out.append(x)
        elif x == 1:
            out.append(y)
        else:
            return []
    return list(reversed(out))
`,
    mutants: [
      // Truthiness rather than == 1, so a zero-length dimension acts as a wildcard.
      [
        "truthiness instead of equality",
        `
def broadcast(shape_a, shape_b):
    a, b = list(reversed(shape_a)), list(reversed(shape_b))
    out = []
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else 1
        y = b[i] if i < len(b) else 1
        if x == y:
            out.append(x)
        elif not x or x == 1:
            out.append(y)
        elif not y or y == 1:
            out.append(x)
        else:
            return []
    return list(reversed(out))
`,
        "zero-dim",
      ],
    ],
    seed: { "stretch-both": "[3, 4, 5]", trailing: "[256, 256, 3]", incompatible: "[]" },
  },

  "batchnorm-inference": {
    correct: `
import math

def batch_norm(x, running_mean, running_var, gamma, beta, eps):
    out = []
    for row in x:
        out.append([
            (v - m) / math.sqrt(s + eps) * g + b
            for v, m, s, g, b in zip(row, running_mean, running_var, gamma, beta)
        ])
    return out
`,
    mutants: [
      // LayerNorm's axis: statistics from each row rather than from the buffers. This is
      // the confusion the problem exists to settle.
      [
        "per-row statistics",
        `
import math

def batch_norm(x, running_mean, running_var, gamma, beta, eps):
    out = []
    for row in x:
        m = sum(row) / len(row)
        v = sum((t - m) ** 2 for t in row) / len(row)
        out.append([
            (t - m) / math.sqrt(v + eps) * g + b for t, g, b in zip(row, gamma, beta)
        ])
    return out
`,
        "per-feature",
      ],
    ],
  },

  /**
   * ── THE TWO HARD PROBLEMS ───────────────────────────────────────────────────────────────────
   *
   * No `seed` on either, deliberately: a seed is a cross-check against values an earlier source
   * shipped, and there is no upstream left to agree with. What replaces it is stronger — a correct
   * solution written a completely different way, which for both of these is not a paraphrase but a
   * different algorithm reaching the same number.
   */

  "layer-norm-backward": {
    /**
     * The n-form, in pure Python, with no numpy at all.
     *
     * Different in every respect that could hide a shared mistake: `(n*dxhat - sum - xhat*proj)/(n*std)`
     * rather than the mean-form the reference uses, list comprehensions rather than vectorised
     * arithmetic, and `sum(...)` rather than `.mean()`. If both agree on six cases the algebra is right.
     */
    correct: `
def layer_norm_backward(x, gamma, dy, eps):
    n = len(x)
    mean = sum(x) / n
    var = sum((xi - mean) ** 2 for xi in x) / n
    std = (var + eps) ** 0.5
    xhat = [(xi - mean) / std for xi in x]

    dbeta = [float(d) for d in dy]
    dgamma = [dy[i] * xhat[i] for i in range(n)]
    dxhat = [dy[i] * gamma[i] for i in range(n)]

    total = sum(dxhat)
    projected = sum(dxhat[i] * xhat[i] for i in range(n))
    dx = [(n * dxhat[i] - total - xhat[i] * projected) / (n * std) for i in range(n)]

    return [dx, dgamma, dbeta]
`,
    mutants: [
      /**
       * The error the problem exists for: treating `std` as a constant with respect to `x`, so the
       * term coming from its dependence on the input is missing. Everything else — `dgamma`, `dbeta`,
       * the mean-subtraction — is correct, which is what makes it survive casual testing.
       *
       * Paired with `variance-path` rather than any hidden case, because `uniform-upstream` and every
       * other constant-`dxhat` input accepts it: `sum(xhat)` is zero, so the missing term is zero too.
       */
      [
        "variance path dropped",
        `
import numpy as np

def layer_norm_backward(x, gamma, dy, eps):
    a = np.asarray(x, dtype=float)
    g = np.asarray(gamma, dtype=float)
    d = np.asarray(dy, dtype=float)

    mean = a.mean()
    std = np.sqrt(a.var() + eps)
    xhat = (a - mean) / std
    dxhat = d * g

    dx = (dxhat - dxhat.mean()) / std

    return [dx.tolist(), (d * xhat).tolist(), d.tolist()]
`,
        "variance-path",
      ],
    ],
  },

  "online-softmax": {
    /**
     * The two-pass form, which is what tiling exists to avoid.
     *
     * That makes it the ideal independent check rather than a weaker one: it materialises the entire
     * score row, takes one global maximum, and does a single normalisation. Agreement across all six
     * cases — including one whose scores overflow `exp` and one tiled a single element at a time — is
     * the claim that the running-maximum arithmetic is exactly equivalent. `tile` is unused here on
     * purpose; the contract is the output value, not how it got there.
     */
    correct: `
import numpy as np

def online_attention(scores, values, tile):
    s = np.asarray(scores, dtype=float)
    v = np.asarray(values, dtype=float)
    weights = np.exp(s - s.max())
    return ((weights / weights.sum()) @ v).tolist()
`,
    mutants: [
      /**
       * The denominator is corrected and the accumulator is not.
       *
       * Chosen over "no rescaling at all" because this is the version that survives review: the
       * result is finite and the same shape, the softmax weights still sum to one, and only the
       * output magnitude is wrong.
       *
       * Measured in the sandbox rather than reasoned about, and the reasoning was half wrong. It
       * passes 2 of 6: `single-tile`, where there is no second tile, and `max-in-first-tile`, where
       * every correction is exactly 1. It **fails `ragged-tile`**, which is visible — so a learner
       * making this mistake finds out before submitting, which is better for them than the prediction
       * that only hidden cases would catch it. `tile-boundary-max-increases` remains the case paired
       * with it here because it isolates the error most sharply: the correction is `exp(-5)`, so the
       * answer is wrong by orders of magnitude rather than in the third decimal.
       */
      [
        "denominator rescaled, accumulator not",
        `
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
        correction = float(np.exp(running_max - new_max))
        weights = np.exp(block_scores - new_max)

        denominator = denominator * correction + float(weights.sum())
        accumulator = accumulator + weights @ block_values
        running_max = new_max

    return (accumulator / denominator).tolist()
`,
        "tile-boundary-max-increases",
      ],
    ],
  },
};
