/**
 * The gate every interview problem authored from now on must pass.
 *
 * The 38 problems that arrived from the port are covered by the frozen answer key in
 * `interview-answer-key.ts` — an oracle produced by a different interpreter, which is a real check
 * and not one worth throwing away. What they are *not* covered by is a proof that a wrong answer
 * fails, and backfilling that means first discovering which of their 126 hidden cases are vacuous.
 * That is weeks of remediation which unblocks nothing, so `verify-vacuity.ts` covers them cheaply
 * and more weakly instead, and this table holds only post-freeze items.
 *
 * `verify-interviews.ts` requires an entry here for any item the frozen key does not cover. So an
 * item cannot ship without one, which is the point: the standard applies from item #1 rather than
 * as a promise to tidy up later.
 *
 * ## Writing one
 *
 * `correct` is a solution written *independently* of the reference — a second implementation, not a
 * paraphrase. Its value is that two implementations agreeing is evidence the reference is right,
 * which the answer key never was: the key came from the same source code as the reference.
 *
 * `mutants` is `[label, source, caseId]`. The case id is the expensive part and the reason this
 * works: naming it forces you to say which case catches the trap, which forces a case to exist that
 * was designed for it. `top-p-sampling` in `verify-curriculum.ts` has an `unsorted` case that exists
 * for no other reason, and `batchnorm-inference`'s mutant note — "LayerNorm's axis… this is the
 * confusion the problem exists to settle" — is that item's whole reason for existing.
 *
 * Budget 20–40 minutes per item, and note that almost none of it is typing. If you cannot name the
 * misconception the item corrects, the item does not yet know what it is for.
 *
 * **Trap-named case ids for new items.** `skewed`, `all-zero`, `point-mass` — not `Hidden 2`. The
 * legacy 38 keep their positional ids because `WEB_ANSWER_KEY` is keyed by them and renaming would
 * invalidate the one oracle worth keeping. That asymmetry is deliberate; do not tidy it.
 */
import type { Spec } from "./verify-spec.js";

