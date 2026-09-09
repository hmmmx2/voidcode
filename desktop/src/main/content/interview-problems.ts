/**
 * The executable form of the interview questions — the workspace half.
 *
 * THIS FILE IS THE SOURCE OF TRUTH. Edit it directly — see `interview-bank.ts` and
 * `docs/DECISIONS.md` (D0).
 *
 * It was ported from `apps/api/scripts/interview_problems.py` and its reference solutions, and
 * the four notes below are why re-porting is not an option: this is a *corrected* copy, not a
 * transcription, and every correction is one that failed silently the first time.
 *
 * FOUR THINGS CHANGED SHAPE ON THE WAY ACROSS, AND EVERY ONE OF THEM FAILED SILENTLY FIRST.
 *
 * 1. The web called these through a per-problem driver reading `stdin`, so the API's
 *    `inputs` field is *display metadata* — wrong arity for 47 cases, values like
 *    "25 layers of 0.9". The real arguments were recovered by executing each driver and
 *    recording what the method was actually called with.
 *
 * 2. Every solution was a `class Solution` with a method. The sandbox calls a top-level
 *    function, so both reference and template are dedented into one — which also matches
 *    the curriculum problems, where the learner writes a plain function. Twelve references
 *    open with `import math` above the class, and three call helpers through `self.`;
 *    dropping either produced a `NameError` on the first real call, not at conversion time.
 *
 * 3. Each driver ended by printing a *transformed* result. That transform is the problem's
 *    own statement of what counts as equal, and calling the entry directly discarded it.
 *    It is carried as `normalise` and applied to the reference and the learner alike.
 *    `matrix-calculus-backprop` prints three times, one per component of its returned
 *    tuple: reading only the last print dropped two of three matrices from grading.
 *
 * 4. `expectedOutput` appears nowhere, here or on the wire. The catalogue ships its
 *    expectations so a learner can see what a passing run looks like; an interview screen
 *    does not work that way. You write against the spec and find out on submit — the same
 *    reason the model answer is not in the question payload.
 *
 * The conversion is checked, not assumed: `verify-interviews.ts` re-derives every answer
 * key in the real sandbox and compares it against the values the web shipped.
 */

import type { Problem } from "./problems.js";

/**
 * A question's executable form: what the grader needs, plus the statement the workspace
 * shows.
 *
 * Split because the two have different rules. `problem` holds the reference and must never
 * reach the renderer intact. `statement` is authored prose, shown verbatim — including its
 * examples, which unlike the curriculum route are *not* derived from executing the
 * reference, because deriving them would print the answers to the test cases on the page.
 */
export interface InterviewProblem {
  questionSlug: string;
  problem: Problem;
  /**
   * What this reference produced in the sandbox, recorded when the item was authored.
   *
   * Regression detection for content the frozen answer key does not cover: without a committed
   * value, "the reference's output changed" is unnoticeable. Produce it with
   * `VOIDCODE_DERIVE=<problem id>` rather than by hand — see `verify-interviews.ts`.
   *
   * **On the wrapper, deliberately, and never on `Problem`.** `exec/grader.ts` imports only
   * `type { Problem }`, so from there this field does not exist — which makes "the grader cannot
   * grade against a hand-typed value" a structural fact rather than a rule someone has to
   * remember. §2.6 is the reason: an answer key is always derived by executing the reference. One
   * field access is all the distance there would be if this lived a level down.
   */
  derivedKey?: string[];
  statement: {
    orderIndex: number;
    description: string;
    examples: Array<{ input: string; output: string; explanation?: string }>;
    constraints: string[];
    hints: string[];
    /** Parameter names, positional. Labels the case inputs the workspace shows. */
    params: string[];
  };
}

