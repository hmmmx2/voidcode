"""pass@k and confidence intervals — pure functions, no torch, no model loading.

WHY THIS IS IN `rl/` AND NOT IN `scripts/rl_eval.py`
---------------------------------------------------
There are two `scripts` packages in this repo: the root `scripts/` and `apps/api/scripts/`.
`pytest.ini` puts `apps/api` on the path, so `scripts.seed_problems` resolves to the api one — and
whichever `scripts` package is imported FIRST in a session wins for the whole session. A test that
imported `scripts.rl_eval` therefore broke `tests/test_seeders_use_loader.py` three tests later
with `ModuleNotFoundError: No module named 'scripts.seed_problems'`, purely through import order.

Keeping the estimators here sidesteps the collision entirely, and is better structure anyway: the
arithmetic is generic and testable on CPU, while `scripts/rl_eval.py` stays a thin CLI that loads
models. Nothing here imports torch, so the tests stay fast.
"""
from __future__ import annotations

import math
import random


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval, for a genuine binomial: k successes out of n independent trials.

    Use for the GREEDY arm (one deterministic sample per problem). Do NOT use it for the sampled
    estimator, which is a mean of per-problem rates rather than a binomial.
    """
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    # A Wilson interval always contains the point estimate: at k=0 the lower bound is exactly 0 and
    # at k=n the upper bound is exactly 1. In floating point the k=n case lands on
    # 0.9999999999999999, an interval excluding its own estimate. Clamping against p restores the
    # invariant and moves the bounds by at most a few ULP.
    return (max(0.0, min(centre - half, p)), min(1.0, max(centre + half, p)))


def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased pass@k for one problem: 1 - C(n-c, k) / C(n, k)  (Chen et al. 2021).

    NOT `any(correct)` and NOT `c/n >= 1`. Both are biased upward for k < n, which is precisely why
    an aggregate "solved_any" counter cannot be reinterpreted as pass@1 after the fact — at 1
    success in 8 samples `any(correct)` reads 1.0 where pass@1 is 0.125.
    """
    if n - c < k:
        return 1.0
    return 1.0 - math.comb(n - c, k) / math.comb(n, k)


def bootstrap_ci(values: list[float], iters: int = 10000, seed: int = 0,
                 alpha: float = 0.05) -> tuple[float, float]:
    """Percentile bootstrap over PROBLEMS.

    The sampled pass@1 estimator is a mean of per-problem rates, not a binomial, so Wilson does not
    apply and would understate the width. Uses `random` rather than torch so this module stays
    importable without a GPU stack.
    """
    if not values:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(values)
    means = []
    for _ in range(iters):
        means.append(sum(values[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return (means[int(alpha / 2 * iters)], means[int((1 - alpha / 2) * iters)])