export const INTERVIEW_SPECS: Record<string, Spec> = {
  "iq-weighted-distribution-moments": {
    /**
     * Written from the definitions rather than from the reference: one accumulating pass instead of
     * three comprehensions, and `1 - sum(rest)` nowhere near it. Two independent implementations
     * agreeing is the evidence the answer key used to provide and never could — the key came from
     * the same source as the reference.
     */
    correct: `
def dist_moments(weights):
    total = 0.0
    for w in weights:
        total += w
    if not total > 0:
        return None

    probs = []
    m1 = 0.0
    m2 = 0.0
    for i in range(len(weights)):
        p = weights[i] / total
        probs.append(p)
        m1 += i * p
        m2 += (i ** 2) * p

    return [probs, m1, m2 - m1 ** 2]
`,
    mutants: [
      [
        /**
         * The misconception the item exists to correct: variance taken over the outcome *values*
         * rather than under the distribution. It is the mean of squared deviations with every
         * outcome weighted 1/n, which is a real quantity answering a different question.
         *
         * It agrees with the truth exactly when the distribution is uniform — so the visible uniform
         * case passes it, and so would any test suite built only from tidy inputs. `skewed` is the
         * case authored to separate them: 1.25 against a true 0.1364.
         */
        "unweighted spread of the outcome values",
        `
def dist_moments(weights):
    total = sum(weights)
    if total <= 0:
        return None

    probs = [w / total for w in weights]
    mean = sum(i * p for i, p in enumerate(probs))

    n = len(weights)
    centre = sum(range(n)) / n
    variance = sum((i - centre) ** 2 for i in range(n)) / n
    return [probs, mean, variance]
`,
        "iq-weighted-distribution-moments-skewed",
      ],
    ],
  },
  "iq-ulp-and-absorption": {
    // Derived from the exponent by repeated halving rather than by calling log2, so the two
    // implementations do not share the one library call the answer turns on.
    correct: `
def precision_probe(mant_bits, x, delta):
    exponent = 0
    v = x
    while v >= 2.0:
        v /= 2.0
        exponent += 1
    while v < 1.0:
        v *= 2.0
        exponent -= 1

    ulp_exponent = exponent - mant_bits
    half = 2.0 ** (ulp_exponent - 1)
    return [exponent, ulp_exponent, delta < half]
`,
    mutants: [
      [
        /**
         * Machine epsilon treated as an absolute threshold. It is the textbook definition — the
         * spacing at 1.0 — applied everywhere, which is right at 1.0 and wrong by a factor of 2^e
         * anywhere else.
         *
         * Passes both visible cases: `unit` sits at exponent 0 where the two agree, and `below-one`
         * is off by only one binade so the verdict happens to match. `large-x` is the case authored
         * to separate them, where the true spacing is 1.0 and this claims 0.0009765625.
         */
        "machine epsilon as an absolute threshold",
        `
import math

def precision_probe(mant_bits, x, delta):
    exponent = math.floor(math.log2(x))
    ulp = 2.0 ** (-mant_bits)
    return [exponent, -mant_bits, delta < ulp / 2.0]
`,
        "iq-ulp-and-absorption-large-x",
      ],
    ],
  },
  "iq-matmul-chain-order": {
    correct: `
def chain_flops(n, d, m):
    def cost(a, b, c):
        return a * b * c

    left = cost(n, d, n) + cost(n, n, m)
    right = cost(d, n, m) + cost(n, d, m)

    order = sorted([(left, "left"), (right, "right")])
    if order[0][0] == order[1][0]:
        return [left, right, "equal"]
    return [left, right, order[0][1]]
`,
    mutants: [
      [
        /**
         * "Linear attention is always cheaper." The flop counts are right; the conclusion is a
         * remembered result applied without checking the shapes.
         *
         * Survives the long-sequence case, which is the regime the result comes from, and the
         * all-equal case only because that one is a tie — so a suite of square matrices and long
         * sequences would never catch it. `wide-model` is the shape where the left order is five
         * hundred times better, and it is the shape of a decode step against a long cache.
         */
        "the reassociated order is always cheaper",
        `
def chain_flops(n, d, m):
    left = n * d * n + n * n * m
    right = d * n * m + n * d * m
    return [left, right, "right"]
`,
        "iq-matmul-chain-order-wide-model",
      ],
    ],
  },
  "iq-reverse-mode-fan-out": {
    // Accumulated over an explicit edge list, so the fan-out is data rather than two lines that
    // happen to both touch x. A different shape of implementation reaching the same numbers.
    correct: `
def backward(x, y):
    a = x + y
    b = x - y
    f = a * b

    grad = {"f": 1.0, "a": 0.0, "b": 0.0, "x": 0.0, "y": 0.0}

    # (consumer, producer, local derivative), in reverse topological order.
    edges = [
        ("f", "a", b),
        ("f", "b", a),
        ("a", "x", 1.0),
        ("a", "y", 1.0),
        ("b", "x", 1.0),
        ("b", "y", -1.0),
    ]
    for consumer, producer, local in edges:
        grad[producer] += grad[consumer] * local

    return [f, grad["x"], grad["y"], grad["a"], grad["b"]]
`,
    mutants: [
      [
        /**
         * Assignment where accumulation is needed. The second path into a node overwrites the first,
         * so `x` keeps only whichever contribution the implementation visited last.
         *
         * The result is silently plausible — right shape, often right sign — and it is *exactly*
         * right whenever one contribution is zero. Both visible cases are like that: `zero-y` makes
         * a and b equal, and any case with x == y cancels. `fan-out` is the case authored so the two
         * paths carry different values: 4 against the overwrite's 9.
         */
        "overwrite at the fan-out instead of accumulating",
        `
def backward(x, y):
    a = x + y
    b = x - y
    f = a * b

    grad = {"x": 0.0, "y": 0.0, "a": 0.0, "b": 0.0}
    grad["a"] = b
    grad["b"] = a

    grad["x"] = grad["a"]
    grad["y"] = grad["a"]
    grad["x"] = grad["b"]
    grad["y"] = -grad["b"]

    return [f, grad["x"], grad["y"], grad["a"], grad["b"]]
`,
        "iq-reverse-mode-fan-out-fan-out",
      ],
    ],
  },
  "iq-int8-scale-and-zero-point": {
    // Codes materialised into a list and the error taken with max(), rather than tracked in the
    // loop. Same arithmetic, different control flow.
    correct: `
def quantize(values, bits, symmetric):
    lo = min(values)
    hi = max(values)

    if symmetric:
        top = 2 ** (bits - 1) - 1
        bottom = -top
        extent = abs(lo) if abs(lo) > abs(hi) else abs(hi)
        zero_point = 0
    else:
        top = 2 ** bits - 1
        bottom = 0
        # Zero has to be representable, so the range is stretched to reach it.
        if lo > 0.0:
            lo = 0.0
        if hi < 0.0:
            hi = 0.0
        extent = hi - lo
        zero_point = None

    scale = extent / top if extent > 0 else 1.0
    if zero_point is None:
        zero_point = int(round(-lo / scale))

    codes = []
    for v in values:
        raw = int(round(v / scale)) + zero_point
        codes.append(min(top, max(bottom, raw)))

    errors = [abs((codes[i] - zero_point) * scale - values[i]) for i in range(len(values))]
    return [scale, zero_point, max(errors)]
`,
    mutants: [
      [
        /**
         * The asymmetric scale computed from the range, with the zero point left at 0.
         *
         * Half the work of asymmetric quantization, and it looks finished: the scale is right, the
         * codes are in range, and on data whose minimum is already zero it is *identical* to the
         * correct answer — which is both visible cases. `spans-zero` is the case authored to catch
         * it: every negative value clamps to code 0 and the worst error becomes the whole negative
         * extent rather than half a step.
         */
        "asymmetric scale with the zero point left at zero",
        `
def quantize(values, bits, symmetric):
    lo = min(values)
    hi = max(values)

    if symmetric:
        qmax = 2 ** (bits - 1) - 1
        qmin = -qmax
        span = max(abs(lo), abs(hi))
    else:
        qmax = 2 ** bits - 1
        qmin = 0
        lo = min(lo, 0.0)
        hi = max(hi, 0.0)
        span = hi - lo

    scale = span / qmax if span > 0 else 1.0
    zero_point = 0

    worst = 0.0
    for v in values:
        code = int(round(v / scale)) + zero_point
        if code < qmin:
            code = qmin
        elif code > qmax:
            code = qmax
        error = abs((code - zero_point) * scale - v)
        if error > worst:
            worst = error

    return [scale, zero_point, worst]
`,
        "iq-int8-scale-and-zero-point-spans-zero",
      ],
    ],
  },
  "iq-fusion-memory-traffic": {
    // Built from "how many arrays does each version touch", which is the way to see the result
    // rather than a rearrangement of the reference's expressions.
    correct: `
def fusion_traffic(n, dtype_bytes, n_ops):
    array_bytes = n * dtype_bytes

    arrays_unfused = 2 * n_ops   # each kernel touches its input and its output
    arrays_fused = 2             # one input, one output, whatever the chain length

    unfused = arrays_unfused * array_bytes
    fused = arrays_fused * array_bytes
    flops = n_ops * n

    return [unfused, fused, flops / unfused, flops / fused]
`,
    mutants: [
      [
        /**
         * The unfused intensity computed against the fused traffic, so it appears to rise with chain
         * length. This is the misconception the item exists to correct, written down: more
         * arithmetic must mean more compute-bound.
         *
         * It agrees with the truth at `n_ops = 1`, where there is nothing to fuse and the two
         * traffics are equal — which is one of the two visible cases. `long-chain` is where the
         * claim becomes 1.0 against a true 0.125, and the true figure is the same 0.125 it was at
         * one operation.
         */
        "unfused intensity rising with chain length",
        `
def fusion_traffic(n, dtype_bytes, n_ops):
    unfused = 2 * n_ops * n * dtype_bytes
    fused = 2 * n * dtype_bytes
    flops = n_ops * n
    return [unfused, fused, flops / fused, flops / fused]
`,
        "iq-fusion-memory-traffic-long-chain",
      ],
    ],
  },
};