export const INTERVIEW_PROBLEMS: readonly InterviewProblem[] = [
  {
    questionSlug: "implement-auc",
    problem: {
      id: "iq-implement-auc",
      title: "Compute ROC-AUC on a whiteboard",
      summary: "Given `y_true` (0/1 labels) and `y_score` (any real-valued scores, higher meaning more positive), return the ROC-AUC.",
      entry: "roc_auc",
      difficulty: "medium",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "None if _r is None else round(float(_r), 6)",
      cases: [
        { id: "iq-implement-auc-0", label: "Case 1", visible: true, args: [[0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]] },
        { id: "iq-implement-auc-1", label: "Case 2", visible: true, args: [[0, 1], [0.5, 0.5]] },
        { id: "iq-implement-auc-2", label: "Hidden 1", visible: false, args: [[0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]] },
        { id: "iq-implement-auc-3", label: "Hidden 2", visible: false, args: [[1, 0, 1, 0, 1, 0], [0.5, 0.5, 0.5, 0.2, 0.9, 0.9]] },
        { id: "iq-implement-auc-4", label: "Hidden 3", visible: false, args: [[1, 1, 1], [0.2, 0.5, 0.9]] },
      ],
      reference: `
def roc_auc(y_true, y_score):
    n = len(y_true)
    n_pos = sum(1 for y in y_true if y == 1)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return None

    # Rank by score, averaging ranks across ties.
    order = sorted(range(n), key=lambda i: y_score[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and y_score[order[j + 1]] == y_score[order[i]]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = average
        i = j + 1

    rank_sum = sum(ranks[i] for i in range(n) if y_true[i] == 1)
    return (rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)
`,
      template: `
def roc_auc(y_true, y_score):
    """
    :type y_true: List[int]
    :type y_score: List[float]
    :rtype: float | None
    """
`,
    },
    /**
     * One snapshot, kept deliberately even though the frozen key already covers this item.
     *
     * It makes the audit path live: `npm run derive` with no id checks every recorded snapshot, and
     * with none recorded it has nothing to check and says so. Keeping one means the runner is
     * exercised rather than theoretical, and it is a worked example of the shape for whoever
     * authors the next item.
     *
     * Produced by `VOIDCODE_DERIVE=iq-implement-auc`, not typed. The last value being `None` is the
     * same fact `verify-vacuity.ts` reports independently — that case is satisfied by a stub.
     */
    derivedKey: ["0.75", "0.5", "1.0", "0.611111", "None"],
    statement: {
      orderIndex: 1,
      description: "Given `y_true` (0/1 labels) and `y_score` (any real-valued scores, higher meaning more positive), return the ROC-AUC.\n\n**Do not build the curve.** Do not sweep thresholds. There is a closed form that needs one sort, and finding it is the question.\n\nAUC is the probability that a randomly chosen positive scores above a randomly chosen negative, with ties counting as half. Written that way it is a rank statistic, and the Mann-Whitney U identity gives it to you directly:\n\n`AUC = (sum of ranks of positives - n_pos(n_pos + 1) / 2) / (n_pos * n_neg)`\n\n**Ties matter.** Equal scores must share the average of the ranks they span, or every tied model is scored wrongly. Constant-score predictions should give exactly 0.5, and that is one of the tests.\n\nReturn the value rounded to 6 decimal places. If either class is absent, AUC is undefined — return `None`.",
      examples: [
        { input: "y_true = [0, 0, 1, 1], y_score = [0.1, 0.4, 0.35, 0.8]", output: "0.75", explanation: "Three of the four positive/negative pairs are ordered correctly; (0.4, 0.35) is not. 3/4 = 0.75." },
        { input: "y_true = [0, 1], y_score = [0.5, 0.5]", output: "0.5", explanation: "A tie counts as half, so a constant score gives 0.5." },
      ],
      constraints: ["1 <= len(y_true) == len(y_score) <= 10^4", "y_true[i] is 0 or 1", "Return None if either class is missing.", "Ties share the average rank.", "Round to 6 decimal places.", "Standard library only -- no numpy, no sklearn."],
      hints: [],
      params: ["y_true", "y_score"],
    },
  },
  {
    questionSlug: "implement-adam-update",
    problem: {
      id: "iq-implement-adam-update",
      title: "One Adam step, from memory",
      summary: "Write a single Adam update. You are given the current parameters, their gradients, the first and second moment buffers, and the step number `t` (1-based, already incremented for this step).",
      entry: "adam_step",
      difficulty: "medium",
      categories: ["DL", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[[round(float(x), 6) for x in row] for row in _r]",
      cases: [
        { id: "iq-implement-adam-update-0", label: "Case 1", visible: true, args: [[1.0], [0.1], [0.0], [0.0], 1, 0.01, 0.9, 0.999, 1e-08] },
        { id: "iq-implement-adam-update-1", label: "Case 2", visible: true, args: [[1.0, -2.0], [0.5, -0.5], [0.2, -0.1], [0.04, 0.02], 3, 0.001, 0.9, 0.999, 1e-08] },
        { id: "iq-implement-adam-update-2", label: "Hidden 1", visible: false, args: [[5.0], [0.0], [0.3], [0.09], 10, 0.01, 0.9, 0.999, 1e-08] },
        { id: "iq-implement-adam-update-3", label: "Hidden 2", visible: false, args: [[0.5], [0.2], [0.15], [0.03], 10000, 0.01, 0.9, 0.999, 1e-08] },
      ],
      reference: `
import math

def adam_step(params, grads, m, v, t, lr, b1, b2, eps):
    out_p, out_m, out_v = [], [], []
    for p, g, mi, vi in zip(params, grads, m, v):
        mi = b1 * mi + (1 - b1) * g
        vi = b2 * vi + (1 - b2) * g * g
        m_hat = mi / (1 - b1 ** t)
        v_hat = vi / (1 - b2 ** t)
        p = p - lr * m_hat / (math.sqrt(v_hat) + eps)
        out_p.append(p)
        out_m.append(mi)
        out_v.append(vi)
    return [out_p, out_m, out_v]
`,
      template: `
import math

def adam_step(params, grads, m, v, t, lr, b1, b2, eps):
    """
    :rtype: List[List[float]]  -- [params, m, v]
    """
`,
    },
    statement: {
      orderIndex: 2,
      description: "Write a single Adam update. You are given the current parameters, their gradients, the first and second moment buffers, and the step number `t` (1-based, already incremented for this step).\n\nReturn `[params, m, v]` after the step, each rounded to 6 decimals.\n\n**Bias correction is the question.** `m` and `v` start at zero, so early estimates are biased toward zero — at `t = 1` with the usual betas, `m` is only 10% of the gradient and `v` is 0.1% of its square. Dividing by `1 - beta^t` undoes exactly that. Omitting it gives a first step that is far too small, and the error decays over hundreds of steps rather than disappearing.\n\nThe update is:\n\n```\nm = b1*m + (1-b1)*g\nv = b2*v + (1-b2)*g*g\nm_hat = m / (1 - b1**t)\nv_hat = v / (1 - b2**t)\np -= lr * m_hat / (sqrt(v_hat) + eps)\n```\n\n**Return the uncorrected `m` and `v`**, not the hatted ones — the buffers that carry to the next step are the raw moments. Returning the corrected values compounds the correction and is the most common way this is written wrongly.",
      examples: [
        { input: "params = [1.0], grads = [0.1], m = [0.0], v = [0.0], t = 1, lr = 0.01", output: "[[0.99], [0.01], [1e-05]]", explanation: "At t=1 bias correction makes m_hat equal g exactly, so the step is almost exactly lr regardless of the gradient's size." },
      ],
      constraints: ["1 <= len(params) == len(grads) == len(m) == len(v) <= 10^3", "t >= 1", "Return [params, m, v] with the UNCORRECTED moments.", "Round every value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["params", "grads", "m", "v", "t", "lr", "b1", "b2", "eps"],
    },
  },
  {
    questionSlug: "implement-grad-clip",
    problem: {
      id: "iq-implement-grad-clip",
      title: "Clip gradients by global norm",
      summary: "Given a list of gradient tensors (each a flat list of floats) and a `max_norm`, clip them **by global norm** and return the result, each value rounded to 6 decimals.",
      entry: "clip_grad_norm",
      difficulty: "easy",
      categories: ["DL", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[[round(float(x), 6) for x in t] for t in _r]",
      cases: [
        { id: "iq-implement-grad-clip-0", label: "Case 1", visible: true, args: [[[3.0, 4.0]], 5.0] },
        { id: "iq-implement-grad-clip-1", label: "Case 2", visible: true, args: [[[3.0, 4.0]], 1.0] },
        { id: "iq-implement-grad-clip-2", label: "Hidden 1", visible: false, args: [[[3.0], [4.0], [12.0]], 6.5] },
        { id: "iq-implement-grad-clip-3", label: "Hidden 2", visible: false, args: [[[0.0, 0.0]], 1.0] },
        { id: "iq-implement-grad-clip-4", label: "Hidden 3", visible: false, args: [[], 1.0] },
      ],
      reference: `
import math

def clip_grad_norm(grads, max_norm):
    total = math.sqrt(sum(g * g for t in grads for g in t))
    if total <= max_norm or total == 0.0:
        return [list(t) for t in grads]
    scale = max_norm / total
    return [[g * scale for g in t] for t in grads]
`,
      template: `
import math

def clip_grad_norm(grads, max_norm):
    """
    :type grads: List[List[float]]
    :rtype: List[List[float]]
    """
`,
    },
    statement: {
      orderIndex: 3,
      description: "Given a list of gradient tensors (each a flat list of floats) and a `max_norm`, clip them **by global norm** and return the result, each value rounded to 6 decimals.\n\nThe global norm is the L2 norm over *every* element of *every* tensor, as if they were one long vector:\n\n`total = sqrt(sum(g*g for tensor in grads for g in tensor))`\n\nIf `total <= max_norm`, return the gradients unchanged. Otherwise scale **every** tensor by the same factor `max_norm / total`.\n\n**One scale factor for all of them is the whole point.** Clipping each tensor to its own norm, or clamping element-wise, changes the direction of the update — you are no longer descending the gradient, you are descending something else that happens to be shorter. Scaling by a single scalar preserves direction exactly and only shortens the step.\n\nReturn `[]` for an empty input, and treat a total norm of exactly 0 as nothing to do.",
      examples: [
        { input: "grads = [[3.0, 4.0]], max_norm = 5.0", output: "[[3.0, 4.0]]", explanation: "The norm is exactly 5.0, which is not above the limit, so nothing changes." },
        { input: "grads = [[3.0, 4.0]], max_norm = 1.0", output: "[[0.6, 0.8]]", explanation: "Norm 5.0 scaled by 1/5 — same direction, length 1." },
      ],
      constraints: ["0 <= number of tensors <= 100", "max_norm > 0", "Scale ALL tensors by one factor, or not at all.", "Round to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["grads", "max_norm"],
    },
  },
  {
    questionSlug: "derive-logistic-gradient",
    problem: {
      id: "iq-derive-logistic-gradient",
      title: "Gradient of the logistic log-loss",
      summary: "Implement `logistic_grad(X, y, w, b, l2)`, returning the gradient of",
      entry: "logistic_grad",
      difficulty: "medium",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-derive-logistic-gradient-0", label: "Case 1", visible: true, args: [[[1.0], [2.0]], [1, 0], [0.0], 0.0, 0.0] },
        { id: "iq-derive-logistic-gradient-1", label: "Case 2", visible: true, args: [[[1.0, 0.0], [0.0, 1.0]], [1, 0], [0.5, -0.5], 0.0, 0.1] },
        { id: "iq-derive-logistic-gradient-2", label: "Hidden 1", visible: false, args: [[[-1000.0], [1.0]], [0, 1], [1.0], 0.0, 0.0] },
        { id: "iq-derive-logistic-gradient-3", label: "Hidden 2", visible: false, args: [[[1.0]], [1], [0.0], 2.0, 0.5] },
        { id: "iq-derive-logistic-gradient-4", label: "Hidden 3", visible: false, args: [[[1.0, 2.0], [1.0, -1.0], [0.0, 3.0]], [1, 0, 1], [0.2, -0.3], 0.1, 0.0] },
      ],
      reference: `
import math

def logistic_grad(X, y, w, b, l2):
    n = len(X)
    d = len(w)
    gw = [0.0] * d
    gb = 0.0
    for xi, yi in zip(X, y):
        z = b
        for j in range(d):
            z += w[j] * xi[j]
        # Branch-stable sigmoid: neither exp() argument is ever positive.
        if z >= 0.0:
            p = 1.0 / (1.0 + math.exp(-z))
        else:
            e = math.exp(z)
            p = e / (1.0 + e)
        r = p - yi
        for j in range(d):
            gw[j] += r * xi[j]
        gb += r
    out = [gw[j] / n + l2 * w[j] for j in range(d)]
    out.append(gb / n)
    return out
`,
      template: `
import math

def logistic_grad(X, y, w, b, l2):
    """
    :type X: List[List[float]]  -- N rows of d features
    :type y: List[int]          -- 0/1 labels, length N
    :type w: List[float]        -- d weights
    :type b: float              -- bias
    :type l2: float             -- L2 strength, on w only
    :rtype: List[float]         -- d weight grads, then the bias grad
    """
`,
    },
    statement: {
      orderIndex: 4,
      description: "Implement `logistic_grad(X, y, w, b, l2)`, returning the gradient of\n\n```\nL = (1/N) * sum_i -[ y_i*log(p_i) + (1-y_i)*log(1-p_i) ]  +  (l2/2) * sum_j w_j^2\n```\n\nwhere `z_i = w . x_i + b` and `p_i = sigmoid(z_i) = 1/(1+exp(-z_i))`.\n\n**Return a flat list of length d+1**: the partial derivatives with respect to `w[0]..w[d-1]`, followed by the partial derivative with respect to `b`. Round every value to 6 decimal places.\n\nThe derivation collapses because `sigmoid'(z) = p(1-p)`, which cancels the `1/(p(1-p))` that falls out of the log term. What survives is a plain residual:\n\n```\ndL/dw_j = (1/N) * sum_i (p_i - y_i) * x_ij  +  l2 * w_j\ndL/db   = (1/N) * sum_i (p_i - y_i)\n```\n\n**Two things to get right.**\n\n1. **The bias is not penalised.** `l2 * w_j` is added to the weight gradients only. Adding `l2 * b` to the bias gradient is wrong: penalising the intercept makes the fit depend on where you happened to put the origin.\n2. **Do not overflow.** `1/(1+exp(-z))` raises `OverflowError` once `z` drops below about -710, and real feature scales reach that. Branch on the sign: use `1/(1+exp(-z))` when `z >= 0`, and `exp(z)/(1+exp(z))` when `z < 0`. Both are algebraically the same function; only one of them is safe at each end.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "X = [[1.0], [2.0]], y = [1, 0], w = [0.0], b = 0.0, l2 = 0.0", output: "[0.25, 0.0]", explanation: "Both logits are 0, so p = 0.5 for each row and the residuals are -0.5 and +0.5. dL/dw = (-0.5*1.0 + 0.5*2.0)/2 = 0.25, and the residuals cancel in the bias term, giving 0.0." },
        { input: "X = [[1.0, 0.0], [0.0, 1.0]], y = [1, 0], w = [0.5, -0.5], b = 0.0, l2 = 0.1", output: "[-0.13877, 0.13877, 0.0]", explanation: "p = (0.622459, 0.377541), so the residuals are -0.377541 and +0.377541. Each feature is active in one row only: dL/dw0 = -0.377541/2 + 0.1*0.5 = -0.13877, mirrored for w1. The bias gradient stays 0.0 because the residuals cancel -- and no 0.1*b term is added to it." },
      ],
      constraints: ["1 <= N <= 10^4, 1 <= d <= 100", "y[i] is 0 or 1", "l2 >= 0; the penalty applies to w only, never to b", "|z| may exceed 700 -- the sigmoid must not overflow", "Return d+1 values: the d weight gradients, then the bias gradient.", "Round every value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["X", "y", "w", "b", "l2"],
    },
  },
  {
    questionSlug: "compute-metrics-from-confusion",
    problem: {
      id: "iq-compute-metrics-from-confusion",
      title: "Score a classifier from four raw counts",
      summary: "Implement `confusion_metrics(n, n_pos, n_flagged, n_tp)`.",
      entry: "confusion_metrics",
      difficulty: "easy",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-compute-metrics-from-confusion-0", label: "Case 1", visible: true, args: [10000, 100, 180, 80] },
        { id: "iq-compute-metrics-from-confusion-1", label: "Case 2", visible: true, args: [10, 8, 5, 5] },
        { id: "iq-compute-metrics-from-confusion-2", label: "Hidden 1", visible: false, args: [100, 10, 0, 0] },
        { id: "iq-compute-metrics-from-confusion-3", label: "Hidden 2", visible: false, args: [5, 0, 1, 0] },
        { id: "iq-compute-metrics-from-confusion-4", label: "Hidden 3", visible: false, args: [4, 2, 2, 2] },
      ],
      reference: `
def confusion_metrics(n, n_pos, n_flagged, n_tp):
    tp = n_tp
    fp = n_flagged - n_tp
    fn = n_pos - n_tp
    tn = n - tp - fp - fn
    accuracy = (tp + tn) / float(n)
    precision = tp / float(tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / float(tp + fn) if (tp + fn) > 0 else 0.0
    if precision + recall > 0.0:
        f1 = 2.0 * precision * recall / (precision + recall)
    else:
        f1 = 0.0
    baseline = max(n_pos, n - n_pos) / float(n)
    return [accuracy, precision, recall, f1, baseline]
`,
      template: `
def confusion_metrics(n, n_pos, n_flagged, n_tp):
    """
    :type n: int          -- total rows
    :type n_pos: int      -- rows truly positive
    :type n_flagged: int  -- rows predicted positive
    :type n_tp: int       -- rows both flagged and truly positive
    :rtype: List[float]   -- [accuracy, precision, recall, f1, baseline]
    """
`,
    },
    statement: {
      orderIndex: 5,
      description: "Implement `confusion_metrics(n, n_pos, n_flagged, n_tp)`.\n\n- `n` -- total rows\n- `n_pos` -- rows whose true label is 1\n- `n_flagged` -- rows the model predicted 1\n- `n_tp` -- rows that were both flagged and truly positive\n\nRecover the four cells first:\n\n```\nTP = n_tp\nFP = n_flagged - n_tp\nFN = n_pos - n_tp\nTN = n - TP - FP - FN\n```\n\nReturn `[accuracy, precision, recall, f1, baseline]`, each rounded to 6 decimal places:\n\n```\naccuracy  = (TP + TN) / n\nprecision = TP / (TP + FP)\nrecall    = TP / (TP + FN)\nf1        = 2 * precision * recall / (precision + recall)\nbaseline  = max(n_pos, n - n_pos) / n\n```\n\n**Empty denominators return 0.0; they do not raise.** A model that flags nothing has `TP + FP = 0`, so precision is `0.0`. An evaluation split with no positives has `TP + FN = 0`, so recall is `0.0`. If `precision + recall == 0`, F1 is `0.0`.\n\n`baseline` is the accuracy of the constant classifier that always predicts the **larger** class, and it is the number the other four should be read against. On a 1%-positive problem it is 0.99, so a model reporting 0.988 accuracy is losing to a classifier that does nothing at all -- which is the entire reason accuracy is the wrong headline metric on an imbalanced problem.\n\nStandard library only -- no numpy, no sklearn.",
      examples: [
        { input: "n = 10000, n_pos = 100, n_flagged = 180, n_tp = 80", output: "[0.988, 0.444444, 0.8, 0.571429, 0.99]", explanation: "TP=80, FP=100, FN=20, TN=9800. Accuracy is 9880/10000 = 0.988, which is below the 0.99 baseline even though the model catches 4 out of every 5 frauds." },
        { input: "n = 10, n_pos = 8, n_flagged = 5, n_tp = 5", output: "[0.7, 1.0, 0.625, 0.769231, 0.8]", explanation: "Here the positives are the majority, so the baseline is 8/10 = 0.8. Every flag was correct (precision 1.0) but three positives were missed, and 0.7 accuracy still loses to always predicting the positive class." },
      ],
      constraints: ["1 <= n <= 10^7", "0 <= n_tp <= min(n_pos, n_flagged)", "0 <= n_pos <= n and 0 <= n_flagged <= n", "An undefined precision, recall or F1 is 0.0, not an error.", "baseline is the majority class rate, which may be the positive class.", "Round each of the five values to 6 decimal places.", "Standard library only -- no numpy, no sklearn."],
      hints: [],
      params: ["n", "n_pos", "n_flagged", "n_tp"],
    },
  },
  {
    questionSlug: "bayes-optimal-threshold",
    problem: {
      id: "iq-bayes-optimal-threshold",
      title: "Threshold a calibrated score by cost",
      summary: "Implement `threshold_and_cost(probs, c_fn, c_fp)`.",
      entry: "threshold_and_cost",
      difficulty: "medium",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-bayes-optimal-threshold-0", label: "Case 1", visible: true, args: [[0.02, 0.6], 500.0, 5.0] },
        { id: "iq-bayes-optimal-threshold-1", label: "Case 2", visible: true, args: [[0.3, 0.5, 0.7], 1.0, 1.0] },
        { id: "iq-bayes-optimal-threshold-2", label: "Hidden 1", visible: false, args: [[0.02, 0.6], 100.0, 1.0] },
        { id: "iq-bayes-optimal-threshold-3", label: "Hidden 2", visible: false, args: [[0.6, 0.95], 1.0, 9.0] },
        { id: "iq-bayes-optimal-threshold-4", label: "Hidden 3", visible: false, args: [[0.5], 500.0, 5.0] },
      ],
      reference: `
def threshold_and_cost(probs, c_fn, c_fp):
    t = c_fp / (c_fn + c_fp)
    cost_opt = 0.0
    cost_half = 0.0
    for p in probs:
        cost_opt += (1.0 - p) * c_fp if p > t else p * c_fn
        cost_half += (1.0 - p) * c_fp if p > 0.5 else p * c_fn
    return [t, cost_opt, cost_half]
`,
      template: `
def threshold_and_cost(probs, c_fn, c_fp):
    """
    :type probs: List[float]  -- calibrated P(y=1|x) per row
    :type c_fn: float         -- cost of a missed positive
    :type c_fp: float         -- cost of a false alarm
    :rtype: List[float]       -- [t, cost_at_t, cost_at_half]
    """
`,
    },
    statement: {
      orderIndex: 6,
      description: "Implement `threshold_and_cost(probs, c_fn, c_fp)`.\n\nFor a single row with a calibrated `p = P(y=1|x)`, the two available actions have expected costs\n\n```\nE[cost | flag]       = (1 - p) * c_fp     (you pay only when y = 0)\nE[cost | do nothing] = p * c_fn           (you pay only when y = 1)\n```\n\nFlagging is cheaper exactly when `(1-p)*c_fp < p*c_fn`, which rearranges into a threshold that depends only on the ratio of the costs:\n\n```\nt = c_fp / (c_fn + c_fp)\n```\n\nReturn `[t, cost_at_t, cost_at_half]`, each rounded to 6 decimal places, where each cost is the **sum over all rows** of the expected cost of the action the rule picks:\n\n- `cost_at_t` -- flag row `i` when `probs[i] > t`, otherwise do nothing.\n- `cost_at_half` -- the same sum with the threshold held at `0.5`.\n\n**Flag on a strict `>`.** At `p == t` the two actions cost the same by construction, so the convention is invisible there; at `p == 0.5` under asymmetric costs it is not, and `p = 0.5` is *not* flagged by the 0.5 rule.\n\n`cost_at_half` is the comparison, not a second answer. The default 0.5 is optimal only in the special case `c_fn == c_fp`; at a 100:1 cost ratio it can cost several times more than the right threshold. Note also that `t` contains no class prior -- the base rate enters through `p`, not through the threshold, which is why this rule is only valid on calibrated probabilities.\n\nStandard library only -- no numpy, no sklearn.",
      examples: [
        { input: "probs = [0.02, 0.6], c_fn = 500, c_fp = 5", output: "[0.009901, 6.9, 12.0]", explanation: "t = 5/505 = 0.009901, so both rows clear it and are flagged: 0.98*5 + 0.4*5 = 6.9. The 0.5 rule skips the 0.02 row and pays 0.02*500 = 10 for it, ending at 12.0 -- nearly double the cost for the same model." },
        { input: "probs = [0.3, 0.5, 0.7], c_fn = 1, c_fp = 1", output: "[0.5, 1.1, 1.1]", explanation: "Equal costs put t at exactly 0.5, so the two totals coincide: 0.3 + 0.5 + 0.3 = 1.1. This is the only situation in which the default threshold is the right answer." },
      ],
      constraints: ["1 <= len(probs) <= 10^5", "0 <= probs[i] <= 1", "c_fn > 0 and c_fp > 0", "Flag when p > threshold, strictly greater.", "Round all three returned values to 6 decimal places.", "Standard library only -- no numpy, no sklearn."],
      hints: [],
      params: ["probs", "c_fn", "c_fp"],
    },
  },
  {
    questionSlug: "resampling-odds-correction",
    problem: {
      id: "iq-resampling-odds-correction",
      title: "Undo resampling with an odds correction",
      summary: "Implement `correct_probs(probs, pi_true, pi_train)`.",
      entry: "correct_probs",
      difficulty: "hard",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-resampling-odds-correction-0", label: "Case 1", visible: true, args: [[0.9], 0.01, 0.5] },
        { id: "iq-resampling-odds-correction-1", label: "Case 2", visible: true, args: [[0.1, 0.5, 0.99], 0.01, 0.5] },
        { id: "iq-resampling-odds-correction-2", label: "Hidden 1", visible: false, args: [[0.0, 1.0, 0.5], 0.01, 0.5] },
        { id: "iq-resampling-odds-correction-3", label: "Hidden 2", visible: false, args: [[0.8], 0.02, 0.25] },
        { id: "iq-resampling-odds-correction-4", label: "Hidden 3", visible: false, args: [[0.3, 0.7], 0.2, 0.2] },
      ],
      reference: `
def correct_probs(probs, pi_true, pi_train):
    r = (pi_true / (1.0 - pi_true)) / (pi_train / (1.0 - pi_train))
    out = []
    for p in probs:
        if p <= 0.0:
            out.append(0.0)
        elif p >= 1.0:
            out.append(1.0)
        else:
            odds = (p / (1.0 - p)) * r
            out.append(odds / (1.0 + odds))
    return out
`,
      template: `
def correct_probs(probs, pi_true, pi_train):
    """
    :type probs: List[float]  -- model outputs from the resampled world
    :type pi_true: float      -- positive rate in the real population
    :type pi_train: float     -- positive rate after resampling
    :rtype: List[float]       -- corrected probabilities
    """
`,
    },
    statement: {
      orderIndex: 7,
      description: "Implement `correct_probs(probs, pi_true, pi_train)`.\n\nResampling reweights the classes but leaves `p(x|y)` untouched. Written as Bayes in both worlds the likelihood ratio is identical and cancels, leaving a constant multiplier **on the odds**:\n\n```\nr         = [pi_true / (1 - pi_true)] / [pi_train / (1 - pi_train)]\nodds_true = [p / (1 - p)] * r\np_true    = odds_true / (1 + odds_true)\n```\n\nReturn the corrected probability for every entry of `probs`, each rounded to 6 decimal places.\n\n**Endpoints.** `p == 1.0` sends the odds to infinity -- return `1.0` without dividing by zero. `p == 0.0` returns `0.0`. Neither may raise.\n\nThere is no equivalent operation on the probabilities themselves: the map is linear in odds and nonlinear in `p`, which is why a confident 0.9 from a 50/50 training set is really about 0.083 at a 1% base rate. Note what the correction does *not* change -- it is strictly monotone, so the ranking, and therefore any rank metric, is identical before and after. That is exactly why resampling looks harmless while you evaluate with a ranking metric and breaks everything the moment you threshold or multiply the score by a cost.\n\nStandard library only -- no numpy, no sklearn.",
      examples: [
        { input: "probs = [0.9], pi_true = 0.01, pi_train = 0.5", output: "[0.083333]", explanation: "r = (0.01/0.99) / (0.5/0.5) = 1/99. The training odds of 9 become 9/99 = 1/11, so p_true = (1/11)/(12/11) = 1/12 = 0.083333. The model's confident 0.9 is really about 8%." },
        { input: "probs = [0.1, 0.5, 0.99], pi_true = 0.01, pi_train = 0.5", output: "[0.001121, 0.01, 0.5]", explanation: "An output of 0.5 on a balanced training set carries no information, so it maps exactly onto the true base rate 0.01. It takes 0.99 from the balanced model to reach even odds in the real population, which shows how far the whole scale is compressed." },
      ],
      constraints: ["1 <= len(probs) <= 10^5", "0 <= probs[i] <= 1", "0 < pi_true < 1 and 0 < pi_train < 1", "p == 0 returns 0.0 and p == 1 returns 1.0; neither may raise.", "Round each returned value to 6 decimal places.", "Standard library only -- no numpy, no sklearn."],
      hints: [],
      params: ["probs", "pi_true", "pi_train"],
    },
  },
  {
    questionSlug: "bias-variance-decomposition",
    problem: {
      id: "iq-bias-variance-decomposition",
      title: "Split test error into bias, variance and noise",
      summary: "Implement `decompose(preds, f_true, sigma2, k)`.",
      entry: "decompose",
      difficulty: "hard",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-bias-variance-decomposition-0", label: "Case 1", visible: true, args: [[[1.0, 2.0], [3.0, 4.0]], [2.0, 2.0], 0.5, 2] },
        { id: "iq-bias-variance-decomposition-1", label: "Case 2", visible: true, args: [[[0.0], [4.0]], [2.0], 0.0, 4] },
        { id: "iq-bias-variance-decomposition-2", label: "Hidden 1", visible: false, args: [[[1.0], [2.0]], [0.0], 0.0, 1] },
        { id: "iq-bias-variance-decomposition-3", label: "Hidden 2", visible: false, args: [[[1.0, 3.0]], [2.0, 2.0], 1.0, 3] },
        { id: "iq-bias-variance-decomposition-4", label: "Hidden 3", visible: false, args: [[[1.0, 10.0], [3.0, 20.0]], [2.0, 14.0], 0.25, 1] },
      ],
      reference: `
def decompose(preds, f_true, sigma2, k):
    m = len(preds)
    n = len(f_true)
    bias2 = 0.0
    variance = 0.0
    for j in range(n):
        f_bar = sum(preds[i][j] for i in range(m)) / float(m)
        bias2 += (f_true[j] - f_bar) ** 2
        variance += sum((preds[i][j] - f_bar) ** 2 for i in range(m)) / float(m)
    bias2 /= float(n)
    variance /= float(n)
    total = bias2 + variance + sigma2
    total_k = bias2 + variance / float(k) + sigma2
    return [bias2, variance, sigma2, total, total_k]
`,
      template: `
def decompose(preds, f_true, sigma2, k):
    """
    :type preds: List[List[float]]  -- M models x N test points
    :type f_true: List[float]       -- noise-free target per test point
    :type sigma2: float             -- irreducible noise variance
    :type k: int                    -- ensemble size
    :rtype: List[float]  -- [bias2, variance, noise, total, total_k]
    """
`,
    },
    statement: {
      orderIndex: 8,
      description: "Implement `decompose(preds, f_true, sigma2, k)`.\n\n- `preds` -- `M x N`; `preds[i][j]` is model `i`'s prediction at test point `j`. The M models were fit on M independent resamples of the training set.\n- `f_true` -- length N, the noise-free target `f(x_j)`.\n- `sigma2` -- the irreducible noise variance, from `y = f(x) + eps` with `Var(eps) = sigma2`.\n- `k` -- an ensemble size.\n\nFor each test point `j`, let `f_bar[j]` be the mean prediction over the M models. Averaged over the N test points:\n\n```\nbias2    = mean_j ( f_true[j] - f_bar[j] )^2\nvariance = mean_j ( (1/M) * sum_i ( preds[i][j] - f_bar[j] )^2 )\nnoise    = sigma2\ntotal    = bias2 + variance + noise\ntotal_k  = bias2 + variance / k + noise\n```\n\nReturn `[bias2, variance, noise, total, total_k]`, each rounded to 6 decimal places.\n\n**Three ways to get this wrong.**\n\n1. `bias2` squares the *difference of the means*. Averaging `(f_true[j] - preds[i][j])^2` over both `i` and `j` instead gives `bias2 + variance` -- the two quantities you were asked to separate, added back together.\n2. Divide by `M`, not `M - 1`. This is a decomposition of an expectation, not a sample estimate from a survey, and `M = 1` must give a variance of `0.0` rather than raising.\n3. `f_bar` is per test point. A single mean over the whole matrix is a different number entirely.\n\n`total_k` is the payoff: averaging `k` independent models leaves `f_bar`, and therefore `bias2`, untouched while dividing the variance by `k`. Ensembling buys the variance term and nothing else -- and since the members are never truly independent, decorrelating them matters more than adding more of them. `noise` is a floor no model of any kind gets under.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "preds = [[1.0, 2.0], [3.0, 4.0]], f_true = [2.0, 2.0], sigma2 = 0.5, k = 2", output: "[0.5, 1.0, 0.5, 2.0, 1.5]", explanation: "f_bar = [2.0, 3.0], so bias2 = mean(0, 1) = 0.5. At each point the two predictions sit one unit either side of their mean, so variance = 1.0. Total is 0.5 + 1.0 + 0.5 = 2.0, and averaging 2 models halves the variance term to give 1.5." },
        { input: "preds = [[0.0], [4.0]], f_true = [2.0], sigma2 = 0.0, k = 4", output: "[0.0, 4.0, 0.0, 4.0, 1.0]", explanation: "The two models straddle the target, so the mean prediction is exactly right and bias2 is 0 -- every bit of the error is variance. Averaging 4 such models cuts 4.0 down to 1.0, which no amount of ensembling could do to a biased model." },
      ],
      constraints: ["1 <= M <= 200, 1 <= N <= 10^3", "len(preds[i]) == len(f_true) == N for every i", "sigma2 >= 0 and k >= 1", "Variance divides by M, not M - 1; M = 1 gives 0.0 and must not raise.", "Round each of the five values to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["preds", "f_true", "sigma2", "k"],
    },
  },
  {
    questionSlug: "count-transformer-params",
    problem: {
      id: "iq-count-transformer-params",
      title: "Count the parameters of a transformer config",
      summary: "Return the parameter count of a decoder-only transformer, broken into its parts.",
      entry: "param_count",
      difficulty: "medium",
      categories: ["DL", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "_r",
      cases: [
        { id: "iq-count-transformer-params-0", label: "Case 1", visible: true, args: [4096, 32, 16384, 32000, 32, 32, true, false] },
        { id: "iq-count-transformer-params-1", label: "Case 2", visible: true, args: [4096, 32, 16384, 32000, 32, 8, true, false] },
        { id: "iq-count-transformer-params-2", label: "Hidden 1", visible: false, args: [4096, 32, 11008, 32000, 32, 32, false, true] },
        { id: "iq-count-transformer-params-3", label: "Hidden 2", visible: false, args: [1024, 12, 4096, 32000, 16, 16, true, false] },
        { id: "iq-count-transformer-params-4", label: "Hidden 3", visible: false, args: [2048, 24, 8192, 50257, 16, 1, false, false] },
      ],
      reference: `
def param_count(d_model, n_layers, d_ff, vocab,
                n_heads, n_kv_heads, tied, gated):
    head_dim = d_model // n_heads
    kv_dim = n_kv_heads * head_dim
    # Q and O are always full width; only K and V follow the KV-head count.
    attn = 2 * d_model * d_model + 2 * d_model * kv_dim
    ffn = (3 if gated else 2) * d_model * d_ff
    embedding = vocab * d_model if tied else 2 * vocab * d_model
    total = n_layers * (attn + ffn) + embedding
    return [attn, ffn, embedding, total]
`,
      template: `
def param_count(d_model, n_layers, d_ff, vocab,
                n_heads, n_kv_heads, tied, gated):
    """
    :type d_model: int
    :type n_layers: int
    :type d_ff: int
    :type vocab: int
    :type n_heads: int
    :type n_kv_heads: int
    :type tied: bool
    :type gated: bool
    :rtype: List[int]  -- [attn_per_layer, ffn_per_layer, embedding, total]
    """
`,
    },
    statement: {
      orderIndex: 9,
      description: "Return the parameter count of a decoder-only transformer, broken into its parts.\n\n```\nclass Solution(object):\n    def param_count(self, d_model, n_layers, d_ff, vocab,\n                    n_heads, n_kv_heads, tied, gated):\n        # -> [attn_per_layer, ffn_per_layer, embedding, total]\n```\n\n**Attention block, per layer.** With `head_dim = d_model // n_heads` and `kv_dim = n_kv_heads * head_dim`:\n\n```\nQ: d_model * d_model\nK: d_model * kv_dim\nV: d_model * kv_dim\nO: d_model * d_model\nattn_per_layer = 2*d_model^2 + 2*d_model*kv_dim\n```\n\nWhen `n_kv_heads == n_heads` this collapses to `4*d_model^2`. Grouped-query attention shrinks **only K and V** — Q still projects to the full `d_model`, and O still maps `d_model` back to `d_model`. Dropping O and writing `3*d_model^2` is the classic miscount.\n\n**FFN block, per layer.**\n\n```\ngated == 0 (ReLU/GELU MLP): up d_model*d_ff, down d_ff*d_model  -> 2*d_model*d_ff\ngated == 1 (SwiGLU-style):  gate + up + down                    -> 3*d_model*d_ff\n```\n\n**Embeddings.** `vocab * d_model` when `tied` is true (input table reused as the output head), `2 * vocab * d_model` when untied.\n\n**Total.** `n_layers * (attn_per_layer + ffn_per_layer) + embedding`.\n\n**Ignore** biases, normalization scales/offsets, and positional tables — they are well under 0.1% here. Every returned value is an exact integer; use integer arithmetic (`//`) and return `int`s, not floats.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "d_model=4096, n_layers=32, d_ff=16384, vocab=32000, n_heads=32, n_kv_heads=32, tied=1, gated=0", output: "[67108864, 134217728, 131072000, 6573522944]", explanation: "4096^2 = 16,777,216. Attention is 4 of them = 67.1M; the FFN is 8 of them = 134.2M — so two thirds of every layer sits in the MLP, not in attention. 201.3M per layer times 32 layers is 6.44B, plus a 131M tied embedding table gives a '7B' model." },
        { input: "same but n_kv_heads=8", output: "[41943040, 134217728, 131072000, 5768216576]", explanation: "head_dim = 128, kv_dim = 1024. K and V drop to 4.19M each while Q and O stay at 16.8M each, so attention falls from 67.1M to 41.9M and the whole model loses 0.8B parameters." },
      ],
      constraints: ["1 <= d_model <= 2^16, and d_model % n_heads == 0", "1 <= n_kv_heads <= n_heads", "1 <= n_layers <= 200, 1 <= vocab <= 10^6", "tied and gated are 0 or 1", "Ignore biases, norm parameters and positional tables.", "Return exact integers, not floats.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["d_model", "n_layers", "d_ff", "vocab", "n_heads", "n_kv_heads", "tied", "gated"],
    },
  },
  {
    questionSlug: "activation-memory-budget",
    problem: {
      id: "iq-activation-memory-budget",
      title: "Size a mixed-precision training memory budget",
      summary: "Return the training memory breakdown, in GB, for a mixed-precision run with AdamW.",
      entry: "memory_gb",
      difficulty: "hard",
      categories: ["DL", "CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-activation-memory-budget-0", label: "Case 1", visible: true, args: [7000000000, 32, 4096, 8, 2048, 10, false] },
        { id: "iq-activation-memory-budget-1", label: "Case 2", visible: true, args: [7000000000, 32, 4096, 8, 2048, 10, true] },
        { id: "iq-activation-memory-budget-2", label: "Hidden 1", visible: false, args: [7000000000, 32, 4096, 8, 8192, 10, false] },
        { id: "iq-activation-memory-budget-3", label: "Hidden 2", visible: false, args: [125000000, 12, 768, 32, 512, 16, true] },
        { id: "iq-activation-memory-budget-4", label: "Hidden 3", visible: false, args: [1300000000, 24, 2048, 4, 1024, 12, false] },
      ],
      reference: `
def memory_gb(n_params, n_layers, d_model, batch, seq,
              tensors_per_layer, checkpointing):
    GB = 10 ** 9
    weights = n_params * 2       # bf16
    grads = n_params * 2         # bf16
    master = n_params * 4        # fp32 master copy
    optimizer = n_params * 8     # two fp32 moments

    tokens = batch * seq
    one = tokens * d_model * 2   # one d-wide bf16 tensor
    if checkpointing:
        activations = (n_layers + tensors_per_layer) * one
    else:
        activations = n_layers * tensors_per_layer * one

    total = weights + grads + master + optimizer + activations
    return [weights / float(GB), grads / float(GB), master / float(GB),
            optimizer / float(GB), activations / float(GB), total / float(GB)]
`,
      template: `
def memory_gb(n_params, n_layers, d_model, batch, seq,
              tensors_per_layer, checkpointing):
    """
    :type n_params: int
    :type n_layers: int
    :type d_model: int
    :type batch: int
    :type seq: int
    :type tensors_per_layer: int
    :type checkpointing: bool
    :rtype: List[float]
        [weights, grads, master, optimizer, activations, total] in GB
    """
`,
    },
    statement: {
      orderIndex: 10,
      description: "Return the training memory breakdown, in GB, for a mixed-precision run with AdamW.\n\n```\nclass Solution(object):\n    def memory_gb(self, n_params, n_layers, d_model, batch, seq,\n                  tensors_per_layer, checkpointing):\n        # -> [weights, grads, master, optimizer, activations, total]\n```\n\n**Define `GB = 10**9` bytes** (decimal, not GiB) so the arithmetic is checkable by hand.\n\n**Fixed costs**, independent of batch and sequence length:\n\n```\nweights   = n_params * 2   # bf16 copy used for the matmuls\ngrads     = n_params * 2   # bf16 gradients\nmaster    = n_params * 4   # fp32 master copy the optimizer updates\noptimizer = n_params * 8   # two fp32 moments, 4 bytes each\n```\n\nThat is 16 bytes per parameter, so the bf16 weights are one eighth of the fixed bill. Reporting only the weights is the mistake this is built to catch.\n\n**Activations.** Let `tokens = batch * seq`. One saved d-wide bf16 tensor costs `tokens * d_model * 2` bytes. A layer saves `tensors_per_layer` of them (count the `d_ff`-wide FFN intermediate as its own multiple of a d-wide tensor — the caller has already folded that into `tensors_per_layer`).\n\n```\none      = tokens * d_model * 2\nif not checkpointing:  activations = n_layers * tensors_per_layer * one\nif checkpointing:      activations = (n_layers + tensors_per_layer) * one\n```\n\nThe checkpointing rule is exactly that: keep one tensor at each of the `n_layers` layer boundaries, plus enough room to rematerialize a single layer's `tensors_per_layer` tensors during its backward pass. Note it still grows with depth — a solution that assumes checkpointing removes the depth factor entirely gets this wrong.\n\n**Total** is the sum of all five. Return the six values in GB, in the order above; the driver rounds each to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "n_params=7000000000, n_layers=32, d_model=4096, batch=8, seq=2048, tensors_per_layer=10, checkpointing=False", output: "[14.0, 14.0, 28.0, 56.0, 42.949673, 154.949673]", explanation: "Fixed cost is 7e9 x 16 bytes = 112 GB, already past an 80GB card before a single activation is stored. Activations add another 42.9 GB, giving 155 GB against 80 — sharding is a precondition here, not an optimization." },
        { input: "same but checkpointing=True", output: "[14.0, 14.0, 28.0, 56.0, 5.637145, 117.637145]", explanation: "The activation multiplier drops from 32*10 = 320 d-wide tensors to 32 + 10 = 42, cutting 42.9 GB to 5.6 GB. The fixed 112 GB does not move, which is why checkpointing alone never rescues this configuration." },
      ],
      constraints: ["1 <= n_params <= 10^12", "1 <= n_layers <= 200, 1 <= d_model <= 2^16", "1 <= batch * seq <= 10^7", "1 <= tensors_per_layer <= 64", "GB means 10^9 bytes.", "Round every returned value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["n_params", "n_layers", "d_model", "batch", "seq", "tensors_per_layer", "checkpointing"],
    },
  },
  {
    questionSlug: "residual-jacobian",
    problem: {
      id: "iq-residual-jacobian",
      title: "Decompose a residual stack's gradient by path length",
      summary: "A stack of `L` residual blocks computes `x -> x + F_l(x)` at each layer. Treat each block's Jacobian `dF_l/dx` as a scalar `j_l`, so the end-to-end derivative is",
      entry: "path_spectrum",
      difficulty: "medium",
      categories: ["DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-residual-jacobian-0", label: "Case 1", visible: true, args: [[0.9, 0.9]] },
        { id: "iq-residual-jacobian-1", label: "Case 2", visible: true, args: [[0.5, -0.5, 2.0]] },
        { id: "iq-residual-jacobian-2", label: "Hidden 1", visible: false, args: [[]] },
        { id: "iq-residual-jacobian-3", label: "Hidden 2", visible: false, args: [[0.0, 0.0, 0.0]] },
        { id: "iq-residual-jacobian-4", label: "Hidden 3", visible: false, args: [[0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]] },
      ],
      reference: `
def path_spectrum(jacobians):
    n = len(jacobians)
    # spectrum[k] = sum over subsets of size k of the product of their j's.
    spectrum = [1.0] + [0.0] * n
    filled = 0
    for j in jacobians:
        filled += 1
        # High index downward, so this layer is absorbed at most once.
        for k in range(filled, 0, -1):
            spectrum[k] = spectrum[k] + spectrum[k - 1] * j
    return spectrum
`,
      template: `
def path_spectrum(jacobians):
    """
    :type jacobians: List[float]
    :rtype: List[float]  -- length len(jacobians) + 1
    """
`,
    },
    statement: {
      orderIndex: 11,
      description: "A stack of `L` residual blocks computes `x -> x + F_l(x)` at each layer. Treat each block's Jacobian `dF_l/dx` as a scalar `j_l`, so the end-to-end derivative is\n\n```\nprod_{l=1..L} (1 + j_l)\n```\n\nExpanding that product gives one term per **subset** of layers — a term that passes through the blocks in the subset and skips the rest via the identity route. Group the terms by subset size:\n\n```\nspectrum[k] = sum over all subsets S of size k of  prod_{l in S} j_l\n```\n\nWrite\n\n```\nclass Solution(object):\n    def path_spectrum(self, jacobians):\n        # -> [spectrum[0], spectrum[1], ..., spectrum[L]]\n```\n\nreturning a list of length `L + 1`.\n\n**What the two ends mean.** `spectrum[0]` is always exactly `1.0` — the empty subset, the route from the loss all the way back through zero Jacobians. That term is why the gradient cannot vanish uniformly no matter what the deep terms do. `spectrum[L]` is the product of every Jacobian, which is precisely what a plain stack `y = F(x)` would give you and nothing else. Everything between is the ensemble of shallower paths. The whole list sums to `prod(1 + j_l)`.\n\n**Do not enumerate the subsets.** There are `2^L` of them and `L` reaches 25 in the tests. One pass over the layers, carrying the whole spectrum, is `O(L^2)`: after absorbing a new layer `j`, the size-`k` sums pick up `spectrum[k-1] * j`. Update the entries from the high index down, or a single layer will be counted more than once.\n\n**Edge case.** An empty list returns `[1.0]` — no blocks, derivative is the identity.\n\nThe driver rounds every entry to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "jacobians = [0.9, 0.9]", output: "[1.0, 1.8, 0.81]", explanation: "One empty path (1.0), two single-block paths (0.9 each), one path through both (0.81). They sum to 3.61 = 1.9^2 = prod(1 + j)." },
        { input: "jacobians = [0.0]", output: "[1.0, 0.0]", explanation: "Zero-initialising F's last layer makes j = 0, so every path through the block contributes nothing and the block is exactly the identity at step 0." },
      ],
      constraints: ["0 <= L <= 25", "-10.0 <= jacobians[i] <= 10.0", "Return a list of length L + 1; spectrum[0] is 1.0.", "Do not enumerate the 2^L subsets -- that will time out.", "Round every entry to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["jacobians"],
    },
  },
  {
    questionSlug: "fp16-update-underflow",
    problem: {
      id: "iq-fp16-update-underflow",
      title: "Simulate a weight update in a low-precision format",
      summary: "Model a binary float format by two numbers: `mantissa_bits`, the number of fraction bits, and `min_exp`, the exponent of the smallest normal value. fp16 is `(10, -14)`, fp32 is `(23, -126)`, bf16 is `(7, -126)`.",
      entry: "simulate",
      difficulty: "hard",
      categories: ["DL", "CUDA", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 9) for x in _r]",
      cases: [
        { id: "iq-fp16-update-underflow-0", label: "Case 1", visible: true, args: [1.0, 1e-06, 1, 10, -14] },
        { id: "iq-fp16-update-underflow-1", label: "Case 2", visible: true, args: [1.0, 1e-06, 100000, 10, -14] },
        { id: "iq-fp16-update-underflow-2", label: "Case 3", visible: true, args: [1.0, 1e-06, 1, 23, -126] },
        { id: "iq-fp16-update-underflow-3", label: "Hidden 1", visible: false, args: [0.0, 1e-08, 100, 10, -14] },
        { id: "iq-fp16-update-underflow-4", label: "Hidden 2", visible: false, args: [1024.0, 0.1, 1, 10, -14] },
        { id: "iq-fp16-update-underflow-5", label: "Hidden 3", visible: false, args: [1.0, 1e-06, 1000, 7, -126] },
        { id: "iq-fp16-update-underflow-6", label: "Hidden 4", visible: false, args: [1.0, 1e-06, 100000, 23, -126] },
      ],
      reference: `
import math

def simulate(w, u, steps, mantissa_bits, min_exp):
    def spacing(x):
        if x == 0.0:
            return math.ldexp(1.0, min_exp - mantissa_bits)
        _m, k = math.frexp(abs(x))
        e = k - 1                 # abs(x) lies in [2**e, 2**(e+1))
        if e < min_exp:           # subnormal: one fixed spacing
            e = min_exp
        return math.ldexp(1.0, e - mantissa_bits)

    def quantize(x):
        s = spacing(x)
        return round(x / s) * s   # round() breaks ties to even

    ulps = u / spacing(w)
    cur = w
    for _ in range(steps):
        cur = quantize(cur + u)
    return [ulps, cur]
`,
      template: `
import math

def simulate(w, u, steps, mantissa_bits, min_exp):
    """
    :type w: float
    :type u: float
    :type steps: int
    :type mantissa_bits: int
    :type min_exp: int
    :rtype: List[float]  -- [ulps, w_final]
    """
`,
    },
    statement: {
      orderIndex: 12,
      description: "Model a binary float format by two numbers: `mantissa_bits`, the number of fraction bits, and `min_exp`, the exponent of the smallest normal value. fp16 is `(10, -14)`, fp32 is `(23, -126)`, bf16 is `(7, -126)`.\n\nWrite\n\n```\nclass Solution(object):\n    def simulate(self, w, u, steps, mantissa_bits, min_exp):\n        # -> [ulps, w_final]\n```\n\n**Spacing.** The gap between neighbouring representable values at `x` is\n\n```\nspacing(x):\n    if x == 0:  return 2 ** (min_exp - mantissa_bits)\n    e = floor(log2(abs(x)))          # use math.frexp: m, k = frexp(abs(x)) -> e = k - 1\n    e = max(e, min_exp)              # subnormals all share one spacing\n    return 2 ** (e - mantissa_bits)\n```\n\n`math.frexp` is the safe way to get `e` — it is exact where `log2` can be one bit off at boundaries.\n\n**Quantizing.** Round to the nearest representable value, ties to even:\n\n```\nquantize(x):\n    s = spacing(x)\n    return round(x / s) * s\n```\n\nPython's built-in `round` on a float already breaks ties to even, so this is literally the rule.\n\n**What to return.**\n\n1. `ulps` — the update measured in units of the spacing **at the starting weight**: `u / spacing(w)`. This is the whole diagnostic. Below 0.5 the update cannot survive rounding, and it will not survive on any later step either, because the spacing has not changed.\n2. `w_final` — the weight after applying the update `steps` times, each step being an addition in full precision followed by one `quantize`:\n\n```\ncur = w\nrepeat steps times:  cur = quantize(cur + u)\n```\n\nNote the failure is silent: no NaN, no warning, just a parameter that never moves however long the run goes on. The fix is the fp32 master copy — same `u`, same `w`, larger `mantissa_bits`. A loss scaler changes neither number here, because rescaling the gradient does not change the spacing of values near `w`.\n\nThe driver rounds both returned values to 9 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "w = 1.0, u = 1e-6, steps = 1, mantissa_bits = 10, min_exp = -14", output: "[0.001024, 1.0]", explanation: "With a 10-bit mantissa the spacing at 1.0 is 2^-10 = 0.0009765625, so an update of 1e-6 is about one thousandth of one step. It rounds straight back to 1.0." },
        { input: "w = 1.0, u = 1e-6, steps = 1, mantissa_bits = 23, min_exp = -126", output: "[8.388608, 1.000000954]", explanation: "An fp32 master copy has spacing 2^-23 near 1.0, so the same update is about 8 spacings and lands cleanly." },
      ],
      constraints: ["0 <= steps <= 200000", "1 <= mantissa_bits <= 52", "-1074 <= min_exp <= 0", "abs(w) < 2^30, abs(u) < 2^30", "Compute ulps from the spacing at the STARTING w.", "spacing(0.0) is 2 ** (min_exp - mantissa_bits).", "Round to nearest, ties to even.", "Round both returned values to 9 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["w", "u", "steps", "mantissa_bits", "min_exp"],
    },
  },
  {
    questionSlug: "warmup-adam-variance",
    problem: {
      id: "iq-warmup-adam-variance",
      title: "Compute the effective sample count behind Adam's second moment",
      summary: "Adam's second moment is `v_t = b2 * v_{t-1} + (1 - b2) * g_t^2` with `v_0 = 0`, and bias correction divides by `1 - b2^t`. Unrolled, that makes the corrected estimate a weighted average of past squared gradients:",
      entry: "moment_stats",
      difficulty: "hard",
      categories: ["DL", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-warmup-adam-variance-0", label: "Case 1", visible: true, args: [0.999, 1] },
        { id: "iq-warmup-adam-variance-1", label: "Case 2", visible: true, args: [0.9, 2] },
        { id: "iq-warmup-adam-variance-2", label: "Case 3", visible: true, args: [0.999, 1000] },
        { id: "iq-warmup-adam-variance-3", label: "Hidden 1", visible: false, args: [0.999, 1000000000] },
        { id: "iq-warmup-adam-variance-4", label: "Hidden 2", visible: false, args: [0.99, 5] },
        { id: "iq-warmup-adam-variance-5", label: "Hidden 3", visible: false, args: [0.5, 3] },
      ],
      reference: `
import math

def moment_stats(b2, t):
    x = b2 ** t
    # sum w_i^2 = ((1-b2)/(1-x))^2 * (1-x^2)/(1-b2^2), and 1-b2^2 = (1-b2)(1+b2),
    # so 1/sum w_i^2 collapses to:
    ess = ((1.0 + b2) / (1.0 - b2)) * ((1.0 - x) / (1.0 + x))
    w_last = (1.0 - b2) / (1.0 - x)
    rel_std = math.sqrt(2.0 / ess)
    return [ess, w_last, rel_std]
`,
      template: `
import math

def moment_stats(b2, t):
    """
    :type b2: float
    :type t: int
    :rtype: List[float]  -- [ess, w_last, rel_std]
    """
`,
    },
    statement: {
      orderIndex: 13,
      description: "Adam's second moment is `v_t = b2 * v_{t-1} + (1 - b2) * g_t^2` with `v_0 = 0`, and bias correction divides by `1 - b2^t`. Unrolled, that makes the corrected estimate a weighted average of past squared gradients:\n\n```\nv_hat_t = sum_{i=1..t} w_i * g_i^2 ,   w_i = (1 - b2) * b2^(t-i) / (1 - b2^t)\n```\n\nThe weights sum to exactly 1, which is what bias correction buys you: `E[v_hat_t] = E[g^2]`, unbiased from step one. Write\n\n```\nimport math\n\nclass Solution(object):\n    def moment_stats(self, b2, t):\n        # -> [ess, w_last, rel_std]\n```\n\n**1. `ess`** — the Kish effective sample size of that weighted average:\n\n```\ness = (sum_i w_i)^2 / sum_i w_i^2 = 1 / sum_i w_i^2\n```\n\nBoth sums are geometric, so this collapses to a closed form in `b2` and `b2**t`. Derive it — `t` reaches 10^9 in the tests and a loop over `t` terms will time out.\n\n**2. `w_last`** — the weight on the newest gradient, `w_t = (1 - b2) / (1 - b2^t)`.\n\n**3. `rel_std`** — the relative standard deviation of `v_hat_t`. Assume the `g_i` are i.i.d. Gaussian with mean 0, so `Var[g^2] / E[g^2]^2 = 2` exactly, and averaging with these weights divides that by `ess`:\n\n```\nrel_std = sqrt(2 / ess)\n```\n\n**What you should see.** At `t = 1` the answer is `ess = 1`, `w_last = 1`, `rel_std = sqrt(2)` — the estimate is one sample, and the update divides by its square root. As `t` grows, `ess` saturates at `(1 + b2) / (1 - b2)`, roughly twice the familiar `1 / (1 - b2)` decay time, since the Kish count and the decay time are different quantities. Warmup exists to keep the learning rate small over exactly the stretch where `ess` climbs from 1 toward that ceiling.\n\nThe driver rounds all three values to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "b2 = 0.999, t = 1", output: "[1.0, 1.0, 1.414214]", explanation: "Bias correction divides v_1 = (1-b2)*g_1^2 by (1-b2), giving exactly g_1^2. Unbiased, and estimated from a single sample: the relative spread is sqrt(2) = 141%, and the update divides by the square root of that." },
        { input: "b2 = 0.999, t = 1000000000", output: "[1999.0, 0.001, 0.031631]", explanation: "Fully converged: ess hits its ceiling (1 + b2)/(1 - b2) = 1.999/0.001 = 1999, and the relative spread has fallen to about 3%. This is the regime the per-parameter step bound assumes." },
      ],
      constraints: ["0.0 < b2 < 1.0", "1 <= t <= 10^9", "Derive the closed form; a loop over t terms will time out.", "Assume Var[g^2] / E[g^2]^2 = 2 (zero-mean Gaussian gradients).", "Round all three values to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["b2", "t"],
    },
  },
  {
    questionSlug: "why-cross-entropy-not-mse",
    problem: {
      id: "iq-why-cross-entropy-not-mse",
      title: "Return dL/dz for softmax under two losses",
      summary: "Given `logits` (a list of real numbers), an integer `label` (the index of the correct class) and `loss` (either `\"ce\"` or `\"mse\"`), return `dL/dz` — the gradient of the loss with respect to the **logits** — as a list of the same length.",
      entry: "logit_grad",
      difficulty: "medium",
      categories: ["ML", "DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) + 0.0 for x in _r]",
      cases: [
        { id: "iq-why-cross-entropy-not-mse-0", label: "Case 1", visible: true, args: [[0.0, 0.0, 0.0], 0, "ce"] },
        { id: "iq-why-cross-entropy-not-mse-1", label: "Case 2", visible: true, args: [[0.0, 0.0, 0.0], 0, "mse"] },
        { id: "iq-why-cross-entropy-not-mse-2", label: "Hidden 1", visible: false, args: [[6.0, 0.0], 1, "ce"] },
        { id: "iq-why-cross-entropy-not-mse-3", label: "Hidden 2", visible: false, args: [[6.0, 0.0], 1, "mse"] },
        { id: "iq-why-cross-entropy-not-mse-4", label: "Hidden 3", visible: false, args: [[1.0, 2.0, 0.5, -1.0], 2, "mse"] },
        { id: "iq-why-cross-entropy-not-mse-5", label: "Hidden 4", visible: false, args: [[2.0, -1.0, 0.5], 1, "ce"] },
      ],
      reference: `
import math

def logit_grad(logits, label, loss):
    m = max(logits)
    exps = [math.exp(z - m) for z in logits]
    s = sum(exps)
    p = [e / s for e in exps]
    d = [p[i] - (1.0 if i == label else 0.0) for i in range(len(p))]
    if loss == "ce":
        return d
    dot = sum(d[i] * p[i] for i in range(len(p)))
    return [2.0 * p[j] * (d[j] - dot) for j in range(len(p))]
`,
      template: `
import math

def logit_grad(logits, label, loss):
    """
    :type logits: List[float]
    :type label: int
    :type loss: str  -- "ce" or "mse"
    :rtype: List[float]
    """
`,
    },
    statement: {
      orderIndex: 14,
      description: "Given `logits` (a list of real numbers), an integer `label` (the index of the correct class) and `loss` (either `\"ce\"` or `\"mse\"`), return `dL/dz` — the gradient of the loss with respect to the **logits** — as a list of the same length.\n\nLet `p = softmax(z)` and let `y` be the one-hot vector with `y[label] = 1`. The Jacobian of the softmax is\n\n```\ndp_i/dz_j = p_i * (delta_ij - p_j)\n```\n\n**`loss == \"ce\"`** — `L = -log p[label]`, so `dL/dp_i = -y_i / p_i`.\n\n**`loss == \"mse\"`** — `L = sum_i (p_i - y_i)**2`, so `dL/dp_i = 2 * (p_i - y_i)`.\n\nPush each of those through the Jacobian yourself. In one case the `1/p_i` from the log cancels the `p_i` in the Jacobian and almost everything disappears. In the other nothing cancels, and the surviving expression is what makes the gradient vanish exactly where the model is confidently wrong.\n\nEdge cases and rounding:\n\n- Both gradients sum to zero across the coordinates — every row of the Jacobian does. Use that as a self-check.\n- `logits` are unnormalised and may be negative.\n- Round every returned value to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "logits = [0.0, 0.0, 0.0], label = 0, loss = \"ce\"", output: "[-0.666667, 0.333333, 0.333333]", explanation: "p is uniform at 1/3 and y = [1, 0, 0]. Cross-entropy leaves nothing but the difference: [1/3 - 1, 1/3, 1/3]." },
        { input: "logits = [0.0, 0.0, 0.0], label = 0, loss = \"mse\"", output: "[-0.444444, 0.222222, 0.222222]", explanation: "Same p, but every coordinate keeps a factor of p_j: 2*p_j*((p_j - y_j) - sum_i p_i*(p_i - y_i)). Here the weighted sum is 0, leaving 2*(1/3)*(-2/3) = -4/9 and 2*(1/3)*(1/3) = 2/9." },
        { input: "logits = [6.0, 0.0], label = 1, loss = \"mse\"", output: "[0.009842, -0.009842]", explanation: "The model is confidently wrong (p ~ [0.9975, 0.0025] with the answer being class 1) and squared error still produces a gradient of magnitude 0.0098. Cross-entropy on the same input gives 0.9975 — a hundred times larger." },
      ],
      constraints: ["2 <= len(logits) <= 10^3", "0 <= label < len(logits)", "loss is either \"ce\" or \"mse\"", "The returned gradient sums to 0.", "Round each value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["logits", "label", "loss"],
    },
  },
  {
    questionSlug: "eigenvalues-of-the-hessian",
    problem: {
      id: "iq-eigenvalues-of-the-hessian",
      title: "Score a learning rate against the curvature spectrum",
      summary: "Gradient descent on `L(w) = 0.5 * w^T H w` is `w <- w - eta * H * w`. In the eigenbasis of `H` the update decouples completely: each coordinate independently obeys `w_i <- (1 - eta*lambda_i) * w_i`, so after `t` steps it has been multiplied by `(1 - eta*lambda_i)**t`.",
      entry: "gd_analysis",
      difficulty: "hard",
      categories: ["ML", "DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(_r[0]), 6), round(float(_r[1]), 6), round(float(_r[2]), 6), int(_r[3])]",
      cases: [
        { id: "iq-eigenvalues-of-the-hessian-0", label: "Case 1", visible: true, args: [[1.0, 4.0], 0.4, 0.01] },
        { id: "iq-eigenvalues-of-the-hessian-1", label: "Case 2", visible: true, args: [[1.0, 10.0], 0.25, 0.001] },
        { id: "iq-eigenvalues-of-the-hessian-2", label: "Hidden 1", visible: false, args: [[2.0, 2.0], 0.5, 0.01] },
        { id: "iq-eigenvalues-of-the-hessian-3", label: "Hidden 2", visible: false, args: [[0.5, 2.0, 8.0, 1.0], 0.2, 1e-06] },
        { id: "iq-eigenvalues-of-the-hessian-4", label: "Hidden 3", visible: false, args: [[3.0], 0.1, 0.5] },
        { id: "iq-eigenvalues-of-the-hessian-5", label: "Hidden 4", visible: false, args: [[1.0, 4.0], 0.5, 0.01] },
      ],
      reference: `
import math

def gd_analysis(eigs, eta, eps):
    lo = min(eigs)
    hi = max(eigs)
    rho = max(abs(1.0 - eta * e) for e in eigs)
    eta_max = 2.0 / hi
    eta_star = 2.0 / (hi + lo)
    kappa = hi / lo
    rate = (kappa - 1.0) / (kappa + 1.0)
    if rate == 0.0:
        steps = 1
    else:
        steps = int(math.ceil(math.log(eps) / math.log(rate)))
    return [rho, eta_max, eta_star, steps]
`,
      template: `
import math

def gd_analysis(eigs, eta, eps):
    """
    :type eigs: List[float]
    :type eta: float
    :type eps: float
    :rtype: List  -- [rho, eta_max, eta_star, steps]
    """
`,
    },
    statement: {
      orderIndex: 15,
      description: "Gradient descent on `L(w) = 0.5 * w^T H w` is `w <- w - eta * H * w`. In the eigenbasis of `H` the update decouples completely: each coordinate independently obeys `w_i <- (1 - eta*lambda_i) * w_i`, so after `t` steps it has been multiplied by `(1 - eta*lambda_i)**t`.\n\nGiven `eigs` (the eigenvalues of `H`, all strictly positive, unsorted), a step size `eta` and a target `eps`, return `[rho, eta_max, eta_star, steps]`:\n\n- `rho` — the worst-case contraction per step at the given `eta`: `max_i |1 - eta*lambda_i|`. Convergence requires `rho < 1`; `rho >= 1` means at least one coordinate does not shrink.\n- `eta_max` — the step size at which `rho` first reaches 1, i.e. `2 / lambda_max`. Note the factor of 2.\n- `eta_star` — the step size that minimises `rho`, i.e. `2 / (lambda_max + lambda_min)`.\n- `steps` — run at `eta = eta_star`, where the worst-case contraction is `rate = (kappa - 1) / (kappa + 1)` with `kappa = lambda_max / lambda_min`. Return the smallest integer `t >= 1` such that `rate**t <= eps`.\n\nEdge cases and rounding:\n\n- If every eigenvalue is equal then `kappa = 1` and `rate = 0`: a single step lands exactly on the optimum, so `steps` is 1. Do not take the logarithm of zero.\n- The absolute value in `rho` is load-bearing. Overshooting past the optimum gives a negative factor whose magnitude is what matters.\n- `rho`, `eta_max` and `eta_star` are rounded to 6 decimal places; `steps` is returned as an integer.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "eigs = [1.0, 4.0], eta = 0.4, eps = 0.01", output: "[0.6, 0.5, 0.4, 10]", explanation: "|1 - 0.4*1| = 0.6 and |1 - 0.4*4| = 0.6, so rho = 0.6. eta_max = 2/4 = 0.5 and eta_star = 2/(4+1) = 0.4, so the supplied step size is already optimal. kappa = 4 gives rate = 3/5, and 0.6**9 = 0.01008 > 0.01 while 0.6**10 = 0.00605 <= 0.01." },
        { input: "eigs = [1.0, 10.0], eta = 0.25, eps = 0.001", output: "[1.5, 0.2, 0.181818, 35]", explanation: "|1 - 0.25*10| = 1.5, so the sharp direction grows by 50% per step and the run diverges, even though the flat direction contracts to 0.75. A single eigenvalue sets the ceiling." },
      ],
      constraints: ["1 <= len(eigs) <= 10^3", "Every eigenvalue is strictly positive.", "eta > 0", "0 < eps < 1", "steps counts optimal-step-size steps, not steps at the supplied eta.", "Round the three floats to 6 decimal places; return steps as an int.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["eigs", "eta", "eps"],
    },
  },
  {
    questionSlug: "kl-divergence-asymmetry",
    problem: {
      id: "iq-kl-divergence-asymmetry",
      title: "Compute both directions of KL with the zero cases right",
      summary: "`p` and `q` are lists of the same length, each summing to 1, with non-negative entries. Return `[forward, reverse]` where",
      entry: "kl_pair",
      difficulty: "hard",
      categories: ["ML", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) + 0.0 for x in _r]",
      cases: [
        { id: "iq-kl-divergence-asymmetry-0", label: "Case 1", visible: true, args: [[1.0, 0.0], [0.5, 0.5]] },
        { id: "iq-kl-divergence-asymmetry-1", label: "Case 2", visible: true, args: [[0.9, 0.1], [0.5, 0.5]] },
        { id: "iq-kl-divergence-asymmetry-2", label: "Hidden 1", visible: false, args: [[0.5, 0.5, 0.0], [0.3333333333333333, 0.3333333333333333, 0.3333333333333333]] },
        { id: "iq-kl-divergence-asymmetry-3", label: "Hidden 2", visible: false, args: [[0.6, 0.4, 0.0], [0.5, 0.5, 0.0]] },
        { id: "iq-kl-divergence-asymmetry-4", label: "Hidden 3", visible: false, args: [[0.25, 0.25, 0.5], [0.25, 0.25, 0.5]] },
        { id: "iq-kl-divergence-asymmetry-5", label: "Hidden 4", visible: false, args: [[0.2, 0.3, 0.5], [0.1, 0.6, 0.3]] },
      ],
      reference: `
import math

def kl_pair(p, q):
    return [_kl(p, q), _kl(q, p)]

def _kl(a, b):
    total = 0.0
    for ai, bi in zip(a, b):
        if ai == 0.0:
            continue
        if bi == 0.0:
            return float("inf")
        total += ai * math.log(ai / bi)
    return total
`,
      template: `
import math

def kl_pair(p, q):
    """
    :type p: List[float]
    :type q: List[float]
    :rtype: List[float]  -- [KL(p||q), KL(q||p)], inf where divergent
    """
`,
    },
    statement: {
      orderIndex: 16,
      description: "`p` and `q` are lists of the same length, each summing to 1, with non-negative entries. Return `[forward, reverse]` where\n\n```\nforward = KL(p || q) = sum_i p_i * ln(p_i / q_i)\nreverse = KL(q || p) = sum_i q_i * ln(q_i / p_i)\n```\n\nusing the natural logarithm (nats).\n\n**The zero conventions are the whole question.** For a general `KL(a || b)`, where `a` is the distribution supplying the weight:\n\n- `a_i == 0` contributes exactly 0, whatever `b_i` is — `0 * ln 0 = 0` in the limit. So `a_i == 0, b_i > 0` is free, and `a_i == 0, b_i == 0` is free too.\n- `a_i > 0` with `b_i == 0` sends the whole sum to `+inf`.\n\nReturn `float(\"inf\")` for a divergent direction; the driver prints it as `inf`. The two directions are computed independently, so one may be finite while the other is infinite — that asymmetry is the point, and it is why one direction refuses to let the model drop a mode while the other charges nothing for it.\n\nRound finite values to 6 decimal places.\n\nStandard library only -- no numpy, no scipy.",
      examples: [
        { input: "p = [1.0, 0.0], q = [0.5, 0.5]", output: "[0.693147, inf]", explanation: "Forward: only index 0 carries weight, giving 1*ln(1/0.5) = ln 2; index 1 has p_i = 0 so it contributes nothing. Reverse: q puts weight 0.5 on an outcome p rules out, so that term is +inf. Spreading q over p's support is cheap; leaving q's support uncovered is not." },
        { input: "p = [0.9, 0.1], q = [0.5, 0.5]", output: "[0.368064, 0.510826]", explanation: "Both directions are finite and unequal. KL is not symmetric and is not a distance." },
        { input: "p = [0.6, 0.4, 0.0], q = [0.5, 0.5, 0.0]", output: "[0.020136, 0.020411]", explanation: "A zero at the same index in both distributions is free in both directions. Returning inf whenever any entry is zero fails here." },
      ],
      constraints: ["1 <= len(p) == len(q) <= 10^4", "p and q each sum to 1 with non-negative entries.", "Use the natural logarithm.", "Return float(\"inf\") for a divergent direction.", "Round finite values to 6 decimal places.", "Standard library only -- no numpy, no scipy."],
      hints: [],
      params: ["p", "q"],
    },
  },
  {
    questionSlug: "why-scale-by-sqrt-dk",
    problem: {
      id: "iq-why-scale-by-sqrt-dk",
      title: "Size the attention score divisor from head width",
      summary: "A transformer of width `d_model` with `n_heads` heads gives each head `d_k = d_model // n_heads` dimensions. One raw score is the dot product of a query and a key over those `d_k` dimensions:",
      entry: "score_stats",
      difficulty: "medium",
      categories: ["DL", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), round(float(_r[1]), 6), round(float(_r[2]), 6), round(float(_r[3]), 6)]",
      cases: [
        { id: "iq-why-scale-by-sqrt-dk-0", label: "Case 1", visible: true, args: [512, 8, 1.0, 1.0] },
        { id: "iq-why-scale-by-sqrt-dk-1", label: "Case 2", visible: true, args: [768, 12, 4.0, 1.0] },
        { id: "iq-why-scale-by-sqrt-dk-2", label: "Hidden 1", visible: false, args: [4096, 16, 1.0, 1.0] },
        { id: "iq-why-scale-by-sqrt-dk-3", label: "Hidden 2", visible: false, args: [64, 64, 9.0, 1.0] },
        { id: "iq-why-scale-by-sqrt-dk-4", label: "Hidden 3", visible: false, args: [1024, 16, 0.25, 0.25] },
        { id: "iq-why-scale-by-sqrt-dk-5", label: "Hidden 4", visible: false, args: [512, 8, 1.0, 4.0] },
      ],
      reference: `
import math

def score_stats(d_model, n_heads, var_q, var_k):
    d_k = d_model // n_heads
    sd_raw = math.sqrt(d_k * var_q * var_k)
    divisor = math.sqrt(d_k)
    return [d_k, sd_raw, divisor, sd_raw / divisor]
`,
      template: `
import math

def score_stats(d_model, n_heads, var_q, var_k):
    """
    :type d_model: int
    :type n_heads: int
    :type var_q: float
    :type var_k: float
    :rtype: List  -- [d_k, sd_raw, divisor, sd_scaled]
    """
`,
    },
    statement: {
      orderIndex: 17,
      description: "A transformer of width `d_model` with `n_heads` heads gives each head `d_k = d_model // n_heads` dimensions. One raw score is the dot product of a query and a key over those `d_k` dimensions:\n\n```\ns = sum_{i=1..d_k} q_i * k_i\n```\n\nAssume the components are independent and zero-mean with `Var(q_i) = var_q` and `Var(k_i) = var_k` for every `i`. Return `[d_k, sd_raw, divisor, sd_scaled]`:\n\n- `d_k` — the per-head width, using integer floor division.\n- `sd_raw` — the standard deviation of `s`. Each term has `E[q_i k_i] = 0` and `Var(q_i k_i) = var_q * var_k`; the terms are independent so the variances add over all `d_k` of them. Take the square root.\n- `divisor` — what the model divides the score by: `sqrt(d_k)`. This is a constant of the architecture and does **not** depend on `var_q` or `var_k`.\n- `sd_scaled` — the standard deviation after dividing, `sd_raw / divisor`.\n\n`sd_scaled` comes out at exactly 1 when `var_q * var_k == 1`, and only then. Learned projections are not unit-variance, so the fixed divisor over- or under-corrects — which is the gap QK-norm closes.\n\nRound the three floats to 6 decimal places; `d_k` is returned as an integer.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "d_model = 512, n_heads = 8, var_q = 1.0, var_k = 1.0", output: "[64, 8.0, 8.0, 1.0]", explanation: "d_k = 64, so Var(s) = 64 * 1 * 1 = 64 and sd_raw = 8. The divisor sqrt(64) = 8 is exactly right here, leaving unit standard deviation. Note the divisor is 8, not sqrt(512) = 22.6." },
        { input: "d_model = 768, n_heads = 12, var_q = 4.0, var_k = 1.0", output: "[64, 16.0, 8.0, 2.0]", explanation: "The same head width, but Var(s) = 64 * 4 * 1 = 256 so sd_raw = 16. The divisor is still sqrt(64) = 8, so the scaled score has standard deviation 2 — the architectural constant under-corrects when the components are not unit-variance." },
      ],
      constraints: ["1 <= n_heads <= d_model <= 2^16", "var_q > 0 and var_k > 0", "d_k is d_model // n_heads (floor division).", "divisor depends only on d_k.", "Round the three floats to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["d_model", "n_heads", "var_q", "var_k"],
    },
  },
  {
    questionSlug: "matrix-calculus-backprop",
    problem: {
      id: "iq-matrix-calculus-backprop",
      title: "Backprop a linear layer by hand",
      summary: "A linear layer computes `Y = X @ W + b`, where `X` has shape `(N, D)`, `W` has shape `(D, M)`, `b` has shape `(M,)` and is added to every row, and `Y` has shape `(N, M)`.",
      entry: "linear_backward",
      difficulty: "medium",
      categories: ["DL", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[[[round(float(v), 6) + 0.0 for v in row] for row in _r[0]], [[round(float(v), 6) + 0.0 for v in row] for row in _r[1]], [round(float(v), 6) + 0.0 for v in _r[2]]]",
      cases: [
        { id: "iq-matrix-calculus-backprop-0", label: "Case 1", visible: true, args: [[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], [[1.0, 0.0], [0.0, 1.0]]] },
        { id: "iq-matrix-calculus-backprop-1", label: "Case 2", visible: true, args: [[[2.0, 3.0]], [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], [[1.0, 0.0, -1.0]]] },
        { id: "iq-matrix-calculus-backprop-2", label: "Hidden 1", visible: false, args: [[[1.0], [2.0], [3.0]], [[2.0]], [[1.0], [2.0], [3.0]]] },
        { id: "iq-matrix-calculus-backprop-3", label: "Hidden 2", visible: false, args: [[[0.5, -1.0, 2.0], [1.5, 0.0, -0.5]], [[1.0, -2.0], [0.5, 0.25], [-1.0, 3.0]], [[0.1, 0.2], [-0.3, 0.4]]] },
      ],
      reference: `
def linear_backward(X, W, dY):
    N = len(X)
    D = len(W)
    M = len(W[0])
    dX = [[sum(dY[n][m] * W[d][m] for m in range(M)) for d in range(D)]
          for n in range(N)]
    dW = [[sum(X[n][d] * dY[n][m] for n in range(N)) for m in range(M)]
          for d in range(D)]
    db = [sum(dY[n][m] for n in range(N)) for m in range(M)]
    return [dX, dW, db]
`,
      template: `
def linear_backward(X, W, dY):
    """
    :type X: List[List[float]]   -- (N, D)
    :type W: List[List[float]]   -- (D, M)
    :type dY: List[List[float]]  -- (N, M)
    :rtype: List  -- [dX (N,D), dW (D,M), db (M,)]
    """
`,
    },
    statement: {
      orderIndex: 18,
      description: "A linear layer computes `Y = X @ W + b`, where `X` has shape `(N, D)`, `W` has shape `(D, M)`, `b` has shape `(M,)` and is added to every row, and `Y` has shape `(N, M)`.\n\nGiven `X`, `W` and the incoming gradient `dY` (shape `(N, M)`), return `[dX, dW, db]` with shapes `(N, D)`, `(D, M)` and `(M,)` respectively.\n\nDerive them entrywise from `Y[n][m] = sum_d X[n][d] * W[d][m]` and then check each result against the shapes — for each gradient there is only one product of the available matrices that comes out with the right shape, which is both the fastest way to get it right and the fastest way to check it.\n\nEdge cases and rounding:\n\n- `db` accumulates over the batch: it is a **sum** down the `N` rows of `dY`, not a mean. The two agree when `N = 1`, so the mistake only shows up on a real batch.\n- Note which of `X` and `W` each gradient needs. The one required by the weight gradient is what a framework must keep alive from the forward pass, and that is where activation memory goes.\n- Values may be negative and non-integral. Round every value to 6 decimal places.\n- The driver prints `dX`, then `dW`, then `db`, one per line.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "X = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], W = [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dY = [[1.0, 0.0], [0.0, 1.0]]", output: "[[1.0, 0.0, 1.0], [0.0, 1.0, 1.0]]\n[[1.0, 4.0], [2.0, 5.0], [3.0, 6.0]]\n[1.0, 1.0]", explanation: "dY is the identity here, so dX picks out rows of W transposed and dW reduces to X transposed. db is the column sums of dY." },
        { input: "X = [[2.0, 3.0]], W = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dY = [[1.0, 0.0, -1.0]]", output: "[[-2.0, -2.0]]\n[[2.0, 0.0, -2.0], [3.0, 0.0, -3.0]]\n[1.0, 0.0, -1.0]", explanation: "N=1, D=2, M=3 are all distinct, so a swapped transpose does not even produce the right shape." },
      ],
      constraints: ["1 <= N, D, M <= 60", "X is (N, D), W is (D, M), dY is (N, M).", "db is a sum over the batch, not a mean.", "Round every value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["X", "W", "dY"],
    },
  },
  {
    questionSlug: "expectation-of-dropout",
    problem: {
      id: "iq-expectation-of-dropout",
      title: "Compute the moments inverted dropout leaves behind",
      summary: "Inverted dropout replaces each activation `a_i` with `c * m_i * a_i`, where `m_i ~ Bernoulli(1 - p)` is 1 when the unit is kept, the masks are independent across units, and `c` is a constant chosen so the training-time expectation matches what the plain network produces at inference.",
      entry: "dropout_moments",
      difficulty: "easy",
      categories: ["DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) + 0.0 for x in _r]",
      cases: [
        { id: "iq-expectation-of-dropout-0", label: "Case 1", visible: true, args: [[1.0, 2.0], 0.5, "train"] },
        { id: "iq-expectation-of-dropout-1", label: "Case 2", visible: true, args: [[1.0, 2.0], 0.5, "eval"] },
        { id: "iq-expectation-of-dropout-2", label: "Hidden 1", visible: false, args: [[1.0, -2.0, 3.0], 0.8, "train"] },
        { id: "iq-expectation-of-dropout-3", label: "Hidden 2", visible: false, args: [[1.0, 2.0, 3.0], 0.0, "train"] },
        { id: "iq-expectation-of-dropout-4", label: "Hidden 3", visible: false, args: [[-1.0, -2.0, 4.0], 0.9, "eval"] },
        { id: "iq-expectation-of-dropout-5", label: "Hidden 4", visible: false, args: [[3.0, -4.0], 0.25, "train"] },
      ],
      reference: `
def dropout_moments(a, p, mode):
    total = float(sum(a))
    if mode == "eval":
        return [1.0, total, 0.0]
    scale = 1.0 / (1.0 - p)
    var = (p / (1.0 - p)) * sum(x * x for x in a)
    return [scale, total, var]
`,
      template: `
def dropout_moments(a, p, mode):
    """
    :type a: List[float]
    :type p: float
    :type mode: str  -- "train" or "eval"
    :rtype: List[float]  -- [scale, mean, var]
    """
`,
    },
    statement: {
      orderIndex: 19,
      description: "Inverted dropout replaces each activation `a_i` with `c * m_i * a_i`, where `m_i ~ Bernoulli(1 - p)` is 1 when the unit is kept, the masks are independent across units, and `c` is a constant chosen so the training-time expectation matches what the plain network produces at inference.\n\nGiven the activations `a`, the drop probability `p` and a `mode` of `\"train\"` or `\"eval\"`, return `[scale, mean, var]` for the summed output `S = sum_i output_i`:\n\n- `scale` — the constant `c`. Derive it by requiring `E[c * m_i * a_i] = a_i`, given `E[m_i] = 1 - p`.\n- `mean` — `E[S]`.\n- `var` — `Var(S)`. The masks are independent so the per-unit variances add, and `Var(m_i) = p * (1 - p)`.\n\nIn `\"eval\"` mode dropout is switched off completely: no mask, no scaling. `scale` is `1.0`, `mean` is the plain sum, and `var` is `0.0`. That the deployed graph is the plain network is exactly why the correction is put on the training side.\n\nEdge cases and rounding:\n\n- `p = 0` is legal in `\"train\"` mode and must not divide by zero in spirit or in fact: scale `1.0`, variance `0.0`.\n- Activations may be negative. The mean depends on their signed sum, the variance on their squares, so a sign error shows up in only one of the two.\n- Round all three values to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "a = [1.0, 2.0], p = 0.5, mode = \"train\"", output: "[2.0, 3.0, 5.0]", explanation: "c(1-p) = 1 gives c = 2, so survivors are doubled. The mean is preserved at 1 + 2 = 3. Var(S) = c^2 * p(1-p) * (1^2 + 2^2) = 4 * 0.25 * 5 = 5." },
        { input: "a = [1.0, 2.0], p = 0.5, mode = \"eval\"", output: "[1.0, 3.0, 0.0]", explanation: "Same mean, zero variance. Only the mean is shared between the two modes — the distribution is not preserved, and the gap is the regularisation." },
      ],
      constraints: ["1 <= len(a) <= 10^4", "0 <= p < 1", "mode is \"train\" or \"eval\"", "The mean must be identical in both modes.", "Round all three values to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["a", "p", "mode"],
    },
  },
  {
    questionSlug: "derive-layernorm-backward",
    problem: {
      id: "iq-derive-layernorm-backward",
      title: "Push a gradient back through LayerNorm",
      summary: "For one row `x` of length `H`, the layer computes",
      entry: "layernorm_backward",
      difficulty: "hard",
      categories: ["DL", "CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[[round(float(v), 6) + 0.0 for v in row] for row in _r]",
      cases: [
        { id: "iq-derive-layernorm-backward-0", label: "Case 1", visible: true, args: [[2.0, -2.0, 2.0, -2.0], [1.0, 0.0, 0.0, 0.0], [1.0, 1.0, 1.0, 1.0], 0.0] },
        { id: "iq-derive-layernorm-backward-1", label: "Case 2", visible: true, args: [[2.0, -2.0, 2.0, -2.0], [1.0, 1.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0] },
        { id: "iq-derive-layernorm-backward-2", label: "Hidden 1", visible: false, args: [[1.0, 2.0, 3.0], [0.1, -0.2, 0.3], [1.0, 1.0, 1.0], 1e-05] },
        { id: "iq-derive-layernorm-backward-3", label: "Hidden 2", visible: false, args: [[1.0, 2.0, 3.0, 4.0], [0.5, -0.5, 1.0, 0.0], [2.0, 0.5, -1.0, 3.0], 1e-05] },
        { id: "iq-derive-layernorm-backward-4", label: "Hidden 3", visible: false, args: [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [1.0, 1.0, 1.0], 0.0001] },
        { id: "iq-derive-layernorm-backward-5", label: "Hidden 4", visible: false, args: [[5.0, 1.0], [1.0, -1.0], [1.0, 1.0], 0.0] },
      ],
      reference: `
import math

def layernorm_backward(x, dy, gamma, eps):
    H = len(x)
    mu = sum(x) / float(H)
    var = sum((xi - mu) ** 2 for xi in x) / float(H)
    sigma = math.sqrt(var + eps)
    xhat = [(xi - mu) / sigma for xi in x]
    dgamma = [dy[i] * xhat[i] for i in range(H)]
    dbeta = [float(v) for v in dy]
    g = [dy[i] * gamma[i] for i in range(H)]
    mean_g = sum(g) / float(H)
    mean_gx = sum(g[i] * xhat[i] for i in range(H)) / float(H)
    dx = [(g[i] - mean_g - xhat[i] * mean_gx) / sigma for i in range(H)]
    return [dx, dgamma, dbeta]
`,
      template: `
import math

def layernorm_backward(x, dy, gamma, eps):
    """
    :type x: List[float]
    :type dy: List[float]
    :type gamma: List[float]
    :type eps: float
    :rtype: List[List[float]]  -- [dx, dgamma, dbeta]
    """
`,
    },
    statement: {
      orderIndex: 20,
      description: "For one row `x` of length `H`, the layer computes\n\n```\nmu    = mean(x)\nvar   = mean((x_i - mu)**2)      # population variance: divide by H\nsigma = sqrt(var + eps)\nxhat  = (x - mu) / sigma\ny     = gamma * xhat + beta\n```\n\nGiven `x`, the incoming gradient `dy = dL/dy`, the gain `gamma` and `eps`, return `[dx, dgamma, dbeta]`, each a list of length `H`.\n\n`dgamma` and `dbeta` are the straightforward two. For `dx`, every `x_i` reaches the loss three ways — directly, through `mu`, and through `var` — so with `g = dy * gamma`:\n\n```\ndx_i = (1/sigma) * ( g_i - mean(g) - xhat_i * mean(g * xhat) )\n```\n\nDeriving those two correction terms is the question. Treating `mu` and `sigma` as constants gives `dx = g / sigma`, which is wrong but still trains, so a loss curve will never tell you.\n\nEdge cases and rounding:\n\n- Use the **biased** variance (divide by `H`, not `H - 1`).\n- `eps` may be `0.0` when the row has spread; it is what keeps a constant row finite.\n- Self-checks: `sum(dx)` is always 0, and with `eps = 0` the dot product of `dx` with `xhat` is 0 as well. If `g` is constant across the row, `dx` is all zeros — the layer is invariant to a uniform shift, so the loss cannot change along it.\n- Round every value to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "x = [2.0, -2.0, 2.0, -2.0], dy = [1.0, 0.0, 0.0, 0.0], gamma = [1.0, 1.0, 1.0, 1.0], eps = 0.0", output: "[[0.25, 0.0, -0.25, 0.0], [1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]]", explanation: "mu = 0, var = 4, sigma = 2, xhat = [1, -1, 1, -1]. mean(g) = 0.25 and mean(g*xhat) = 0.25, so dx = ([1,0,0,0] - 0.25 - xhat*0.25)/2 = [0.25, 0, -0.25, 0]. It sums to zero and is orthogonal to xhat. Treating the statistics as constants would give [0.5, 0, 0, 0] instead." },
        { input: "x = [2.0, -2.0, 2.0, -2.0], dy = [1.0, 1.0, 1.0, 1.0], gamma = [1.0, 1.0, 1.0, 1.0], eps = 0.0", output: "[[0.0, 0.0, 0.0, 0.0], [1.0, -1.0, 1.0, -1.0], [1.0, 1.0, 1.0, 1.0]]", explanation: "A constant incoming gradient points purely along the direction the layer is invariant to, so dx is exactly zero. The wrong version returns 0.5 everywhere, which is the clearest way to see that the correction terms are not optional." },
      ],
      constraints: ["2 <= H <= 10^3", "eps >= 0", "Use the biased (divide by H) variance.", "dx must sum to 0.", "Round every value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["x", "dy", "gamma", "eps"],
    },
  },
  {
    questionSlug: "derive-rope-relative",
    problem: {
      id: "iq-derive-rope-relative",
      title: "Rotate q and k by position, then dot them",
      summary: "Rotary position embedding rotates a query vector by its absolute position and a key vector by its own, and the property that makes it useful is that the resulting dot product depends only on the offset between the two positions. Write the function that produces that dot product, so the property becomes testable.",
      entry: "rope_dot",
      difficulty: "hard",
      categories: ["LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "round(float(_r), 6)",
      cases: [
        { id: "iq-derive-rope-relative-0", label: "Case 1", visible: true, args: [[1.0, 0.0], [0.0, 1.0], 1, 0, 10000.0] },
        { id: "iq-derive-rope-relative-1", label: "Case 2", visible: true, args: [[1.0, 0.0, 0.0, 1.0], [0.0, 1.0, 1.0, 0.0], 3, 1, 10000.0] },
        { id: "iq-derive-rope-relative-2", label: "Hidden 1", visible: false, args: [[1.0, 0.0], [0.0, 1.0], 101, 100, 10000.0] },
        { id: "iq-derive-rope-relative-3", label: "Hidden 2", visible: false, args: [[0.5, -1.5, 2.0, 0.25], [1.0, 2.0, -0.5, 3.0], 7, 7, 10000.0] },
        { id: "iq-derive-rope-relative-4", label: "Hidden 3", visible: false, args: [[0.5, -1.5, 2.0, 0.25, 1.0, -1.0, 0.75, 0.5], [1.0, 2.0, -0.5, 3.0, 0.25, 0.5, -2.0, 1.5], 0, 5, 500000.0] },
        { id: "iq-derive-rope-relative-5", label: "Hidden 4", visible: false, args: [[0.5, -1.5, 2.0, 0.25, 1.0, -1.0, 0.75, 0.5], [1.0, 2.0, -0.5, 3.0, 0.25, 0.5, -2.0, 1.5], 9, 14, 500000.0] },
      ],
      reference: `
import math

def rope_dot(q, k, m, n, base):
    return sum(a * b for a, b in zip(_rot(q, m, base), _rot(k, n, base)))

def _rot(x, pos, base):
    d = len(x)
    out = [0.0] * d
    for i in range(d // 2):
        theta = base ** (-2.0 * i / d)
        a = pos * theta
        c, s = math.cos(a), math.sin(a)
        x0, x1 = x[2 * i], x[2 * i + 1]
        out[2 * i] = x0 * c - x1 * s
        out[2 * i + 1] = x0 * s + x1 * c
    return out
`,
      template: `
import math

def rope_dot(q, k, m, n, base):
    """
    :type q: List[float]
    :type k: List[float]
    :type m: int
    :type n: int
    :type base: float
    :rtype: float
    """
`,
    },
    statement: {
      orderIndex: 21,
      description: "Rotary position embedding rotates a query vector by its absolute position and a key vector by its own, and the property that makes it useful is that the resulting dot product depends only on the offset between the two positions. Write the function that produces that dot product, so the property becomes testable.\n\n`rope_dot(self, q, k, m, n, base) -> float`\n\n`q` and `k` are flat lists of the same even length `d`. `m` is the position of `q`, `n` is the position of `k`, and `base` sets the frequency schedule.\n\n**Pairing.** Split a vector into adjacent 2-D pairs: `(x[0], x[1])`, `(x[2], x[3])`, ..., `(x[d-2], x[d-1])`. Pair `i` (0-indexed, `0 <= i < d/2`) gets frequency\n\n```\ntheta_i = base ** (-2 * i / d)\n```\n\n**Rotation.** At position `p`, pair `i` is rotated by the angle `a = p * theta_i`:\n\n```\ny[2i]   = x[2i] * cos(a) - x[2i+1] * sin(a)\ny[2i+1] = x[2i] * sin(a) + x[2i+1] * cos(a)\n```\n\nRotate `q` at position `m`, rotate `k` at position `n`, and return `sum(q_rot[j] * k_rot[j] for j in range(d))`. The driver rounds to 6 decimals.\n\n**Why the tests look the way they do.** Each 2-D rotation is orthogonal and rotations compose by adding angles, so `<R(m)q, R(n)k> = q^T R(n - m) k`. Two hidden cases hold `n - m` fixed while sliding both positions, and one sets `m == n`, where the answer must collapse to the plain dot product `q . k`. An implementation that pairs `x[i]` with `x[i + d/2]`, or that writes the frequency as `base ** (-i / d)`, still passes a `d = 2` case and fails these.\n\nPositions are non-negative integers and may exceed any training length; the formula is defined everywhere, so nothing special happens at large `p`.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "q = [1.0, 0.0], k = [0.0, 1.0], m = 1, n = 0, base = 10000.0", output: "0.841471", explanation: "d = 2 is a single pair with theta_0 = base^0 = 1. q rotates by 1 radian to (cos 1, sin 1); k sits at position 0 and does not move. The dot product is sin(1) = 0.841471." },
        { input: "q = [1.0, 0.0], k = [0.0, 1.0], m = 101, n = 100, base = 10000.0", output: "0.841471", explanation: "Same offset, both positions moved by 100. The answer is bit-for-bit the same, which is the property being tested." },
      ],
      constraints: ["2 <= d <= 512, and d is even", "0 <= m, n <= 10^6", "base > 1", "Pair x[2i] with x[2i+1]; theta_i = base ** (-2*i/d)", "Round to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["q", "k", "m", "n", "base"],
    },
  },
  {
    questionSlug: "attention-vs-ffn-crossover",
    problem: {
      id: "iq-attention-vs-ffn-crossover",
      title: "Find the length where attention FLOPs overtake everything else",
      summary: "For a single transformer layer with model dimension `d`, sequence length `n`, and a feed-forward hidden size of `ffn_ratio * d`, count forward-pass FLOPs and locate the point where the quadratic term takes over.",
      entry: "flop_crossover",
      difficulty: "medium",
      categories: ["LLM", "CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), int(round(_r[1])), int(round(_r[2])), round(float(_r[3]), 6)]",
      cases: [
        { id: "iq-attention-vs-ffn-crossover-0", label: "Case 1", visible: true, args: [1024, 4.0, 6144] },
        { id: "iq-attention-vs-ffn-crossover-1", label: "Case 2", visible: true, args: [4096, 4.0, 131072] },
        { id: "iq-attention-vs-ffn-crossover-2", label: "Hidden 1", visible: false, args: [4096, 4.0, 2048] },
        { id: "iq-attention-vs-ffn-crossover-3", label: "Hidden 2", visible: false, args: [8192, 2.6875, 40960] },
        { id: "iq-attention-vs-ffn-crossover-4", label: "Hidden 3", visible: false, args: [512, 8.0, 5120] },
      ],
      reference: `
import math

def flop_crossover(d_model, ffn_ratio, seq_len):
    d = float(d_model)
    n = float(seq_len)
    n_star = int(math.ceil((2.0 + ffn_ratio) * d))
    quad = 4.0 * n * n * d
    lin = (8.0 + 4.0 * ffn_ratio) * n * d * d
    return [n_star, quad, lin, quad / lin]
`,
      template: `
import math

def flop_crossover(d_model, ffn_ratio, seq_len):
    """
    :type d_model: int
    :type ffn_ratio: float
    :type seq_len: int
    :rtype: List[float]  -- [n_star, quad_flops, lin_flops, ratio]
    """
`,
    },
    statement: {
      orderIndex: 22,
      description: "For a single transformer layer with model dimension `d`, sequence length `n`, and a feed-forward hidden size of `ffn_ratio * d`, count forward-pass FLOPs and locate the point where the quadratic term takes over.\n\n`flop_crossover(self, d_model, ffn_ratio, seq_len) -> list`\n\nReturn `[n_star, quad_flops, lin_flops, ratio]`.\n\n**FLOP model.** A matmul producing an `A x B` output with inner dimension `C` costs `2*A*B*C`. Writing `d = d_model`, `r = ffn_ratio`, `n = seq_len`:\n\n| term | shape | FLOPs |\n| --- | --- | --- |\n| scores `Q K^T` | `n x n`, inner `d` | `2*n*n*d` |\n| value matmul | `n x d`, inner `n` | `2*n*n*d` |\n| Q, K, V, O projections | four of `n x d`, inner `d` | `8*n*d*d` |\n| feed-forward, two matrices | `d -> r*d -> d` | `4*r*n*d*d` |\n\nSo `quad = 4*n*n*d` and `lin = (8 + 4*r) * n * d * d`. Ignore softmax, normalisation, biases and activations: they are `O(n*d)` and do not move the crossover.\n\n**Crossover.** `n_star` is the smallest integer `n` satisfying `quad >= lin`. Solve `4*n*n*d >= (8 + 4*r)*n*d*d` for `n` and take the ceiling. It is a multiple of `d` and does **not** depend on `seq_len`.\n\n**Ratio.** `ratio = quad / lin` evaluated at `seq_len`, above 1 exactly when the sequence is past the crossover.\n\nThe point of the exercise is that \"attention is quadratic\" says nothing about where the quadratic term actually bites -- the constants decide, and the answer scales with `d`, not with some fixed token count.\n\n`quad_flops` and `lin_flops` are exact FLOP counts and the driver prints them as integers; `ratio` is rounded to 6 decimals. `ffn_ratio` may be fractional.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "d_model = 1024, ffn_ratio = 4.0, seq_len = 6144", output: "[6144, 154618822656, 154618822656, 1.0]", explanation: "6144 = 6 * 1024 is exactly the crossover, so both terms are 154618822656 FLOPs and the ratio is exactly 1." },
        { input: "d_model = 4096, ffn_ratio = 4.0, seq_len = 131072", output: "[24576, 281474976710656, 52776558133248, 5.333333]", explanation: "At d = 4096 the crossover is 24576 tokens, not a few hundred. A 128k sequence is 5.33x past it -- and note the ratio is just seq_len / n_star." },
      ],
      constraints: ["64 <= d_model <= 65536", "0 < ffn_ratio <= 16 (may be fractional)", "1 <= seq_len <= 10^7", "n_star must not depend on seq_len.", "ratio rounded to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["d_model", "ffn_ratio", "seq_len"],
    },
  },
  {
    questionSlug: "logsumexp-stability",
    problem: {
      id: "iq-logsumexp-stability",
      title: "Merge log-sum-exp across tiles seen one at a time",
      summary: "A tiled attention kernel never materialises a whole score row: it sees the row in chunks and has to combine partial results as it goes. Implement that combination for log-sum-exp.",
      entry: "streaming_lse",
      difficulty: "medium",
      categories: ["LLM", "DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-logsumexp-stability-0", label: "Case 1", visible: true, args: [[[0.0], [1.0]]] },
        { id: "iq-logsumexp-stability-1", label: "Case 2", visible: true, args: [[[0.0, 0.0], [10.0]]] },
        { id: "iq-logsumexp-stability-2", label: "Hidden 1", visible: false, args: [[[1000.0, 1001.0], [999.0]]] },
        { id: "iq-logsumexp-stability-3", label: "Hidden 2", visible: false, args: [[[3.0, 1.0], [], [-5.0, 2.0], [8.0]]] },
        { id: "iq-logsumexp-stability-4", label: "Hidden 3", visible: false, args: [[[-800.0, -799.0]]] },
        { id: "iq-logsumexp-stability-5", label: "Hidden 4", visible: false, args: [[[5.0], [4.0], [3.0], [2.0]]] },
      ],
      reference: `
import math

def streaming_lse(tiles):
    m = None
    s = 0.0
    for tile in tiles:
        if not tile:
            continue
        tm = max(tile)
        if m is None:
            m = tm
            s = sum(math.exp(z - m) for z in tile)
        else:
            if tm > m:
                s *= math.exp(m - tm)
                m = tm
            s += sum(math.exp(z - m) for z in tile)
    return [m, s, m + math.log(s)]
`,
      template: `
import math

def streaming_lse(tiles):
    """
    :type tiles: List[List[float]]
    :rtype: List[float]  -- [m, s, m + log(s)]
    """
`,
    },
    statement: {
      orderIndex: 23,
      description: "A tiled attention kernel never materialises a whole score row: it sees the row in chunks and has to combine partial results as it goes. Implement that combination for log-sum-exp.\n\n`streaming_lse(self, tiles) -> list`\n\n`tiles` is a list of lists of floats. Concatenated in order they form one score row `z`. Process the tiles **in order**, carrying exactly two running values:\n\n- `m` -- the largest score seen so far\n- `s` -- `sum(exp(z_j - m))` over every score seen so far\n\nReturn `[m, s, m + log(s)]`, each rounded to 6 decimals by the driver. The third value is `log(sum(exp(z_j)))` over the entire row.\n\n**The rescale.** Suppose you hold `(m_old, s_old)` and the next tile's own maximum `m_new` is larger. Every term inside `s_old` was divided by `exp(m_old)`; against the new reference they must be divided by `exp(m_new)` instead, so\n\n```\ns = s_old * exp(m_old - m_new)\n```\n\nand only then do you add `sum(exp(z - m_new))` for the new tile. When the tile's maximum is not larger, `m` is unchanged and you simply add. The factor is always `<= 1`, so `s` never grows on a rescale.\n\n**Why it is written this way.** `exp` overflows a float64 above roughly 709, so a row containing a score of 1000 makes a direct `log(sum(exp(z)))` raise `OverflowError`; a row of very negative scores underflows to 0 and then `log(0)` raises `ValueError`. Subtracting the running maximum pins the largest term at exactly `exp(0) = 1` and keeps every other term in `(0, 1]`, so neither happens. One hidden case is built from scores near 1000 and one from scores near -800.\n\nThis is also why the score matrix never has to exist: two running scalars per row are enough to reconstruct the exact same answer a single pass over the full row would give.\n\n**Edge cases.** A tile may be empty and must be skipped without disturbing `m` or `s`. At least one score exists across all tiles. Scores may repeat, and the maximum may arrive in the first tile or the last.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "tiles = [[0.0], [1.0]]", output: "[1.0, 1.367879, 1.313262]", explanation: "After tile 1: m = 0, s = 1. Tile 2's maximum is 1 > 0, so s becomes 1*exp(0-1) = 0.367879, then adding exp(1-1) = 1 gives 1.367879. The result 1 + log(1.367879) = 1.313262 equals log(e^0 + e^1)." },
        { input: "tiles = [[0.0, 0.0], [10.0]]", output: "[10.0, 1.000091, 10.000091]", explanation: "Skipping the rescale would leave s = 2 + 1 = 3 and an answer of 11.098612 -- nearly a full nat wrong, from one missing factor." },
      ],
      constraints: ["1 <= number of tiles <= 10^3", "0 <= len(tile) <= 10^3; at least one score exists overall", "-1000 <= score <= 1000", "Empty tiles must be skipped without disturbing m or s.", "Never exponentiate a raw score.", "Round each returned value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["tiles"],
    },
  },
  {
    questionSlug: "decode-throughput-arithmetic",
    problem: {
      id: "iq-decode-throughput-arithmetic",
      title: "Bound decode throughput from memory bandwidth",
      summary: "During autoregressive decoding a step produces one token per sequence, and what limits it is how fast bytes leave HBM, not arithmetic. Size that bound.",
      entry: "decode_throughput",
      difficulty: "hard",
      categories: ["LLM", "CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(round(_r[0])), round(float(_r[1]), 6), round(float(_r[2]), 6)]",
      cases: [
        { id: "iq-decode-throughput-arithmetic-0", label: "Case 1", visible: true, args: [7000000000.0, 2.0, 0.0, 1, 2000000000000.0, 1.0] },
        { id: "iq-decode-throughput-arithmetic-1", label: "Case 2", visible: true, args: [7000000000.0, 2.0, 4000000000.0, 4, 2000000000000.0, 1.0] },
        { id: "iq-decode-throughput-arithmetic-2", label: "Hidden 1", visible: false, args: [7000000000.0, 2.0, 0.0, 64, 2000000000000.0, 1.0] },
        { id: "iq-decode-throughput-arithmetic-3", label: "Hidden 2", visible: false, args: [7000000000.0, 2.0, 0.0, 1, 2000000000000.0, 0.65] },
        { id: "iq-decode-throughput-arithmetic-4", label: "Hidden 3", visible: false, args: [70000000000.0, 1.0, 1000000000.0, 32, 3350000000000.0, 0.7] },
      ],
      reference: `
def decode_throughput(params, dtype_bytes, kv_bytes_per_seq, batch, bandwidth, efficiency):
    weight_bytes = params * dtype_bytes
    bytes_per_step = weight_bytes + batch * kv_bytes_per_seq
    effective = bandwidth * efficiency
    seconds_per_step = bytes_per_step / effective
    return [bytes_per_step, batch / seconds_per_step, 1000.0 * seconds_per_step]
`,
      template: `
def decode_throughput(params, dtype_bytes, kv_bytes_per_seq, batch, bandwidth, efficiency):
    """
    :type params: float
    :type dtype_bytes: float
    :type kv_bytes_per_seq: float
    :type batch: int
    :type bandwidth: float
    :type efficiency: float
    :rtype: List[float]  -- [bytes_per_step, tokens_per_s, ms_per_token]
    """
`,
    },
    statement: {
      orderIndex: 24,
      description: "During autoregressive decoding a step produces one token per sequence, and what limits it is how fast bytes leave HBM, not arithmetic. Size that bound.\n\n`decode_throughput(self, params, dtype_bytes, kv_bytes_per_seq, batch, bandwidth, efficiency) -> list`\n\n| argument | meaning |\n| --- | --- |\n| `params` | parameter count, e.g. `7e9` |\n| `dtype_bytes` | bytes per stored weight (2 for bf16, 1 for int8) |\n| `kv_bytes_per_seq` | KV cache bytes for **one** sequence at its current length |\n| `batch` | sequences decoded together in a single step |\n| `bandwidth` | peak memory bandwidth in bytes/s, e.g. `2e12` |\n| `efficiency` | achieved fraction of peak, in `(0, 1]` |\n\nReturn `[bytes_per_step, tokens_per_s, ms_per_token]`:\n\n```\nbytes_per_step   = params * dtype_bytes + batch * kv_bytes_per_seq\nseconds_per_step = bytes_per_step / (bandwidth * efficiency)\ntokens_per_s     = batch / seconds_per_step     # aggregate, all sequences\nms_per_token     = 1000 * seconds_per_step      # what one user waits\n```\n\n**What scales with batch.** Every weight is read once per step and reused across all `batch` sequences, so the weight term carries no `batch` factor. A KV cache is private to its sequence and every byte is re-read each step, so that term does. This is precisely why batching lifts aggregate throughput without lifting per-user latency -- and why the gain flattens once `batch * kv_bytes_per_seq` approaches the weight bytes, which is the arithmetic that makes grouped-query attention worth a small quality cost.\n\n**Compute never appears.** A decode step does roughly `2 * params` FLOPs while moving at least `params * dtype_bytes` bytes, so arithmetic intensity sits near 1 FLOP per byte against hardware that wants hundreds. Answering this with a FLOP bound gives a number that is wrong by orders of magnitude.\n\n`bytes_per_step` is printed as an integer; `tokens_per_s` and `ms_per_token` are rounded to 6 decimals.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "params = 7e9, dtype_bytes = 2, kv_bytes_per_seq = 0, batch = 1, bandwidth = 2e12, efficiency = 1.0", output: "[14000000000, 142.857143, 7.0]", explanation: "14 GB of bf16 weights at 2 TB/s takes 7 ms, capping a single sequence at about 143 tokens/s. Real kernels reach 60-70% of peak, so 90-100 tok/s in practice." },
        { input: "params = 7e9, dtype_bytes = 2, kv_bytes_per_seq = 4e9, batch = 4, bandwidth = 2e12, efficiency = 1.0", output: "[30000000000, 266.666667, 15.0]", explanation: "Four sequences each dragging a 4 GB cache add 16 GB to the 14 GB of weights. Throughput rises only 1.87x for a 4x batch because the cache now outweighs the model." },
      ],
      constraints: ["params > 0 and dtype_bytes > 0", "kv_bytes_per_seq >= 0", "1 <= batch <= 10^4", "bandwidth > 0 and 0 < efficiency <= 1", "Weight bytes are read once per step, not once per sequence.", "tokens_per_s and ms_per_token rounded to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["params", "dtype_bytes", "kv_bytes_per_seq", "batch", "bandwidth", "efficiency"],
    },
  },
  {
    questionSlug: "perplexity-and-loss",
    problem: {
      id: "iq-perplexity-and-loss",
      title: "Turn log-likelihoods into perplexity and bits-per-byte",
      summary: "A language-model eval reports a loss and a perplexity, and those two numbers are one quantity in different clothes. Compute both, plus the version that survives a change of tokeniser.",
      entry: "eval_metrics",
      difficulty: "medium",
      categories: ["LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-perplexity-and-loss-0", label: "Case 1", visible: true, args: [[-2.5, -2.5], 8] },
        { id: "iq-perplexity-and-loss-1", label: "Case 2", visible: true, args: [[-0.6931471805599453], 1] },
        { id: "iq-perplexity-and-loss-2", label: "Hidden 1", visible: false, args: [[-1.0, -2.0, -3.0], 12] },
        { id: "iq-perplexity-and-loss-3", label: "Hidden 2", visible: false, args: [[-10.373491, -10.373491, -10.373491, -10.373491], 16] },
        { id: "iq-perplexity-and-loss-4", label: "Hidden 3", visible: false, args: [[-0.1, -0.2, -0.3, -0.4, -5.0], 23] },
      ],
      reference: `
import math

def eval_metrics(logprobs, n_bytes):
    total = -sum(logprobs)
    loss = total / len(logprobs)
    ppl = math.exp(loss)
    bpb = total / (n_bytes * math.log(2.0))
    return [loss, ppl, bpb]
`,
      template: `
import math

def eval_metrics(logprobs, n_bytes):
    """
    :type logprobs: List[float]
    :type n_bytes: int
    :rtype: List[float]  -- [loss_nats, perplexity, bits_per_byte]
    """
`,
    },
    statement: {
      orderIndex: 25,
      description: "A language-model eval reports a loss and a perplexity, and those two numbers are one quantity in different clothes. Compute both, plus the version that survives a change of tokeniser.\n\n`eval_metrics(self, logprobs, n_bytes) -> list`\n\n`logprobs[i]` is `log p(x_i | x_<i)` in **nats** (natural log, so every entry is `<= 0`). `n_bytes` is the number of UTF-8 bytes the same text occupies.\n\nReturn `[loss_nats, perplexity, bits_per_byte]`, each rounded to 6 decimals:\n\n```\ntotal         = -sum(logprobs)                 # total negative log-likelihood, nats\nloss_nats     = total / len(logprobs)          # per TOKEN\nperplexity    = exp(loss_nats)\nbits_per_byte = total / (n_bytes * log(2))     # per BYTE, in bits\n```\n\n**Base.** `exp` applies to a loss in nats; `2**L` applies to a loss in bits. `L` nats equals `L / log(2)` bits, and the two conventions agree only when the base matches the unit. Applying `2**L` to a loss in nats produces a number that looks entirely reasonable and is wrong.\n\n**Normaliser.** Perplexity is per token; bits-per-byte is per byte. Divide the *total* by `n_bytes` -- not the per-token loss, which is already divided by a different denominator. The two differ by exactly the tokeniser's bytes-per-token ratio, and that ratio is the whole reason bits-per-byte exists: a model with a larger vocabulary spends fewer tokens on the same text, so each token carries more information and perplexity rises with no change in modelling quality, while bits-per-byte is unmoved because the byte count is a property of the text, not of the tokeniser.\n\n**Reading the number.** Perplexity is an effective branching factor -- the model is as uncertain as if picking uniformly among that many tokens. A uniform model over a vocabulary of size `V` scores exactly `V`, which gives the standard sanity check: an untrained run on a 32k vocabulary should start near `loss = log(32000) = 10.37` nats. One hidden case is exactly that check.\n\n`len(logprobs) >= 1` and `n_bytes >= 1`, so neither denominator is zero.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "logprobs = [-2.5, -2.5], n_bytes = 8", output: "[2.5, 12.182494, 0.901684]", explanation: "Loss is 2.5 nats, so perplexity is e^2.5 = 12.18 -- as uncertain as a uniform choice among about 12 tokens. The 5 nats of total surprise spread over 8 bytes is 5/(8*ln 2) = 0.9 bits per byte." },
        { input: "logprobs = [-0.6931471805599453], n_bytes = 1", output: "[0.693147, 2.0, 1.0]", explanation: "One token at probability 1/2 costs ln 2 nats, which is exactly 1 bit, and it covers exactly 1 byte -- so perplexity is exactly 2 and bits-per-byte exactly 1." },
      ],
      constraints: ["1 <= len(logprobs) <= 10^5", "logprobs[i] <= 0 (natural log, nats)", "1 <= n_bytes <= 10^7", "bits_per_byte normalises the TOTAL by bytes, not the per-token loss.", "Round each returned value to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["logprobs", "n_bytes"],
    },
  },
  {
    questionSlug: "derive-infonce",
    problem: {
      id: "iq-derive-infonce",
      title: "Symmetric contrastive loss for an image-text batch",
      summary: "Write `clip_loss(image_emb, text_emb, tau)`.",
      entry: "clip_loss",
      difficulty: "medium",
      categories: ["VLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "round(float(_r), 6)",
      cases: [
        { id: "iq-derive-infonce-0", label: "Case 1", visible: true, args: [[[1.0, 0.0], [0.0, 1.0]], [[1.0, 0.0], [0.0, 1.0]], 1.0] },
        { id: "iq-derive-infonce-1", label: "Case 2", visible: true, args: [[[1.0, 0.0], [0.0, 1.0]], [[1.0, 0.0], [0.0, 1.0]], 0.5] },
        { id: "iq-derive-infonce-2", label: "Hidden 1", visible: false, args: [[[3.0, 4.0], [1.0, 0.0]], [[1.0, 0.0], [0.0, 5.0]], 1.0] },
        { id: "iq-derive-infonce-3", label: "Hidden 2", visible: false, args: [[[2.0, 0.0], [0.0, 3.0]], [[5.0, 0.0], [0.0, 7.0]], 1.0] },
        { id: "iq-derive-infonce-4", label: "Hidden 3", visible: false, args: [[[0.3, 0.4]], [[-1.0, 2.0]], 0.07] },
        { id: "iq-derive-infonce-5", label: "Hidden 4", visible: false, args: [[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], [[1.0, 1.0, 0.0], [0.0, 1.0, 1.0], [1.0, 0.0, 1.0]], 0.25] },
      ],
      reference: `
import math

def clip_loss(image_emb, text_emb, tau):
    n = len(image_emb)

    def unit(v):
        m = math.sqrt(sum(x * x for x in v))
        if m == 0.0:
            return [0.0] * len(v)
        return [x / m for x in v]

    I = [unit(v) for v in image_emb]
    T = [unit(v) for v in text_emb]
    S = [[sum(a * b for a, b in zip(I[i], T[j])) / tau for j in range(n)]
         for i in range(n)]

    def nll(row, k):
        hi = max(row)
        lse = hi + math.log(sum(math.exp(x - hi) for x in row))
        return lse - row[k]

    i2t = sum(nll(S[i], i) for i in range(n)) / n
    t2i = sum(nll([S[i][j] for i in range(n)], j) for j in range(n)) / n
    return (i2t + t2i) / 2.0
`,
      template: `
import math

def clip_loss(image_emb, text_emb, tau):
    """
    :type image_emb: List[List[float]]
    :type text_emb: List[List[float]]
    :type tau: float
    :rtype: float
    """
`,
    },
    statement: {
      orderIndex: 26,
      description: "Write `clip_loss(image_emb, text_emb, tau)`.\n\n`image_emb[i]` and `text_emb[i]` are the i-th matched pair, given as plain lists of floats of equal length. They are **not** unit vectors.\n\n1. L2-normalise every vector: `u = v / sqrt(sum(x*x))`.\n2. Build the N x N score matrix `S[i][j] = dot(u_img[i], u_txt[j]) / tau`. The N diagonal entries are the true pairs; every off-diagonal entry is a negative drawn from the same batch, so the batch *is* the negative set.\n3. Score each row -- image i choosing among N captions:\n\n   `row_i = -log( exp(S[i][i]) / sum_j exp(S[i][j]) )`\n\n4. Score each column -- caption j choosing among N images:\n\n   `col_j = -log( exp(S[j][j]) / sum_i exp(S[i][j]) )`\n\n5. Return `(mean of row_i + mean of col_j) / 2`.\n\nBoth directions are needed. Normalising along rows constrains nothing along columns, so a one-directional objective trains image-to-text retrieval and leaves text-to-image free.\n\n**Edge cases.** `N = 1` returns exactly `0.0` -- there is nothing to discriminate against, and the loss at chance is `log N`. A zero vector normalises to all zeros.\n\nReturn a float; the driver rounds it to 6 decimals.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "image_emb = [[1.0, 0.0], [0.0, 1.0]], text_emb = [[1.0, 0.0], [0.0, 1.0]], tau = 1.0", output: "0.313262", explanation: "Both sets are already unit vectors, so S = [[1, 0], [0, 1]]. Every row and every column contributes log(1 + e^-1) = 0.3132617." },
        { input: "image_emb = [[1.0, 0.0], [0.0, 1.0]], text_emb = [[1.0, 0.0], [0.0, 1.0]], tau = 0.5", output: "0.126928", explanation: "A smaller tau sharpens the same scores to [[2, 0], [0, 2]] and the loss falls to log(1 + e^-2). Multiplying by tau instead would raise it." },
      ],
      constraints: ["1 <= N <= 200, and len(image_emb) == len(text_emb) == N", "All vectors share one dimension D, 1 <= D <= 64", "0 < tau <= 100", "Normalise before scoring -- the inputs are not unit vectors.", "Score rows and columns and average the two means.", "N = 1 returns exactly 0.0.", "Round to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["image_emb", "text_emb", "tau"],
    },
  },
  {
    questionSlug: "vit-token-budget",
    problem: {
      id: "iq-vit-token-budget",
      title: "Token count and attention cost across two ViT configurations",
      summary: "Write `token_budget(side_a, patch_a, side_b, patch_b, include_cls)`.",
      entry: "token_budget",
      difficulty: "medium",
      categories: ["VLM", "CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), int(_r[1]), round(float(_r[2]), 6)]",
      cases: [
        { id: "iq-vit-token-budget-0", label: "Case 1", visible: true, args: [224, 14, 1344, 14, false] },
        { id: "iq-vit-token-budget-1", label: "Case 2", visible: true, args: [224, 14, 224, 7, false] },
        { id: "iq-vit-token-budget-2", label: "Hidden 1", visible: false, args: [224, 14, 1344, 14, true] },
        { id: "iq-vit-token-budget-3", label: "Hidden 2", visible: false, args: [224, 14, 1020, 14, false] },
        { id: "iq-vit-token-budget-4", label: "Hidden 3", visible: false, args: [1344, 14, 224, 14, false] },
      ],
      reference: `
def token_budget(side_a, patch_a, side_b, patch_b, include_cls):
    extra = 1 if include_cls else 0
    ta = (side_a // patch_a) ** 2 + extra
    tb = (side_b // patch_b) ** 2 + extra
    ratio = float(tb) / float(ta)
    return [ta, tb, ratio * ratio]
`,
      template: `
def token_budget(side_a, patch_a, side_b, patch_b, include_cls):
    """
    :type side_a: int
    :type patch_a: int
    :type side_b: int
    :type patch_b: int
    :type include_cls: bool
    :rtype: List  -- [tokens_a, tokens_b, attn_ratio]
    """
`,
    },
    statement: {
      orderIndex: 27,
      description: "Write `token_budget(side_a, patch_a, side_b, patch_b, include_cls)`.\n\nA square image of `side` pixels is cut into non-overlapping `patch x patch` squares. The grid is `side // patch` per axis -- leftover pixels along the right and bottom edges are dropped, so this is floor division, not rounding.\n\n```\ntokens = (side // patch) ** 2 + (1 if include_cls else 0)\n```\n\nSelf-attention is quadratic in the token count, so configuration B costs\n\n```\nattn_ratio = (tokens_b / tokens_a) ** 2\n```\n\ntimes what configuration A costs. Return `[tokens_a, tokens_b, attn_ratio]`.\n\n`tokens_a` and `tokens_b` are integers. The driver rounds `attn_ratio` to 6 decimals.\n\n**The class token** is one extra row that never came from a patch. It is a rounding error at 9216 tokens and a real 0.4% at 256, so including it shifts the ratio even though it barely shifts either token count.\n\n**Order matters.** The ratio is B relative to A, so a configuration B that is smaller than A must give a value below 1.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "side_a = 224, patch_a = 14, side_b = 1344, patch_b = 14, include_cls = False", output: "[256, 9216, 1296.0]", explanation: "224 // 14 = 16 giving 16^2 = 256 tokens; 1344 // 14 = 96 giving 96^2 = 9216. Six times the side is 36 times the tokens and 36^2 = 1296 times the attention cost." },
        { input: "side_a = 224, patch_a = 14, side_b = 224, patch_b = 7, include_cls = False", output: "[256, 1024, 16.0]", explanation: "Halving the patch at fixed resolution quadruples the token count, which is 16x the attention cost -- the patch size is the real resolution knob." },
      ],
      constraints: ["1 <= side_a, side_b <= 8192", "1 <= patch_a <= side_a and 1 <= patch_b <= side_b", "include_cls is a bool and adds exactly one token to each configuration", "Use floor division for the grid; leftover pixels are dropped.", "The ratio is B relative to A, not A relative to B.", "Round the ratio to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["side_a", "patch_a", "side_b", "patch_b", "include_cls"],
    },
  },
  {
    questionSlug: "modality-gap-invariance",
    problem: {
      id: "iq-modality-gap-invariance",
      title: "Measure the offset between two encoders' embedding clouds",
      summary: "A trained dual encoder places its image embeddings and its text embeddings in two narrow, separated cones on the unit sphere. The contrastive objective never penalises that separation, so it is there at step 0 and still there at convergence. Ranking across the two clouds still works, which is why retrieval is unaffected; treating a similarity as an absolute score does not.",
      entry: "modality_gap",
      difficulty: "hard",
      categories: ["VLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(x), 6) for x in _r]",
      cases: [
        { id: "iq-modality-gap-invariance-0", label: "Case 1", visible: true, args: [[[1.0, 0.0], [0.0, 1.0]], [[-1.0, 0.0], [0.0, -1.0]]] },
        { id: "iq-modality-gap-invariance-1", label: "Case 2", visible: true, args: [[[3.0, 4.0], [6.0, 8.0]], [[0.0, 2.0]]] },
        { id: "iq-modality-gap-invariance-2", label: "Hidden 1", visible: false, args: [[[1.0, 0.0], [0.0, 1.0]], [[1.0, 0.0], [0.0, 1.0]]] },
        { id: "iq-modality-gap-invariance-3", label: "Hidden 2", visible: false, args: [[[1.0, 1.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0]], [[-1.0, -1.0, 0.0], [-1.0, 0.0, -1.0]]] },
        { id: "iq-modality-gap-invariance-4", label: "Hidden 3", visible: false, args: [[[2.0, 0.0], [5.0, 0.0]], [[0.0, 4.0], [0.0, 9.0]]] },
      ],
      reference: `
import math

def modality_gap(image_emb, text_emb):
    def unit(v):
        m = math.sqrt(sum(x * x for x in v))
        if m == 0.0:
            return [0.0] * len(v)
        return [x / m for x in v]

    I = [unit(v) for v in image_emb]
    T = [unit(v) for v in text_emb]
    d = len(I[0])
    ci = [sum(v[k] for v in I) / float(len(I)) for k in range(d)]
    ct = [sum(v[k] for v in T) / float(len(T)) for k in range(d)]
    gap = math.sqrt(sum((ci[k] - ct[k]) ** 2 for k in range(d)))

    def within(X):
        n = len(X)
        if n < 2:
            return 0.0
        tot = 0.0
        cnt = 0
        for a in range(n):
            for b in range(a + 1, n):
                tot += sum(p * q for p, q in zip(X[a], X[b]))
                cnt += 1
        return tot / cnt

    cross = sum(sum(p * q for p, q in zip(a, b)) for a in I for b in T)
    cross = cross / float(len(I) * len(T))
    return [gap, within(I), within(T), cross]
`,
      template: `
import math

def modality_gap(image_emb, text_emb):
    """
    :type image_emb: List[List[float]]
    :type text_emb: List[List[float]]
    :rtype: List[float]
        [gap, mean_within_image, mean_within_text, mean_cross]
    """
`,
    },
    statement: {
      orderIndex: 28,
      description: "A trained dual encoder places its image embeddings and its text embeddings in two narrow, separated cones on the unit sphere. The contrastive objective never penalises that separation, so it is there at step 0 and still there at convergence. Ranking across the two clouds still works, which is why retrieval is unaffected; treating a similarity as an absolute score does not.\n\nWrite `modality_gap(image_emb, text_emb)` returning\n`[gap, mean_within_image, mean_within_text, mean_cross]`.\n\n1. L2-normalise every input vector: `u = v / sqrt(sum(x*x))`. The inputs are **not** unit vectors. A zero vector normalises to all zeros.\n2. `gap` is the Euclidean distance between the two centroids, where a centroid is the plain arithmetic mean of that modality's unit vectors. **Do not re-normalise the centroid** -- its shortened length is exactly the signal that the cone is wide, and rescaling it to length 1 throws that away.\n3. `mean_within_image` is the mean cosine over all unordered pairs `(a, b)` with `a < b` drawn from the image set. Self-pairs are excluded; each one would contribute a 1.0 and inflate the mean. `mean_within_text` is the same over the text set.\n4. `mean_cross` is the mean cosine over all `len(image_emb) * len(text_emb)` image-text pairs, matched pairs included.\n\nIf a modality holds fewer than 2 vectors, its within-modality mean is `0.0`.\n\nAll four values are floats; the driver rounds each to 6 decimals.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "image_emb = [[1.0, 0.0], [0.0, 1.0]], text_emb = [[-1.0, 0.0], [0.0, -1.0]]", output: "[1.414214, 0.0, 0.0, -0.5]", explanation: "The centroids are [0.5, 0.5] and [-0.5, -0.5]; their difference [1, 1] has length sqrt(2) = 1.414214. Each modality holds one pair and it is orthogonal, so both within means are 0. The four cross cosines are -1, 0, 0, -1, averaging -0.5 -- nowhere near the within-modality scale." },
        { input: "image_emb = [[3.0, 4.0], [6.0, 8.0]], text_emb = [[0.0, 2.0]]", output: "[0.632456, 1.0, 0.0, 0.8]", explanation: "Both image vectors normalise to [0.6, 0.8], so they are the same direction and the within-image mean is 1.0. A single text vector means the within-text mean is 0.0 by definition, and both cross cosines are 0.8." },
      ],
      constraints: ["1 <= len(image_emb), len(text_emb) <= 200", "All vectors share one dimension D, 1 <= D <= 64", "Normalise every vector first; the inputs are not unit length.", "The centroid is the mean of the unit vectors and is NOT re-normalised.", "Within-modality means exclude self-pairs; fewer than 2 vectors gives 0.0.", "Round each of the four values to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["image_emb", "text_emb"],
    },
  },
  {
    questionSlug: "patch-embedding-cost",
    problem: {
      id: "iq-patch-embedding-cost",
      title: "Share of a ViT spent in the patch stem",
      summary: "Write `stem_share(side, patch, channels, d, layers)`.",
      entry: "stem_share",
      difficulty: "medium",
      categories: ["VLM", "DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), int(_r[1]), round(float(_r[2]), 6), round(float(_r[3]), 6)]",
      cases: [
        { id: "iq-patch-embedding-cost-0", label: "Case 1", visible: true, args: [224, 14, 3, 1024, 24] },
        { id: "iq-patch-embedding-cost-1", label: "Case 2", visible: true, args: [224, 16, 3, 768, 12] },
        { id: "iq-patch-embedding-cost-2", label: "Hidden 1", visible: false, args: [224, 7, 3, 1024, 24] },
        { id: "iq-patch-embedding-cost-3", label: "Hidden 2", visible: false, args: [1344, 14, 3, 1024, 24] },
        { id: "iq-patch-embedding-cost-4", label: "Hidden 3", visible: false, args: [225, 14, 3, 768, 12] },
      ],
      reference: `
def stem_share(side, patch, channels, d, layers):
    n = (side // patch) ** 2
    patch_dim = patch * patch * channels
    stem_params = patch_dim * d + d
    stem_flops = 2 * n * patch_dim * d
    body_params = layers * 12 * d * d
    body_flops = layers * (24 * n * d * d + 4 * n * n * d)
    return [stem_params,
            stem_flops,
            float(stem_params) / float(stem_params + body_params),
            float(stem_flops) / float(stem_flops + body_flops)]
`,
      template: `
def stem_share(side, patch, channels, d, layers):
    """
    :type side: int
    :type patch: int
    :type channels: int
    :type d: int
    :type layers: int
    :rtype: List  -- [stem_params, stem_flops, param_share, flop_share]
    """
`,
    },
    statement: {
      orderIndex: 29,
      description: "Write `stem_share(side, patch, channels, d, layers)`.\n\nThe patch embedding, or stem, is a single linear map with bias from a flattened patch to the model width:\n\n```\nn           = (side // patch) ** 2       # tokens, no class token\npatch_dim   = patch * patch * channels\nstem_params = patch_dim * d + d\nstem_flops  = 2 * n * patch_dim * d      # 2 = one multiply plus one add\n```\n\nUse these standard per-layer figures for the transformer body:\n\n```\nlayer_params = 12 * d * d\nlayer_flops  = 24 * n * d * d + 4 * n * n * d\n\nbody_params  = layers * layer_params\nbody_flops   = layers * layer_flops\n```\n\nReturn `[stem_params, stem_flops, param_share, flop_share]` where\n\n```\nparam_share = stem_params / (stem_params + body_params)\nflop_share  = stem_flops  / (stem_flops  + body_flops)\n```\n\n`stem_params` and `stem_flops` must be exact integers -- build them with integer arithmetic so nothing lands in a float. The driver rounds the two shares to 6 decimals.\n\n**The FLOP count is the whole question.** The stem touches more raw data than anything else in the network, which makes it feel expensive, but it compresses that data once per token with one cheap projection and every later layer pays far more. Getting there means multiplying by `n`.\n\nTokens use floor division, so a side that is not a multiple of the patch drops the leftover strip.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "side = 224, patch = 14, channels = 3, d = 1024, layers = 24  (ViT-L/14)", output: "[603136, 308281344, 0.001993, 0.00191]", explanation: "A 14x14 RGB patch flattens to 588 values, projected to width 1024 for 603136 parameters, and 0.31 GFLOP across 256 tokens. The body is 302M parameters and 161 GFLOP, so the stem is two tenths of one percent either way." },
        { input: "side = 224, patch = 16, channels = 3, d = 768, layers = 12  (ViT-B/16)", output: "[590592, 231211008, 0.006905, 0.006617]", explanation: "A narrower, shallower body raises the stem's share to about 0.7 percent -- larger, still not where the time goes." },
      ],
      constraints: ["1 <= side <= 8192, 1 <= patch <= side, 1 <= channels <= 16", "1 <= d <= 8192, 1 <= layers <= 128", "Tokens use floor division and there is no class token.", "stem_params and stem_flops are exact integers, not floats.", "Round both shares to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["side", "patch", "channels", "d", "layers"],
    },
  },
  {
    questionSlug: "arithmetic-intensity-roofline",
    problem: {
      id: "iq-arithmetic-intensity-roofline",
      title: "Place a kernel on the roofline",
      summary: "Implement:",
      entry: "roofline",
      difficulty: "medium",
      categories: ["CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "json.dumps([round(float(_r[0]), 6), round(float(_r[1]), 6), _r[2]])",
      cases: [
        { id: "iq-arithmetic-intensity-roofline-0", label: "Case 1", visible: true, args: [137438953472, 100663296, 312000000000000.0, 1550000000000.0] },
        { id: "iq-arithmetic-intensity-roofline-1", label: "Case 2", visible: true, args: [1000000, 12000000, 312000000000000.0, 1550000000000.0] },
        { id: "iq-arithmetic-intensity-roofline-2", label: "Hidden 1", visible: false, args: [200, 20, 1000, 100] },
        { id: "iq-arithmetic-intensity-roofline-3", label: "Hidden 2", visible: false, args: [2000000000, 1000000000, 100000000000000.0, 2000000000000.0] },
        { id: "iq-arithmetic-intensity-roofline-4", label: "Hidden 3", visible: false, args: [8000, 10, 1000, 5] },
      ],
      reference: `
def roofline(flops, bytes_moved, peak_flops, peak_bw):
    intensity = float(flops) / float(bytes_moved)
    ridge = float(peak_flops) / float(peak_bw)
    attainable = min(float(peak_flops), float(peak_bw) * intensity)
    utilization = attainable / float(peak_flops)
    bound = "memory" if intensity < ridge else "compute"
    return [intensity, utilization, bound]
`,
      template: `
def roofline(flops, bytes_moved, peak_flops, peak_bw):
    """
    :type flops: float
    :type bytes_moved: float
    :type peak_flops: float   -- peak arithmetic throughput, FLOP/s
    :type peak_bw: float      -- peak memory bandwidth, bytes/s
    :rtype: list  -- [intensity, utilization, bound]
    """
`,
    },
    statement: {
      orderIndex: 30,
      description: "Implement:\n\n```python\nclass Solution(object):\n    def roofline(self, flops, bytes_moved, peak_flops, peak_bw):\n        ...\n```\n\n`flops` is the arithmetic the kernel performs, `bytes_moved` is the traffic it moves to and from HBM, `peak_flops` is the device's peak arithmetic throughput in FLOP/s, and `peak_bw` is its peak memory bandwidth in bytes/s.\n\nReturn `[intensity, utilization, bound]`:\n\n- `intensity = flops / bytes_moved`, in FLOP per byte.\n- `ridge = peak_flops / peak_bw` -- the intensity at which the two roofs meet.\n- `attainable = min(peak_flops, peak_bw * intensity)` -- the sloped bandwidth roof below the ridge, the flat compute roof above it.\n- `utilization = attainable / peak_flops`, a value in `(0, 1]`.\n- `bound` is the string `\"memory\"` when `intensity < ridge`, and `\"compute\"` otherwise. **Exactly at the ridge point, return `\"compute\"`.**\n\nRound `intensity` and `utilization` to 6 decimal places. `bound` is a plain string.\n\n**The clamp is the question.** Drop the `min` and a kernel sitting far above the ridge reports a utilization above 1.0, because nothing stops `peak_bw * intensity` from exceeding the number of arithmetic units the chip has. Classification is the other half: it tells you whether shaving bytes or shaving instructions is the only lever worth pulling.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "flops = 137438953472, bytes_moved = 100663296, peak_flops = 312e12, peak_bw = 1.55e12", output: "[1365.333333, 1.0, \"compute\"]", explanation: "A 4096-cubed matmul in bf16 does 2N^3 FLOPs and moves 3N^2 * 2 bytes, so intensity is N/3 = 1365.33 FLOP/byte against a ridge of 312/1.55 = 201.29. Far above it, so the compute roof binds and utilization clamps to 1.0." },
        { input: "flops = 1000000, bytes_moved = 12000000, peak_flops = 312e12, peak_bw = 1.55e12", output: "[0.083333, 0.000414, \"memory\"]", explanation: "An fp32 element-wise add reads two words and writes one for every single FLOP: 12 bytes each. At 1/12 FLOP/byte the kernel reaches four ten-thousandths of peak arithmetic, so making the arithmetic faster buys nothing and only moving fewer bytes helps." },
      ],
      constraints: ["flops >= 1 and bytes_moved >= 1", "peak_flops > 0 and peak_bw > 0", "Inputs may arrive in scientific notation (e.g. 312e12).", "Exactly at the ridge point the answer is \"compute\".", "utilization is clamped at 1.0.", "Round intensity and utilization to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["flops", "bytes_moved", "peak_flops", "peak_bw"],
    },
  },
  {
    questionSlug: "coalescing-transaction-count",
    problem: {
      id: "iq-coalescing-transaction-count",
      title: "Count the sectors a warp actually fetches",
      summary: "Implement:",
      entry: "memory_traffic",
      difficulty: "medium",
      categories: ["CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "json.dumps([_r[0], _r[1], round(float(_r[2]), 6)])",
      cases: [
        { id: "iq-coalescing-transaction-count-0", label: "Case 1", visible: true, args: [[0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124], 4, 32] },
        { id: "iq-coalescing-transaction-count-1", label: "Case 2", visible: true, args: [[0, 4096, 8192, 12288, 16384, 20480, 24576, 28672, 32768, 36864, 40960, 45056, 49152, 53248, 57344, 61440, 65536, 69632, 73728, 77824, 81920, 86016, 90112, 94208, 98304, 102400, 106496, 110592, 114688, 118784, 122880, 126976], 4, 32] },
        { id: "iq-coalescing-transaction-count-2", label: "Hidden 1", visible: false, args: [[2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62, 66, 70, 74, 78, 82, 86, 90, 94, 98, 102, 106, 110, 114, 118, 122, 126], 4, 32] },
        { id: "iq-coalescing-transaction-count-3", label: "Hidden 2", visible: false, args: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4, 32] },
        { id: "iq-coalescing-transaction-count-4", label: "Hidden 3", visible: false, args: [[0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248], 4, 32] },
        { id: "iq-coalescing-transaction-count-5", label: "Hidden 4", visible: false, args: [[], 4, 32] },
      ],
      reference: `
def memory_traffic(addresses, elem_bytes, sector_bytes):
    sectors = set()
    touched = set()
    for a in addresses:
        for b in range(a, a + elem_bytes):
            touched.add(b)
        first = a // sector_bytes
        last = (a + elem_bytes - 1) // sector_bytes
        for s in range(first, last + 1):
            sectors.add(s)
    n = len(sectors)
    fetched = n * sector_bytes
    eff = 0.0 if fetched == 0 else float(len(touched)) / float(fetched)
    return [n, fetched, eff]
`,
      template: `
def memory_traffic(addresses, elem_bytes, sector_bytes):
    """
    :type addresses: List[int]  -- one starting byte address per lane
    :type elem_bytes: int
    :type sector_bytes: int
    :rtype: list  -- [num_sectors, bytes_fetched, efficiency]
    """
`,
    },
    statement: {
      orderIndex: 31,
      description: "Implement:\n\n```python\nclass Solution(object):\n    def memory_traffic(self, addresses, elem_bytes, sector_bytes):\n        ...\n```\n\n`addresses[i]` is the **starting byte address** read by lane `i`, and every lane reads `elem_bytes` contiguous bytes from there. Memory is served in aligned blocks of `sector_bytes` anchored at address 0: sector `k` covers bytes `[k * sector_bytes, (k + 1) * sector_bytes)`. A sector is fetched in full if any lane touches even one byte of it.\n\nReturn `[num_sectors, bytes_fetched, efficiency]`:\n\n- `num_sectors` -- the number of distinct sectors the whole warp touches. Lane `i` touches every sector from `addresses[i] // sector_bytes` through `(addresses[i] + elem_bytes - 1) // sector_bytes`, inclusive.\n- `bytes_fetched = num_sectors * sector_bytes`.\n- `efficiency = requested / bytes_fetched`, where `requested` is the number of **distinct** bytes some lane asked for. If two lanes read the same byte it counts once. Round to 6 decimal places.\n\n`num_sectors` and `bytes_fetched` are exact integers.\n\nEdge cases: `addresses` may be empty, in which case return `[0, 0, 0.0]`. Addresses may repeat, may arrive unsorted, and are not guaranteed to be aligned to `elem_bytes` or to `sector_bytes`.\n\n**One sector per lane is the wrong model.** A lane can straddle a boundary and pay for two sectors, and thirty-two lanes at the same address share one. The whole point of the exercise is that `bytes_fetched` is set by the address pattern, not by how many bytes the code asked for -- which is why a strided access collapses effective bandwidth even though the requested volume never changes.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "addresses = [0, 4, 8, ..., 124] (32 lanes), elem_bytes = 4, sector_bytes = 32", output: "[4, 128, 1.0]", explanation: "The warp covers bytes 0..127 with no gaps, which is exactly four 32-byte sectors. 128 bytes fetched, 128 requested, nothing wasted." },
        { input: "addresses = [0, 4096, 8192, ..., 126976], elem_bytes = 4, sector_bytes = 32", output: "[32, 1024, 0.125]", explanation: "Each lane's four bytes land in a sector of its own, so 32 sectors move to deliver 128 useful bytes: 128/1024 = 0.125, an eightfold waste." },
      ],
      constraints: ["0 <= len(addresses) <= 1024", "addresses[i] >= 0; entries may repeat and may be unsorted", "1 <= elem_bytes <= 16", "sector_bytes is a power of two, 8 <= sector_bytes <= 128", "A lane's bytes may straddle a sector boundary and then cost two sectors.", "requested counts distinct bytes only.", "Return [0, 0, 0.0] for an empty address list.", "Round efficiency to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["addresses", "elem_bytes", "sector_bytes"],
    },
  },
  {
    questionSlug: "kv-cache-memory",
    problem: {
      id: "iq-kv-cache-memory",
      title: "Size the KV cache and count concurrent requests",
      summary: "Implement:",
      entry: "kv_capacity",
      difficulty: "hard",
      categories: ["CUDA", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "json.dumps([_r[0], _r[1], _r[2]])",
      cases: [
        { id: "iq-kv-cache-memory-0", label: "Case 1", visible: true, args: [32, 32, 128, 2, 8192, 64424509440] },
        { id: "iq-kv-cache-memory-1", label: "Case 2", visible: true, args: [32, 8, 128, 2, 8192, 64424509440] },
        { id: "iq-kv-cache-memory-2", label: "Hidden 1", visible: false, args: [32, 8, 128, 1, 8192, 64424509440] },
        { id: "iq-kv-cache-memory-3", label: "Hidden 2", visible: false, args: [2, 1, 64, 2, 10, 10000] },
        { id: "iq-kv-cache-memory-4", label: "Hidden 3", visible: false, args: [2, 1, 64, 2, 10, 1000] },
        { id: "iq-kv-cache-memory-5", label: "Hidden 4", visible: false, args: [80, 1, 128, 2, 131072, 64424509440] },
      ],
      reference: `
def kv_capacity(layers, kv_heads, head_dim, dtype_bytes, seq_len, free_bytes):
    per_token = 2 * layers * kv_heads * head_dim * dtype_bytes
    per_request = per_token * seq_len
    fits = free_bytes // per_request
    return [per_token, per_request, fits]
`,
      template: `
def kv_capacity(layers, kv_heads, head_dim, dtype_bytes, seq_len, free_bytes):
    """
    :type layers: int
    :type kv_heads: int      -- key/value heads, not query heads
    :type head_dim: int
    :type dtype_bytes: int
    :type seq_len: int
    :type free_bytes: int
    :rtype: list  -- [bytes_per_token, bytes_per_request, max_concurrent]
    """
`,
    },
    statement: {
      orderIndex: 32,
      description: "Implement:\n\n```python\nclass Solution(object):\n    def kv_capacity(self, layers, kv_heads, head_dim, dtype_bytes, seq_len, free_bytes):\n        ...\n```\n\nEvery decoder layer caches one key vector and one value vector per token per KV head, so:\n\n```\nbytes_per_token   = 2 * layers * kv_heads * head_dim * dtype_bytes\nbytes_per_request = bytes_per_token * seq_len\nmax_concurrent    = free_bytes // bytes_per_request\n```\n\nReturn `[bytes_per_token, bytes_per_request, max_concurrent]`. All three are exact integers -- no rounding, no floats anywhere in the answer.\n\n`free_bytes` is what is left after weights, activations and workspace; you do not subtract anything yourself. `kv_heads` is the number of **key/value** heads, which is smaller than the query-head count under grouped-query attention and equal to 1 under multi-query attention -- that ratio is the entire memory story, so the signature does not even take the query-head count.\n\n**Floor, not round.** A request reserving its full context either fits or it does not, so `max_concurrent` is a floor and may legitimately be 0. Rounding to nearest hands you a slot that would run the device out of memory mid-decode.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "layers = 32, kv_heads = 32, head_dim = 128, dtype_bytes = 2, seq_len = 8192, free_bytes = 64424509440", output: "[524288, 4294967296, 15]", explanation: "2 * 32 * 32 * 128 * 2 = 524,288 bytes = 512 KiB per token. At 8192 tokens that is exactly 4 GiB per request, and 60 GiB of free memory holds 15 of them -- so the cache, not the 14 GB of weights, is what binds." },
        { input: "layers = 32, kv_heads = 8, head_dim = 128, dtype_bytes = 2, seq_len = 8192, free_bytes = 64424509440", output: "[131072, 1073741824, 60]", explanation: "Dropping from 32 KV heads to 8 divides the cache by four and multiplies concurrency by four, from an architectural decision made at training time." },
      ],
      constraints: ["1 <= layers <= 200", "1 <= kv_heads <= 128", "1 <= head_dim <= 512", "dtype_bytes is 1, 2 or 4", "1 <= seq_len <= 10^6", "0 <= free_bytes <= 10^13", "All three returned values are integers; use floor division.", "max_concurrent may be 0.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["layers", "kv_heads", "head_dim", "dtype_bytes", "seq_len", "free_bytes"],
    },
  },
  {
    questionSlug: "occupancy-from-resources",
    problem: {
      id: "iq-occupancy-from-resources",
      title: "Compute occupancy from the binding resource",
      summary: "Implement:",
      entry: "occupancy",
      difficulty: "hard",
      categories: ["CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "json.dumps([_r[0], _r[1], round(float(_r[2]), 6)])",
      cases: [
        { id: "iq-occupancy-from-resources-0", label: "Case 1", visible: true, args: [256, 64, 32768, 2048, 32, 65536, 102400] },
        { id: "iq-occupancy-from-resources-1", label: "Case 2", visible: true, args: [256, 64, 16384, 2048, 32, 65536, 102400] },
        { id: "iq-occupancy-from-resources-2", label: "Hidden 1", visible: false, args: [128, 32, 0, 2048, 16, 65536, 65536] },
        { id: "iq-occupancy-from-resources-3", label: "Hidden 2", visible: false, args: [64, 16, 1024, 2048, 16, 65536, 65536] },
        { id: "iq-occupancy-from-resources-4", label: "Hidden 3", visible: false, args: [1024, 128, 0, 2048, 32, 65536, 65536] },
        { id: "iq-occupancy-from-resources-5", label: "Hidden 4", visible: false, args: [512, 24, 4096, 2048, 32, 65536, 65536] },
      ],
      reference: `
def occupancy(threads_per_block, regs_per_thread, smem_per_block,
              max_threads_per_sm, max_blocks_per_sm, regs_per_sm, smem_per_sm):
    limits = [max_blocks_per_sm, max_threads_per_sm // threads_per_block]
    regs_per_block = threads_per_block * regs_per_thread
    if regs_per_block > 0:
        limits.append(regs_per_sm // regs_per_block)
    if smem_per_block > 0:
        limits.append(smem_per_sm // smem_per_block)
    blocks = min(limits)
    if blocks < 0:
        blocks = 0
    warps_per_block = threads_per_block // 32
    active_warps = blocks * warps_per_block
    max_warps = max_threads_per_sm // 32
    return [blocks, active_warps, float(active_warps) / float(max_warps)]
`,
      template: `
def occupancy(threads_per_block, regs_per_thread, smem_per_block,
              max_threads_per_sm, max_blocks_per_sm, regs_per_sm, smem_per_sm):
    """
    :type threads_per_block: int   -- a multiple of 32
    :type regs_per_thread: int
    :type smem_per_block: int      -- bytes; 0 means none is allocated
    :type max_threads_per_sm: int
    :type max_blocks_per_sm: int
    :type regs_per_sm: int
    :type smem_per_sm: int         -- bytes
    :rtype: list  -- [blocks, active_warps, occupancy]
    """
`,
    },
    statement: {
      orderIndex: 33,
      description: "Implement:\n\n```python\nclass Solution(object):\n    def occupancy(self, threads_per_block, regs_per_thread, smem_per_block,\n                  max_threads_per_sm, max_blocks_per_sm, regs_per_sm, smem_per_sm):\n        ...\n```\n\nWork out how many blocks are simultaneously resident on one SM. Each resource imposes its own ceiling:\n\n```\nby registers  : regs_per_sm // (threads_per_block * regs_per_thread)\nby shared mem : smem_per_sm // smem_per_block\nby threads    : max_threads_per_sm // threads_per_block\nby hard cap   : max_blocks_per_sm\n```\n\n`blocks` is the minimum over every applicable ceiling, using floor division throughout. If `smem_per_block` is 0 the kernel allocates no shared memory and that ceiling does not apply -- skip it rather than dividing by zero.\n\nReturn `[blocks, active_warps, occupancy]` where\n\n```\nactive_warps = blocks * (threads_per_block // 32)\noccupancy    = active_warps / (max_threads_per_sm // 32)\n```\n\n`blocks` and `active_warps` are integers; `occupancy` is a float rounded to 6 decimal places. `threads_per_block` is always a multiple of 32.\n\n**A block that does not fit means zero.** If one block alone needs more registers or more shared memory than the SM has, that ceiling is 0, so `blocks` is 0 and occupancy is 0.0 -- the launch would fail. Do not clamp it up to 1.\n\nThe point of computing all four is that you learn *which* resource binds, which is the only thing that tells you what to change. Halving the shared memory of a shared-memory-bound kernel does not double occupancy; it just hands the limit to whichever resource was next in line.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "threads_per_block = 256, regs_per_thread = 64, smem_per_block = 32768, max_threads_per_sm = 2048, max_blocks_per_sm = 32, regs_per_sm = 65536, smem_per_sm = 102400", output: "[3, 24, 0.375]", explanation: "Registers allow 4 blocks, threads allow 8, the cap allows 32, but 100 KiB of shared memory over 32 KiB per block allows only 3. Three blocks of 8 warps is 24 of the 64 warp slots: 37.5%." },
        { input: "same SM, but smem_per_block = 16384", output: "[4, 32, 0.5]", explanation: "Shared memory now allows 6 blocks, so registers become the binding resource at 4. Halving shared memory raised occupancy from 37.5% to 50%, not to 75% -- the limit moved rather than disappearing." },
      ],
      constraints: ["threads_per_block is a positive multiple of 32, up to 1024", "regs_per_thread >= 1", "smem_per_block >= 0 (0 means no shared memory ceiling applies)", "max_blocks_per_sm >= 1", "max_threads_per_sm is a multiple of 32", "Use floor division for every ceiling; blocks may be 0.", "Round occupancy to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["threads_per_block", "regs_per_thread", "smem_per_block", "max_threads_per_sm", "max_blocks_per_sm", "regs_per_sm", "smem_per_sm"],
    },
  },
  {
    questionSlug: "pipeline-bubble-fraction",
    problem: {
      id: "iq-pipeline-bubble-fraction",
      title: "Compute the pipeline bubble and the micro-batch count it demands",
      summary: "Implement:",
      entry: "pipeline",
      difficulty: "hard",
      categories: ["CUDA", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "json.dumps([round(float(_r[0]), 6), _r[1]])",
      cases: [
        { id: "iq-pipeline-bubble-fraction-0", label: "Case 1", visible: true, args: [8, 8, 1, 0.15] },
        { id: "iq-pipeline-bubble-fraction-1", label: "Case 2", visible: true, args: [8, 64, 1, 0.06] },
        { id: "iq-pipeline-bubble-fraction-2", label: "Hidden 1", visible: false, args: [8, 8, 4, 0.15] },
        { id: "iq-pipeline-bubble-fraction-3", label: "Hidden 2", visible: false, args: [1, 1, 1, 0.15] },
        { id: "iq-pipeline-bubble-fraction-4", label: "Hidden 3", visible: false, args: [2, 100, 1, 0.5] },
        { id: "iq-pipeline-bubble-fraction-5", label: "Hidden 4", visible: false, args: [16, 4, 2, 0.25] },
      ],
      reference: `
import math

def _bubble(stages, microbatches, chunks):
    return float(stages - 1) / float(chunks * microbatches + stages - 1)

def pipeline(stages, microbatches, chunks, target):
    bubble = _bubble(stages, microbatches, chunks)
    need = float(stages - 1) * (1.0 - target) / (target * chunks)
    m = int(math.ceil(need))
    if m < 1:
        m = 1
    while _bubble(stages, m, chunks) > target:
        m += 1
    while m > 1 and _bubble(stages, m - 1, chunks) <= target:
        m -= 1
    return [bubble, m]
`,
      template: `
import math

def pipeline(stages, microbatches, chunks, target):
    """
    :type stages: int         -- P, devices in the pipeline
    :type microbatches: int   -- M
    :type chunks: int         -- stages per device in an interleaved schedule
    :type target: float
    :rtype: list  -- [bubble, min_microbatches]
    """
`,
    },
    statement: {
      orderIndex: 34,
      description: "Implement:\n\n```python\nclass Solution(object):\n    def pipeline(self, stages, microbatches, chunks, target):\n        ...\n```\n\nA pipeline of `P = stages` devices processes `M = microbatches` micro-batches. Take one stage's work on one micro-batch as the unit of time. The last stage cannot begin until micro-batch 1 has crossed the `P - 1` stages ahead of it, and the earlier stages sit idle while the tail drains, so the pass takes `M + P - 1` units of which only `M` are useful:\n\n```\nbubble = (P - 1) / (M + P - 1)\n```\n\nAn interleaved schedule assigns each device `chunks` non-contiguous stages, splitting a stage's work per micro-batch into `chunks` pieces of `1/chunks` the duration. Fill and drain shrink by that factor while the useful work does not, giving the general form you must implement:\n\n```\nbubble = (P - 1) / (chunks * M + P - 1)\n```\n\nReturn `[bubble, min_microbatches]`:\n\n- `bubble` for the given `microbatches`, rounded to 6 decimal places.\n- `min_microbatches` is the smallest integer `M2 >= 1` for which `(P - 1) / (chunks * M2 + P - 1) <= target`, with `stages` and `chunks` held fixed. It is an integer and is never rounded. Equality counts as meeting the target.\n\nWith `P = 1` there is no pipeline at all: `bubble` is 0.0 and `min_microbatches` is 1.\n\n**Watch the ceiling.** Solving the inequality gives `M2 >= (P - 1) * (1 - target) / (target * chunks)`, and taking `math.ceil` of that in floating point can land one step either side of the true answer. Re-test the candidate against the inequality (and the candidate below it) before returning.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "stages = 8, microbatches = 8, chunks = 1, target = 0.15", output: "[0.466667, 40]", explanation: "7 idle units against 15 total is 7/15 = 46.7% of the pass thrown away. To get to 15% you need 7/(M+7) <= 0.15, so M >= 39.67 and the answer is 40 -- micro-batches must far outnumber stages." },
        { input: "stages = 8, microbatches = 64, chunks = 1, target = 0.06", output: "[0.098592, 110]", explanation: "Eight times the micro-batches drops the bubble from 46.7% to 9.9%, and reaching 6% would take 110 of them." },
      ],
      constraints: ["1 <= stages <= 1024", "1 <= microbatches <= 10^6", "1 <= chunks <= 64", "0 < target < 1", "min_microbatches is an integer >= 1; equality with target counts as met.", "Round bubble to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["stages", "microbatches", "chunks", "target"],
    },
  },
  {
    questionSlug: "implement-stratified-split",
    problem: {
      id: "iq-implement-stratified-split",
      title: "Split without leaking a user across the boundary",
      summary: "You are given `rows` as a list of `[user_id, label]` pairs and a `test_frac`. Return `[train_ids, test_ids]` -- the user ids on each side, each list sorted ascending.",
      entry: "grouped_split",
      difficulty: "medium",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[sorted(side) for side in _r]",
      cases: [
        { id: "iq-implement-stratified-split-0", label: "Case 1", visible: true, args: [[[1, 1], [1, 0], [2, 1], [3, 0]], 0.5] },
        { id: "iq-implement-stratified-split-1", label: "Case 2", visible: true, args: [[[1, 1], [2, 0], [3, 1], [4, 0]], 0.25] },
        { id: "iq-implement-stratified-split-2", label: "Hidden 1", visible: false, args: [[[7, 1], [7, 0], [7, 1]], 0.5] },
        { id: "iq-implement-stratified-split-3", label: "Hidden 2", visible: false, args: [[[3, 1], [1, 0], [2, 1], [4, 0]], 0.5] },
        { id: "iq-implement-stratified-split-4", label: "Hidden 3", visible: false, args: [[[1, 1], [2, 0], [3, 1], [3, 0], [3, 1], [3, 0]], 0.5] },
      ],
      reference: `
def grouped_split(rows, test_frac):
    sizes = {}
    for uid, _label in rows:
        sizes[uid] = sizes.get(uid, 0) + 1
    order = sorted(sizes.keys(), key=lambda u: (-sizes[u], u))
    target = test_frac * len(rows)
    train, test, filled = [], [], 0
    for uid in order:
        if filled < target:
            test.append(uid)
            filled += sizes[uid]
        else:
            train.append(uid)
    return [sorted(train), sorted(test)]
`,
      template: `
def grouped_split(rows, test_frac):
    """
    :type rows: List[List[int]]  -- [user_id, label]
    :type test_frac: float
    :rtype: List[List[int]]      -- [train_ids, test_ids]
    """
`,
    },
    statement: {
      orderIndex: 35,
      description: "You are given `rows` as a list of `[user_id, label]` pairs and a `test_frac`. Return `[train_ids, test_ids]` -- the user ids on each side, each list sorted ascending.\n\n**A user id must never appear on both sides.** That is the hard constraint. Preserving the class ratio is the soft one: with whole users as the unit you often cannot hit it exactly, and that is fine.\n\nWhy that ordering: a leaked user means the model has seen that user's rows in training and is scored on them again in test, so the metric is measuring memorisation. An imperfect class ratio only adds variance to a metric that still means what it says. **A biased-but-valid estimate beats a precise invalid one.**\n\n**The algorithm, exactly** (it must be deterministic -- no `random`):\n\n1. Group rows by `user_id`. A group's size is its row count; its positive count is how many of its labels are 1.\n2. Sort groups by size **descending**, breaking ties by `user_id` ascending. Largest first matters: placing a big group last is what overshoots the target.\n3. Target test size is `test_frac * len(rows)`.\n4. For each group in that order, put it in **test** if the test side is still below its target size, otherwise in **train**.\n\nStandard library only -- no numpy, no sklearn.",
      examples: [
        { input: "rows = [[1,1],[1,0],[2,1],[3,0]], test_frac = 0.5", output: "[[2, 3], [1]]", explanation: "User 1 has 2 rows, users 2 and 3 have 1 each. Target test size is 2. User 1 is largest so it goes to test, filling it. Users 2 and 3 then go to train. Note user 1 is never split." },
      ],
      constraints: ["1 <= len(rows) <= 10^4", "label is 0 or 1", "0 < test_frac < 1", "A user_id must appear on exactly one side.", "Deterministic -- no randomness.", "Both returned lists are sorted ascending.", "Standard library only -- no numpy, no sklearn."],
      hints: [],
      params: ["rows", "test_frac"],
    },
  },
  {
    questionSlug: "implement-causal-mask",
    problem: {
      id: "iq-implement-causal-mask",
      title: "Softmax over a row that is entirely masked",
      summary: "Given `scores` (a list of floats) and `mask` (a list of 0/1 of the same length, 1 meaning *attend to this position*), return the softmax over the unmasked positions. Masked positions get exactly `0.0`. Round to 6 decimals.",
      entry: "masked_softmax",
      difficulty: "easy",
      categories: ["DL", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-implement-causal-mask-0", label: "Case 1", visible: true, args: [[1.0, 2.0, 3.0], [1, 1, 0]] },
        { id: "iq-implement-causal-mask-1", label: "Case 2", visible: true, args: [[1.0, 2.0], [0, 0]] },
        { id: "iq-implement-causal-mask-2", label: "Hidden 1", visible: false, args: [[800.0, 800.0, 799.0], [1, 1, 1]] },
        { id: "iq-implement-causal-mask-3", label: "Hidden 2", visible: false, args: [[1.0, 900.0, 2.0], [1, 0, 1]] },
        { id: "iq-implement-causal-mask-4", label: "Hidden 3", visible: false, args: [[5.0], [1]] },
      ],
      reference: `
import math

def masked_softmax(scores, mask):
    live = [i for i, m in enumerate(mask) if m]
    if not live:
        return [0.0] * len(scores)
    top = max(scores[i] for i in live)
    exps = {i: math.exp(scores[i] - top) for i in live}
    total = sum(exps.values())
    return [exps[i] / total if i in exps else 0.0
            for i in range(len(scores))]
`,
      template: `
import math

def masked_softmax(scores, mask):
    """
    :type scores: List[float]
    :type mask: List[int]   -- 1 = attend, 0 = masked out
    :rtype: List[float]
    """
`,
    },
    statement: {
      orderIndex: 36,
      description: "Given `scores` (a list of floats) and `mask` (a list of 0/1 of the same length, 1 meaning *attend to this position*), return the softmax over the unmasked positions. Masked positions get exactly `0.0`. Round to 6 decimals.\n\n**The row where every mask entry is 0 is the question.** Setting masked scores to `-inf` and running softmax gives `exp(-inf) = 0` for every term, so you compute `0 / 0` -- NaN. And NaN is not local: one such row propagates through the next matmul and turns the whole batch into NaN, which is why this shows up as 'my loss became NaN at step 400' rather than as an obviously masked-out row.\n\n**Return a row of all zeros in that case.** It is the only value that does not corrupt anything downstream.\n\nSubtract the row maximum over the *unmasked* positions before exponentiating, or a score of 800 overflows.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "scores = [1.0, 2.0, 3.0], mask = [1, 1, 0]", output: "[0.268941, 0.731059, 0.0]", explanation: "Only the first two compete. softmax([1,2]) = [0.268941, 0.731059], and the masked third is exactly 0.0." },
        { input: "scores = [1.0, 2.0], mask = [0, 0]", output: "[0.0, 0.0]", explanation: "Nothing to attend to. Zeros, not NaN." },
      ],
      constraints: ["1 <= len(scores) == len(mask) <= 10^4", "mask[i] is 0 or 1", "An all-zero mask returns all zeros, never NaN.", "|scores[i]| may reach 1000 -- do not overflow.", "Round to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["scores", "mask"],
    },
  },
  {
    questionSlug: "interpolate-pos-embed",
    problem: {
      id: "iq-interpolate-pos-embed",
      title: "Resize a ViT's position embeddings",
      summary: "Given `pe` of shape `(1 + old*old, D)` -- **row 0 is the CLS token**, the rest is an `old x old` grid in row-major order -- resize it to `(1 + new*new, D)`. Round to 6 decimals.",
      entry: "resize_pos_embed",
      difficulty: "hard",
      categories: ["VLM", "DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[[round(float(v), 6) for v in row] for row in _r]",
      cases: [
        { id: "iq-interpolate-pos-embed-0", label: "Case 1", visible: true, args: [[[9.0], [0.0], [1.0], [2.0], [3.0]], 2, 2] },
        { id: "iq-interpolate-pos-embed-1", label: "Case 2", visible: true, args: [[[9.0], [0.0], [1.0], [2.0], [3.0]], 2, 1] },
        { id: "iq-interpolate-pos-embed-2", label: "Hidden 1", visible: false, args: [[[9.0], [0.0], [1.0], [2.0], [3.0]], 2, 4] },
        { id: "iq-interpolate-pos-embed-3", label: "Hidden 2", visible: false, args: [[[100.0], [1.0], [2.0], [3.0], [4.0]], 2, 3] },
        { id: "iq-interpolate-pos-embed-4", label: "Hidden 3", visible: false, args: [[[9.0, 8.0], [0.0, 1.0], [1.0, 2.0], [2.0, 3.0], [3.0, 4.0]], 2, 3] },
      ],
      reference: `
def resize_pos_embed(pe, old, new):
    cls = pe[0]
    grid = pe[1:]
    d = len(cls)
    scale = float(old) / float(new)
    out = [list(cls)]
    for r in range(new):
        sr = (r + 0.5) * scale - 0.5
        if sr < 0.0:
            sr = 0.0
        if sr > old - 1:
            sr = float(old - 1)
        r0 = int(sr)
        r1 = min(r0 + 1, old - 1)
        wr = sr - r0
        for c in range(new):
            sc = (c + 0.5) * scale - 0.5
            if sc < 0.0:
                sc = 0.0
            if sc > old - 1:
                sc = float(old - 1)
            c0 = int(sc)
            c1 = min(c0 + 1, old - 1)
            wc = sc - c0
            row = []
            for k in range(d):
                a = grid[r0 * old + c0][k]
                b = grid[r0 * old + c1][k]
                c_ = grid[r1 * old + c0][k]
                e = grid[r1 * old + c1][k]
                top = a + (b - a) * wc
                bot = c_ + (e - c_) * wc
                row.append(top + (bot - top) * wr)
            out.append(row)
    return out
`,
      template: `
def resize_pos_embed(pe, old, new):
    """
    :type pe: List[List[float]]  -- (1 + old*old, D), row 0 is CLS
    :type old: int
    :type new: int
    :rtype: List[List[float]]    -- (1 + new*new, D)
    """
`,
    },
    statement: {
      orderIndex: 37,
      description: "Given `pe` of shape `(1 + old*old, D)` -- **row 0 is the CLS token**, the rest is an `old x old` grid in row-major order -- resize it to `(1 + new*new, D)`. Round to 6 decimals.\n\n**The CLS row is copied, never interpolated.** It encodes no position, so blending it into the grid contaminates every patch with a vector that means something else. Nothing crashes if you get this wrong; the model just gets quietly worse.\n\n**Bilinear sampling, half-pixel aligned.** For output cell `(r, c)`, the source coordinate is\n\n```\nsrc = (dst + 0.5) * (old / new) - 0.5\n```\n\nclamped to `[0, old-1]`, then bilinearly interpolated between the two surrounding integer rows and columns. The `+0.5 ... -0.5` maps cell *centres* rather than corners; using `dst * (old/new)` instead biases the whole grid by half a cell.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        { input: "pe = [[9.0], [0.0], [1.0], [2.0], [3.0]], old = 2, new = 2", output: "[[9.0], [0.0], [1.0], [2.0], [3.0]]", explanation: "Same size in and out, so every value is unchanged and CLS is carried through." },
      ],
      constraints: ["1 <= old, new <= 32", "1 <= D <= 64", "len(pe) == 1 + old*old", "Row 0 (CLS) is copied verbatim.", "Clamp source coordinates to [0, old-1].", "Round to 6 decimal places.", "Standard library only -- no numpy, no torch."],
      hints: [],
      params: ["pe", "old", "new"],
    },
  },
  {
    questionSlug: "implement-warp-reduction",
    problem: {
      id: "iq-implement-warp-reduction",
      title: "Simulate a warp shuffle reduction",
      summary: "CUDA cannot run in this sandbox, so simulate it. Given `vals` (one float per lane, `width` lanes) implement the shuffle-down reduction and return **all** lane values afterwards, rounded to 6 decimals.",
      entry: "warp_reduce",
      difficulty: "hard",
      categories: ["CUDA"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-implement-warp-reduction-0", label: "Case 1", visible: true, args: [[1.0, 2.0, 3.0, 4.0]] },
        { id: "iq-implement-warp-reduction-1", label: "Case 2", visible: true, args: [[5.0]] },
        { id: "iq-implement-warp-reduction-2", label: "Hidden 1", visible: false, args: [[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]] },
        { id: "iq-implement-warp-reduction-3", label: "Hidden 2", visible: false, args: [[1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0]] },
        { id: "iq-implement-warp-reduction-4", label: "Hidden 3", visible: false, args: [[-1.5, 2.5]] },
      ],
      reference: `
def warp_reduce(vals):
    width = len(vals)
    cur = list(vals)
    offset = width // 2
    while offset >= 1:
        # Snapshot: every lane reads the pre-step state.
        prev = list(cur)
        for lane in range(width):
            src = lane + offset
            if src < width:
                cur[lane] = prev[lane] + prev[src]
        offset //= 2
    return cur
`,
      template: `
def warp_reduce(vals):
    """
    :type vals: List[float]  -- one per lane
    :rtype: List[float]      -- every lane after the reduction
    """
`,
    },
    statement: {
      orderIndex: 38,
      description: "CUDA cannot run in this sandbox, so simulate it. Given `vals` (one float per lane, `width` lanes) implement the shuffle-down reduction and return **all** lane values afterwards, rounded to 6 decimals.\n\n`__shfl_down_sync(mask, val, offset)` returns the value held by lane `lane + offset`. **If `lane + offset >= width`, the lane keeps its own value** -- the read is undefined in hardware, and CUDA's contract is that you must not rely on it.\n\nThe reduction, run by every lane simultaneously:\n\n```\nfor offset in [width//2, width//4, ..., 1]:\n    val += shfl_down(val, offset)\n```\n\n**All lanes read simultaneously from the pre-step values.** Each step reads the state at the start of that step, not a partially-updated array -- simulating this with an in-place loop gives a different and wrong answer.\n\n**Only lane 0 is guaranteed the total.** Other lanes hold partial sums, which is why real kernels use `__shfl_down_sync` for the reduction and then read lane 0 only. Returning every lane is how this question checks you understand that.\n\nNo `__syncthreads()` is needed because a warp executes in lockstep; the `mask` names the lanes participating, which matters on Volta and later where threads can diverge independently.\n\nStandard library only.",
      examples: [
        { input: "vals = [1.0, 2.0, 3.0, 4.0]", output: "[10.0, 9.0, 7.0, 4.0]", explanation: "offset 2: [1+3, 2+4, 3, 4] = [4, 6, 3, 4] (lanes 2 and 3 read past the end and keep their own). offset 1: [4+6, 6+3, 3+4, 4] = [10, 9, 7, 4]. Lane 0 has the total." },
      ],
      constraints: ["width is a power of two, 1 <= width <= 32", "len(vals) == width", "A lane whose source is >= width keeps its own value.", "Each step reads the values from the start of that step.", "Round to 6 decimal places.", "Standard library only."],
      hints: [],
      params: ["vals"],
    },
  },
  {
    questionSlug: "weighted-distribution-moments",
    problem: {
      id: "iq-weighted-distribution-moments",
      title: "Normalise weights and take the first two moments",
      summary:
        "`weights[i]` is a non-negative unnormalised weight on the integer outcome `i`. Return the normalised probabilities, the mean, and the variance under that distribution.",
      entry: "dist_moments",
      difficulty: "easy",
      categories: ["ML"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise:
        "None if _r is None else [[round(float(x), 6) for x in _r[0]], round(float(_r[1]), 6), round(float(_r[2]), 6)]",
      cases: [
        // Trap-named, not positional. The gate requires a mutant to say which case catches it, and
        // "Hidden 2" cannot express that — see `verify-interview-specs.ts`.
        {
          id: "iq-weighted-distribution-moments-uniform",
          label: "Uniform",
          visible: true,
          args: [[1, 1, 1, 1]],
        },
        {
          id: "iq-weighted-distribution-moments-two-sided",
          label: "Unequal weights",
          visible: true,
          args: [[0, 3, 1]],
        },
        // The case the whole item exists for: an unweighted spread of {0,1,2,3} gives 1.25 here,
        // against a true variance of 0.1364.
        {
          id: "iq-weighted-distribution-moments-skewed",
          label: "Near point mass",
          visible: false,
          args: [[97, 1, 1, 1]],
        },
        {
          id: "iq-weighted-distribution-moments-all-zero",
          label: "No distribution",
          visible: false,
          args: [[0, 0, 0]],
        },
        {
          id: "iq-weighted-distribution-moments-point-mass",
          label: "Single outcome",
          visible: false,
          args: [[0, 5, 0]],
        },
        {
          id: "iq-weighted-distribution-moments-already-normalised",
          label: "Already sums to one",
          visible: false,
          args: [[0.2, 0.8]],
        },
      ],
      reference: `
def dist_moments(weights):
    total = sum(weights)
    if total <= 0:
        return None

    probs = [w / total for w in weights]
    mean = sum(i * p for i, p in enumerate(probs))
    second = sum(i * i * p for i, p in enumerate(probs))
    return [probs, mean, second - mean * mean]
`,
      template: `
def dist_moments(weights):
    """
    :type weights: List[float]  -- non-negative, weights[i] is the weight on outcome i
    :rtype: List | None  -- [probs, mean, variance], or None if the total weight is zero
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-weighted-distribution-moments`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would notice
     * the reference's output changing. Each value was also checked against the arithmetic in the
     * statement's examples by hand before it was recorded — the derivation says what the code does,
     * not that the code is right.
     */
    derivedKey: [
      "[[0.25, 0.25, 0.25, 0.25], 1.5, 1.25]",
      "[[0.0, 0.75, 0.25], 1.25, 0.1875]",
      "[[0.97, 0.01, 0.01, 0.01], 0.06, 0.1364]",
      "None",
      "[[0.0, 1.0, 0.0], 1.0, 0.0]",
      "[[0.2, 0.8], 0.8, 0.16]",
    ],
    statement: {
      orderIndex: 39,
      description:
        "`weights[i]` is a non-negative unnormalised weight on the integer outcome `i`. Return `[probs, mean, variance]`:\n\n- `probs` — the weights divided by their total, so they sum to 1.\n- `mean` — `E[X] = sum_i i * probs[i]`.\n- `variance` — `Var(X) = E[X^2] - E[X]^2`, where `E[X^2] = sum_i i^2 * probs[i]`.\n\n**The variance is taken under the distribution, not over the outcome values.** The spread of the labels `{0, 1, ..., n-1}` is a different quantity, and it agrees with the answer only when the distribution is uniform — so a uniform test case cannot tell them apart.\n\nIf the total weight is zero there is no distribution: return `None`. Not a uniform distribution, and not zeros — a sampler reaches this state when every logit has been masked out, and inventing a distribution there hides the bug.\n\nRound the probabilities, the mean and the variance to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        {
          input: "weights = [1, 1, 1, 1]",
          output: "[[0.25, 0.25, 0.25, 0.25], 1.5, 1.25]",
          explanation:
            "E[X] = (0+1+2+3)/4 = 1.5 and E[X^2] = (0+1+4+9)/4 = 3.5, so Var = 3.5 - 2.25 = 1.25. This is the one shape of input where the unweighted spread of the outcomes gives the same answer.",
        },
        {
          input: "weights = [0, 3, 1]",
          output: "[[0.0, 0.75, 0.25], 1.25, 0.1875]",
          explanation:
            "Outcome 0 has no weight at all. E[X] = 0.75*1 + 0.25*2 = 1.25, E[X^2] = 0.75*1 + 0.25*4 = 1.75, so Var = 1.75 - 1.5625 = 0.1875.",
        },
      ],
      constraints: [
        "1 <= len(weights) <= 4096",
        "Every weight is >= 0.",
        "Return None when the weights total zero.",
        "The variance is under the distribution: Var = E[X^2] - E[X]^2.",
        "Round the probabilities, mean and variance to 6 decimal places.",
        "Standard library only -- no numpy, no torch.",
      ],
      hints: [],
      params: ["weights"],
    },
  },
  {
    questionSlug: "ulp-and-absorption",
    problem: {
      id: "iq-ulp-and-absorption",
      title: "Find the spacing at a value and the update it swallows",
      summary:
        "For a binary float format with `mant_bits` mantissa bits, return the binary exponent of `x`, the exponent of the spacing between representable values at `x`, and whether `x + delta` leaves `x` unchanged.",
      entry: "precision_probe",
      difficulty: "medium",
      categories: ["ML", "DL"],
      allowedImports: ["math"],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      // Exponents, not the spacings themselves. The spacings are exact powers of two spanning 2^0
      // to 2^-52, so returning them as floats would make the answer key a formatting question
      // instead of an arithmetic one.
      normalise: "[int(_r[0]), int(_r[1]), bool(_r[2])]",
      cases: [
        { id: "iq-ulp-and-absorption-unit", label: "At 1.0", visible: true, args: [10, 1.0, 0.001] },
        {
          id: "iq-ulp-and-absorption-below-one",
          label: "Below 1.0",
          visible: true,
          args: [10, 0.5, 0.0001],
        },
        // The case the item exists for: same format, same delta, a thousand-fold wider spacing.
        {
          id: "iq-ulp-and-absorption-large-x",
          label: "Far up the number line",
          visible: false,
          args: [10, 1024.0, 0.001],
        },
        {
          id: "iq-ulp-and-absorption-exactly-half-ulp",
          label: "Exactly half the spacing",
          visible: false,
          args: [10, 1.0, 0.00048828125],
        },
        {
          id: "iq-ulp-and-absorption-power-of-two",
          label: "On a binade boundary",
          visible: false,
          args: [23, 2.0, 1e-7],
        },
        {
          id: "iq-ulp-and-absorption-double",
          label: "Double precision",
          visible: false,
          args: [52, 1.0, 1e-17],
        },
      ],
      reference: `
import math

def precision_probe(mant_bits, x, delta):
    exponent = math.floor(math.log2(x))
    ulp = 2.0 ** (exponent - mant_bits)
    return [exponent, exponent - mant_bits, delta < ulp / 2.0]
`,
      template: `
import math

def precision_probe(mant_bits, x, delta):
    """
    :type mant_bits: int    -- mantissa bits, e.g. 10 for fp16, 23 for fp32
    :type x: float          -- strictly positive
    :type delta: float      -- the amount being added to x
    :rtype: List  -- [exponent_of_x, exponent_of_spacing, delta_is_lost]
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-ulp-and-absorption`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would
     * notice the reference's output changing. Every value was checked against the arithmetic in
     * the statement's examples by hand before being recorded — the derivation says what the code
     * does, not that the code is right.
     */
    derivedKey: [
      "[0, -10, False]",
      "[-1, -11, True]",
      "[10, 0, True]",
      "[0, -10, False]",
      "[1, -22, True]",
      "[0, -52, True]",
    ],
    statement: {
      orderIndex: 40,
      description:
        "A binary float keeps `mant_bits` bits of mantissa, so representable values are evenly spaced only *within* a binade — the interval between one power of two and the next. Return `[exponent, ulp_exponent, lost]`:\n\n- `exponent` — `floor(log2(x))`, which binade `x` sits in.\n- `ulp_exponent` — `exponent - mant_bits`. The spacing at `x` is `2 ** ulp_exponent`; you return the exponent rather than the value.\n- `lost` — `True` when `delta < ulp / 2`, so round-to-nearest returns `x` unchanged.\n\n**The spacing is not a property of the format alone.** It doubles every time `x` does, so an update that is comfortably representable near 1 can be swallowed whole further up the number line. In fp16 the spacing at 1.0 is about 0.001 and at 1024 it is exactly 1.0.\n\nCompare against half the spacing, not the whole of it: round-to-nearest keeps `x` only when `delta` falls short of the midpoint between `x` and its neighbour.\n\n`x` is strictly positive, so there is no zero or subnormal case to handle.\n\nOnly `math` may be imported -- no numpy, no torch.",
      examples: [
        {
          input: "mant_bits = 10, x = 1.0, delta = 0.001",
          output: "[0, -10, False]",
          explanation:
            "x is in the binade starting at 2^0, so the spacing is 2^(0-10) = 0.0009765625 and half of it is about 0.000488. delta is larger than that, so the addition survives.",
        },
        {
          input: "mant_bits = 10, x = 0.5, delta = 0.0001",
          output: "[-1, -11, True]",
          explanation:
            "Below 1.0 the exponent is -1, so the spacing halves to 2^-11 and half of it is about 0.000244. delta falls short, so x does not move — the same format, a finer grid, and a smaller update still lost.",
        },
      ],
      constraints: [
        "1 <= mant_bits <= 52",
        "x > 0",
        "delta >= 0",
        "The spacing at x is 2 ** (floor(log2(x)) - mant_bits).",
        "delta is lost when it is strictly less than half the spacing.",
        "Only `math` may be imported -- no numpy, no torch.",
      ],
      hints: [],
      params: ["mant_bits", "x", "delta"],
    },
  },
  {
    questionSlug: "matmul-chain-order",
    problem: {
      id: "iq-matmul-chain-order",
      title: "Choose the multiplication order for a three-matrix product",
      summary:
        "For `Q (n x d)`, `K^T (d x n)` and `V (n x m)`, return the multiply-accumulate count for each bracketing and which one is cheaper.",
      entry: "chain_flops",
      difficulty: "medium",
      categories: ["ML", "DL", "LLM"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), int(_r[1]), str(_r[2])]",
      cases: [
        {
          id: "iq-matmul-chain-order-long-sequence",
          label: "Long sequence",
          visible: true,
          args: [1024, 64, 64],
        },
        { id: "iq-matmul-chain-order-square", label: "All equal", visible: true, args: [4, 4, 4] },
        // The case the item exists for: the order that is linear in n is five hundred times worse.
        {
          id: "iq-matmul-chain-order-wide-model",
          label: "Short sequence, wide model",
          visible: false,
          args: [8, 4096, 4096],
        },
        {
          id: "iq-matmul-chain-order-decode",
          label: "Single query",
          visible: false,
          args: [1, 512, 512],
        },
        {
          id: "iq-matmul-chain-order-crossover",
          label: "Exactly even",
          visible: false,
          args: [3, 2, 6],
        },
        {
          id: "iq-matmul-chain-order-thin-output",
          label: "Thin output",
          visible: false,
          args: [2048, 128, 1],
        },
      ],
      reference: `
def chain_flops(n, d, m):
    left = n * d * n + n * n * m
    right = d * n * m + n * d * m
    if left < right:
        cheaper = "left"
    elif right < left:
        cheaper = "right"
    else:
        cheaper = "equal"
    return [left, right, cheaper]
`,
      template: `
def chain_flops(n, d, m):
    """
    :type n: int  -- rows of Q, columns of K^T, rows of V
    :type d: int  -- columns of Q, rows of K^T
    :type m: int  -- columns of V
    :rtype: List  -- [left_flops, right_flops, "left" | "right" | "equal"]
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-matmul-chain-order`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would
     * notice the reference's output changing. Every value was checked against the arithmetic in
     * the statement's examples by hand before being recorded — the derivation says what the code
     * does, not that the code is right.
     */
    derivedKey: [
      "[134217728, 8388608, 'right']",
      "[128, 128, 'equal']",
      "[524288, 268435456, 'left']",
      "[1024, 524288, 'left']",
      "[72, 72, 'equal']",
      "[541065216, 524288, 'right']",
    ],
    statement: {
      orderIndex: 41,
      description:
        "Three matrices, shaped as attention shapes them: `Q` is `n x d`, `K^T` is `d x n`, and `V` is `n x m`. An `(a x b)` by `(b x c)` product costs `a*b*c` multiply-accumulates.\n\nReturn `[left, right, cheaper]`:\n\n- `left` — the cost of `(Q K^T) V`, which is `n*d*n + n*n*m`.\n- `right` — the cost of `Q (K^T V)`, which is `d*n*m + n*d*m`.\n- `cheaper` — `\"left\"`, `\"right\"`, or `\"equal\"`.\n\n**Both bracketings produce the same matrix.** Matrix multiplication is associative, so this is not a trade between speed and accuracy — it is the same answer at two different prices.\n\n**Neither order always wins.** The left bracketing builds the `n x n` score matrix and is quadratic in sequence length; the right never builds it and is linear in `n`. That makes the right cheaper for long sequences and much worse for short ones against a wide model, which is exactly the shape of a single decode step against a long cache.\n\nCount both matmuls in each bracketing. Report `\"equal\"` on an exact tie.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        {
          input: "n = 1024, d = 64, m = 64",
          output: "[134217728, 8388608, 'right']",
          explanation:
            "Left forms the 1024 x 1024 score matrix: 1024*64*1024 + 1024*1024*64. Right never does: 64*1024*64 + 1024*64*64. Sixteen times cheaper, and this is the regime linear attention is named for.",
        },
        {
          input: "n = 4, d = 4, m = 4",
          output: "[128, 128, 'equal']",
          explanation:
            "With all three dimensions equal, n^2(d+m) = 2ndm, so the two orders cost the same. Any test built only from square matrices cannot tell them apart.",
        },
      ],
      constraints: [
        "1 <= n, d, m <= 2^16",
        "Count both matmuls in each bracketing.",
        "left = n*d*n + n*n*m, right = d*n*m + n*d*m.",
        "Return \"equal\" on an exact tie.",
        "Standard library only -- no numpy, no torch.",
      ],
      hints: [],
      params: ["n", "d", "m"],
    },
  },
  {
    questionSlug: "reverse-mode-fan-out",
    problem: {
      id: "iq-reverse-mode-fan-out",
      title: "Accumulate a gradient through a value used twice",
      summary:
        "For `a = x + y`, `b = x - y` and `f = a * b`, return `f` and the partials `df/dx`, `df/dy`, `df/da`, `df/db` by reverse-mode accumulation over the graph.",
      entry: "backward",
      difficulty: "medium",
      categories: ["DL"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(v), 6) for v in _r]",
      cases: [
        { id: "iq-reverse-mode-fan-out-unit", label: "Both positive", visible: true, args: [3.0, 1.0] },
        { id: "iq-reverse-mode-fan-out-zero-y", label: "y is zero", visible: true, args: [5.0, 0.0] },
        // The case the item exists for: the two paths into x carry different values, so overwriting
        // instead of accumulating is visible. When x == y or y == 0 it is not.
        {
          id: "iq-reverse-mode-fan-out-fan-out",
          label: "Both paths carry weight",
          visible: false,
          args: [2.0, 7.0],
        },
        { id: "iq-reverse-mode-fan-out-equal", label: "x equals y", visible: false, args: [4.0, 4.0] },
        {
          id: "iq-reverse-mode-fan-out-negative",
          label: "Negative x",
          visible: false,
          args: [-3.0, 2.0],
        },
        { id: "iq-reverse-mode-fan-out-origin", label: "Both zero", visible: false, args: [0.0, 0.0] },
      ],
      reference: `
def backward(x, y):
    # Forward, keeping what the backward pass needs.
    a = x + y
    b = x - y
    f = a * b

    # Reverse, seeded with df/df = 1.
    grad = {"x": 0.0, "y": 0.0, "a": 0.0, "b": 0.0}

    # f = a * b
    grad["a"] += b * 1.0
    grad["b"] += a * 1.0

    # a = x + y
    grad["x"] += grad["a"] * 1.0
    grad["y"] += grad["a"] * 1.0

    # b = x - y
    grad["x"] += grad["b"] * 1.0
    grad["y"] += grad["b"] * -1.0

    return [f, grad["x"], grad["y"], grad["a"], grad["b"]]
`,
      template: `
def backward(x, y):
    """
    :type x: float
    :type y: float
    :rtype: List  -- [f, df_dx, df_dy, df_da, df_db]
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-reverse-mode-fan-out`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would
     * notice the reference's output changing. Every value was checked against the arithmetic in
     * the statement's examples by hand before being recorded — the derivation says what the code
     * does, not that the code is right.
     */
    derivedKey: [
      "[8.0, 6.0, -2.0, 2.0, 4.0]",
      "[25.0, 10.0, 0.0, 5.0, 5.0]",
      "[-45.0, 4.0, -14.0, -5.0, 9.0]",
      "[0.0, 8.0, -8.0, 0.0, 8.0]",
      "[5.0, -6.0, -4.0, -5.0, -1.0]",
      "[0.0, 0.0, 0.0, 0.0, 0.0]",
    ],
    statement: {
      orderIndex: 42,
      description:
        "Given `a = x + y`, `b = x - y` and `f = a * b`, return `[f, df_dx, df_dy, df_da, df_db]`.\n\nDo it as reverse mode over the graph, not by differentiating the closed form. Seed `df/df = 1` and walk backwards:\n\n- `f = a * b` gives `df/da = b` and `df/db = a`.\n- `a = x + y` sends `df/da` to both `x` and `y`.\n- `b = x - y` sends `df/db` to `x`, and `-df/db` to `y`.\n\n**`x` reaches `f` by two paths, and contributions to the same node add.** Assigning instead of accumulating keeps whichever path was visited last, which has the right shape and often the right sign — so it looks plausible and is wrong.\n\nThe closed form is the check, not the method: `f = x^2 - y^2`, so `df/dx = 2x` and `df/dy = -2y`. Notice that when `x == y` or `y == 0` one of the two contributions is zero, and overwriting gives the right answer by accident — which is why those cases cannot detect the mistake.\n\nRound every returned value to 6 decimal places.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        {
          input: "x = 3.0, y = 1.0",
          output: "[8.0, 6.0, -2.0, 2.0, 4.0]",
          explanation:
            "a = 4, b = 2, f = 8. df/da = b = 2 and df/db = a = 4. Then df/dx = 2 + 4 = 6, which is 2x, and df/dy = 2 - 4 = -2, which is -2y.",
        },
        {
          input: "x = 5.0, y = 0.0",
          output: "[25.0, 10.0, 0.0, 5.0, 5.0]",
          explanation:
            "a = b = 5, so both paths into x carry the same value and df/dx = 10 = 2x. df/dy = 5 - 5 = 0. With y at zero the two contributions cancel exactly, so this case cannot distinguish accumulating from overwriting.",
        },
      ],
      constraints: [
        "-1e6 <= x, y <= 1e6",
        "Accumulate at a fan-out; do not assign.",
        "Return the intermediate partials df/da and df/db as well.",
        "Round every returned value to 6 decimal places.",
        "Standard library only -- no numpy, no torch.",
      ],
      hints: [],
      params: ["x", "y"],
    },
  },
  {
    questionSlug: "int8-scale-and-zero-point",
    problem: {
      id: "iq-int8-scale-and-zero-point",
      title: "Quantize a tensor two ways and compare the error",
      summary:
        "Return the scale, the zero point, and the largest absolute error after quantizing `values` to `bits` and dequantizing again, symmetrically or asymmetrically.",
      entry: "quantize",
      difficulty: "hard",
      categories: ["LLM", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[round(float(_r[0]), 9), int(_r[1]), round(float(_r[2]), 9)]",
      cases: [
        {
          id: "iq-int8-scale-and-zero-point-signed-symmetric",
          label: "Signed data, symmetric",
          visible: true,
          args: [[-1.0, 0.3, 0.7], 8, true],
        },
        {
          id: "iq-int8-scale-and-zero-point-positive-asymmetric",
          label: "Positive data, asymmetric",
          visible: true,
          args: [[0.0, 2.0, 5.0, 10.0], 8, false],
        },
        // The case the item exists for: min is well below zero, so a zero point of 0 clamps every
        // negative value to code 0 and the error explodes.
        {
          id: "iq-int8-scale-and-zero-point-spans-zero",
          label: "Range spans zero, asymmetric",
          visible: false,
          args: [[-3.0, -0.5, 1.0, 4.0], 8, false],
        },
        {
          id: "iq-int8-scale-and-zero-point-positive-symmetric",
          label: "Positive data, symmetric",
          visible: false,
          args: [[0.0, 2.0, 5.0, 10.0], 8, true],
        },
        {
          id: "iq-int8-scale-and-zero-point-four-bit",
          label: "Four bits",
          visible: false,
          args: [[-1.0, -0.2, 0.4, 1.0], 4, true],
        },
        {
          id: "iq-int8-scale-and-zero-point-constant",
          label: "No range at all",
          visible: false,
          args: [[2.5, 2.5, 2.5], 8, false],
        },
      ],
      reference: `
def quantize(values, bits, symmetric):
    lo = min(values)
    hi = max(values)

    if symmetric:
        qmax = 2 ** (bits - 1) - 1
        qmin = -qmax
        span = max(abs(lo), abs(hi))
        scale = span / qmax if span > 0 else 1.0
        zero_point = 0
    else:
        qmax = 2 ** bits - 1
        qmin = 0
        # The range is widened to include zero, so zero lands exactly on a code. Without this a
        # constant tensor gets a zero point outside the unsigned range and cannot be represented.
        lo = min(lo, 0.0)
        hi = max(hi, 0.0)
        span = hi - lo
        scale = span / qmax if span > 0 else 1.0
        zero_point = int(round(-lo / scale))

    worst = 0.0
    for v in values:
        code = int(round(v / scale)) + zero_point
        if code < qmin:
            code = qmin
        elif code > qmax:
            code = qmax
        back = (code - zero_point) * scale
        error = abs(back - v)
        if error > worst:
            worst = error

    return [scale, zero_point, worst]
`,
      template: `
def quantize(values, bits, symmetric):
    """
    :type values: List[float]
    :type bits: int
    :type symmetric: bool
    :rtype: List  -- [scale, zero_point, max_abs_error]
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-int8-scale-and-zero-point`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would
     * notice the reference's output changing. Every value was checked against the arithmetic in
     * the statement's examples by hand before being recorded — the derivation says what the code
     * does, not that the code is right.
     */
    derivedKey: [
      "[0.00787402, 0, 0.0007874]",
      "[0.03921569, 0, 0.01960784]",
      "[0.02745098, 109, 0.01176471]",
      "[0.07874016, 0, 0.03937008]",
      "[0.14285714, 0, 0.05714286]",
      "[0.00980392, 0, 0.0]",
    ],
    statement: {
      orderIndex: 43,
      description:
        "Quantize `values` onto an integer grid of `bits` bits, dequantize, and report the worst absolute error. Return `[scale, zero_point, max_abs_error]`.\\n\\n**Symmetric** centres the grid on zero:\\n\\n```\\nqmax = 2**(bits-1) - 1,  qmin = -qmax\\nscale = max(abs(min), abs(max)) / qmax\\nzero_point = 0\\n```\\n\\n**Asymmetric** shifts the grid to fit the data:\\n\\n```\\nqmax = 2**bits - 1,  qmin = 0\\nmin = min(min, 0),  max = max(max, 0)\\nscale = (max - min) / qmax\\nzero_point = round(-min / scale)\\n```\\n\\nIn both cases the code is `clamp(round(v / scale) + zero_point, qmin, qmax)` and the dequantized value is `(code - zero_point) * scale`.\\n\\n**The zero point is what lets the grid cover data that does not straddle zero.** Quantizing `[0, 10]` symmetrically fixes the grid over `[-10, 10]` and never uses half of it — 8 bits of storage delivering 7 bits of resolution, and double the error for nothing. Leaving `zero_point` at 0 on asymmetric data is worse still: every value below zero clamps to code 0.\\n\\n**The asymmetric range is widened to reach zero.** Real frameworks do this so that zero lands exactly on a code, which matters for padding and for anything that has been through a ReLU. It is also what makes a constant tensor representable: without it, `[2.5, 2.5, 2.5]` gives a zero point of -2 — outside the unsigned range — and an error of 0.5 on a tensor with one distinct value.\\n\\n**A tensor of all zeros still has no range.** Any scale describes it, so use `1.0` rather than dividing by zero.\\n\\nRound the scale and the error to 9 decimal places; the zero point is an integer.\\n\\nStandard library only -- no numpy, no torch.",
      examples: [
        {
          input: "values = [-1.0, 0.3, 0.7], bits = 8, symmetric = True",
          output: "[0.007874016, 0, 0.000787402]",
          explanation:
            "max|v| is 1.0 and qmax is 127, so the scale is 1/127. The data straddles zero, so the grid is well spent and the worst error is under half a step.",
        },
        {
          input: "values = [0.0, 2.0, 5.0, 10.0], bits = 8, symmetric = False",
          output: "[0.039215686, 0, 0.009803922]",
          explanation:
            "The range is 10 over 255 codes, so the step is half what symmetric would give — min is already 0 so the zero point is 0, and the whole grid covers the data instead of half of it.",
        },
      ],
      constraints: [
        "1 <= len(values) <= 4096",
        "2 <= bits <= 16",
        "Widen the asymmetric range to include zero before computing the scale.",
        "Use scale 1.0 when the range is still zero after widening.",
        "Clamp codes into [qmin, qmax] before dequantizing.",
        "Round the scale and error to 9 decimal places.",
        "Standard library only -- no numpy, no torch.",
      ],
      hints: [],
      params: ["values", "bits", "symmetric"],
    },
  },
  {
    questionSlug: "fusion-memory-traffic",
    problem: {
      id: "iq-fusion-memory-traffic",
      title: "Count the traffic an elementwise chain pays unfused",
      summary:
        "For a chain of `n_ops` elementwise operations over `n` elements, return the bytes moved unfused, the bytes moved fused, and the arithmetic intensity of each.",
      entry: "fusion_traffic",
      difficulty: "medium",
      categories: ["CUDA", "PyTorch"],
      allowedImports: [],
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      normalise: "[int(_r[0]), int(_r[1]), round(float(_r[2]), 9), round(float(_r[3]), 9)]",
      cases: [
        {
          id: "iq-fusion-memory-traffic-two-op",
          label: "Two operations, fp32",
          visible: true,
          args: [1000000, 4, 2],
        },
        {
          id: "iq-fusion-memory-traffic-single-op",
          label: "Nothing to fuse",
          visible: true,
          args: [1000000, 4, 1],
        },
        // The case the item exists for: the unfused intensity is the same as it was at two
        // operations, and at one. Adding arithmetic to an unfused chain buys none of it.
        {
          id: "iq-fusion-memory-traffic-long-chain",
          label: "Eight operations",
          visible: false,
          args: [1000000, 4, 8],
        },
        {
          id: "iq-fusion-memory-traffic-half-precision",
          label: "fp16",
          visible: false,
          args: [1000000, 2, 4],
        },
        {
          id: "iq-fusion-memory-traffic-wide-dtype",
          label: "fp64",
          visible: false,
          args: [100000, 8, 5],
        },
        {
          id: "iq-fusion-memory-traffic-tiny",
          label: "One element",
          visible: false,
          args: [1, 4, 3],
        },
      ],
      reference: `
def fusion_traffic(n, dtype_bytes, n_ops):
    unfused = 2 * n_ops * n * dtype_bytes
    fused = 2 * n * dtype_bytes
    flops = n_ops * n
    return [unfused, fused, flops / unfused, flops / fused]
`,
      template: `
def fusion_traffic(n, dtype_bytes, n_ops):
    """
    :type n: int            -- elements in the tensor
    :type dtype_bytes: int  -- bytes per element
    :type n_ops: int        -- operations in the chain
    :rtype: List  -- [unfused_bytes, fused_bytes, ai_unfused, ai_fused]
    """
`,
    },
    /**
     * Derived by `VOIDCODE_DERIVE=iq-fusion-memory-traffic`, never typed.
     *
     * The frozen answer key does not cover this item, so this is the only thing that would
     * notice the reference's output changing. Every value was checked against the arithmetic in
     * the statement's examples by hand before being recorded — the derivation says what the code
     * does, not that the code is right.
     */
    derivedKey: [
      "[16000000, 8000000, 0.125, 0.25]",
      "[8000000, 8000000, 0.125, 0.125]",
      "[64000000, 8000000, 0.125, 1.0]",
      "[16000000, 4000000, 0.25, 1.0]",
      "[8000000, 1600000, 0.0625, 0.3125]",
      "[24, 8, 0.125, 0.375]",
    ],
    statement: {
      orderIndex: 44,
      description:
        "A chain of `n_ops` elementwise operations runs over `n` elements of `dtype_bytes` each. Count one flop per element per operation.\n\nReturn `[unfused_bytes, fused_bytes, ai_unfused, ai_fused]`:\n\n- `unfused_bytes` — each operation is its own kernel, reading its input and writing its output: `2 * n_ops * n * dtype_bytes`.\n- `fused_bytes` — one kernel reads the input once and writes the result once, whatever the chain length: `2 * n * dtype_bytes`.\n- `ai_unfused`, `ai_fused` — arithmetic intensity, flops divided by bytes moved.\n\n**Watch what happens to `ai_unfused` as `n_ops` grows.** Adding an operation to an unfused chain adds flops and adds exactly proportional traffic, so the ratio does not move — every kernel is separately memory-bound and stays that way. The intuition that more arithmetic makes a workload compute-bound is wrong here for a structural reason, not a tuning one.\n\nFusion is what turns chain length into intensity: the traffic stops scaling with `n_ops` while the flops keep going, so the kernel moves up the roofline. The speedup is bounded by `n_ops`, and at `n_ops = 1` there is nothing to fuse and the two are identical.\n\nRound both intensities to 9 decimal places; the byte counts are integers.\n\nStandard library only -- no numpy, no torch.",
      examples: [
        {
          input: "n = 1000000, dtype_bytes = 4, n_ops = 2",
          output: "[16000000, 8000000, 0.125, 0.25]",
          explanation:
            "Two kernels move 2 * 2 * 1e6 * 4 bytes; fused moves 2 * 1e6 * 4. The flops are the same either way, so fusing halves the traffic and doubles the intensity.",
        },
        {
          input: "n = 1000000, dtype_bytes = 4, n_ops = 1",
          output: "[8000000, 8000000, 0.125, 0.125]",
          explanation:
            "One operation is already one kernel, so there is nothing to fuse and both columns agree. Note the unfused intensity is 0.125 here and also 0.125 in the two-operation case — that is the point.",
        },
      ],
      constraints: [
        "1 <= n <= 10^9",
        "1 <= dtype_bytes <= 8",
        "1 <= n_ops <= 64",
        "One flop per element per operation.",
        "Round both intensities to 9 decimal places.",
        "Standard library only -- no numpy, no torch.",
      ],
      hints: [],
      params: ["n", "dtype_bytes", "n_ops"],
    },
  },
];
